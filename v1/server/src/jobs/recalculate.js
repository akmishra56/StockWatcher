/**
 * "Recalculate All" (docs/component_design.md §6): replays every symbol's
 * full ohlcv_snapshots history through the indicator engine from a cold
 * start, using whatever indicator parameters are active *right now* --
 * this is what makes a Settings parameter change (e.g. RSI period 14 -> 21)
 * apply retroactively instead of only to future bars.
 *
 * Runs as a background job (recalculation over the full history of 500
 * symbols is not something a request should block on); progress is tracked
 * in an in-memory job map polled via GET /api/settings/recalculate/:jobId.
 *
 * Each symbol's cold-started replay ends with the same final indicator
 * state a live hydration would produce for that symbol's latest bar, so
 * both indicatorEngine.states (in-memory, for the next real-time cycle)
 * and indicator_state (on disk, for the next restart) are updated to that
 * final state -- not just the historical indicator_snapshots rows.
 *
 * Two speed/UX fixes (2026-09-09, after a live run over ~1M backfilled
 * bars took ~2 hours): (1) each symbol's whole history is written in one
 * batched multi-row INSERT (db.writeIndicatorRowsBatch) instead of one
 * individually-awaited INSERT per bar -- the per-statement round-trip
 * overhead, not the indicator math, was the actual bottleneck. (2)
 * snapshot_window (the Dashboard's read cache) is refreshed periodically
 * DURING the run, not only once at the very end, so a parameter change
 * starts showing up on the Dashboard within the first refresh interval
 * instead of only after the entire multi-hour replay finishes.
 */
import { createSymbolState, applyBar } from '../indicators/state.js';

/** @type {Map<string, { status: string, processed: number, total: number, error?: string }>} */
const jobs = new Map();
let runningJobId = null;

export function getJob(jobId) {
  return jobs.get(jobId);
}

export function isRecalculateRunning() {
  return runningJobId !== null;
}

// refreshSnapshotWindow() is one set-based rebuild over the whole table
// (not per-row), so it's cheap enough to call periodically without
// meaningfully slowing the job down -- 20 symbols is roughly every few
// seconds to a minute of a run's wall-clock time, frequent enough that the
// Dashboard visibly catches up well before the job completes.
const SNAPSHOT_REFRESH_EVERY_N_SYMBOLS = 20;

export function startRecalculateJob(jobId, { db, indicatorEngine }) {
  runningJobId = jobId;
  jobs.set(jobId, { status: 'running', processed: 0, total: 0 });
  runRecalculate(jobId, { db, indicatorEngine })
    .catch((err) => {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'failed', error: err.message });
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
    });
}

async function runRecalculate(jobId, { db, indicatorEngine }) {
  const symbols = await db.readDistinctSymbolsWithHistory();
  const total = await db.countOhlcvRows();
  jobs.set(jobId, { status: 'running', processed: 0, total });

  let processed = 0;
  let symbolsSinceRefresh = 0;
  for (const symbol of symbols) {
    const bars = await db.readOhlcvHistoryForSymbol(symbol);
    let symState = createSymbolState();
    const outputRows = [];

    for (const bar of bars) {
      const { state, output } = applyBar(symState, bar, indicatorEngine.params);
      symState = state;
      outputRows.push({ symbol, ts_ist: bar.ts_ist, ...output });
      processed++;
    }
    if (outputRows.length > 0) await db.writeIndicatorRowsBatch(outputRows);
    jobs.set(jobId, { status: 'running', processed, total });

    indicatorEngine.states.set(symbol, symState);
    const lastBar = bars[bars.length - 1];
    if (lastBar) await db.writeIndicatorState(symbol, symState, lastBar.actual_ts_ist);

    symbolsSinceRefresh++;
    if (symbolsSinceRefresh >= SNAPSHOT_REFRESH_EVERY_N_SYMBOLS) {
      await db.refreshSnapshotWindow();
      symbolsSinceRefresh = 0;
    }
  }

  // Without this, snapshot_window (schema.sql) would keep serving its
  // now-stale cached indicator values -- computed under the OLD parameters
  // -- until the next live tick happens to overwrite each symbol's row, up
  // to an hour away. Recalculate's whole point is a parameter change
  // applying immediately, so the Dashboard has to reflect it right now.
  // (Also covers the case where the loop above never hit a periodic
  // refresh at all, e.g. fewer than SNAPSHOT_REFRESH_EVERY_N_SYMBOLS symbols.)
  await db.refreshSnapshotWindow();

  jobs.set(jobId, { status: 'done', processed, total });
}
