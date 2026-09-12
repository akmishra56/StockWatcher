/**
 * snapshot_window (schema.sql) -- the bounded per-symbol cache that
 * replaced the full-table-scan behind latest_snapshot/readHistoryRows
 * (docs/researchOutput.md, 2026-09-09 load audit). Verifies: it syncs on
 * every ingested bar, prunes older rows beyond its per-symbol depth, stays
 * untouched by the Yahoo backfill (which bypasses the pipeline entirely),
 * and gets rebuilt with fresh values after Recalculate All.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

/** Minute-granularity, monotonically increasing IST timestamps starting 2026-09-09 10:00, rolling over hour/day boundaries correctly. */
function tsAtMinuteOffset(minutesOffset) {
  const totalMinutes = 10 * 60 + minutesOffset;
  const day = 9 + Math.floor(totalMinutes / (24 * 60));
  const hour = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minute = totalMinutes % 60;
  return `2026-09-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

test('snapshot_window syncs on ingest, prunes old rows, ignores backfill writes, and refreshes after recalculate', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-snapshotwindow-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { db, pipeline } = ctx;

    // A real ingest cycle through the pipeline -- should populate snapshot_window.
    const firstTs = tsAtMinuteOffset(0);
    await pipeline.runCycle(firstTs, [
      { symbol: 'INFY', ts_ist: firstTs, actual_ts_ist: firstTs, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
    ]);
    let windowRows = await db.readAll('SELECT * FROM snapshot_window WHERE symbol = ?', 'INFY');
    assert.equal(windowRows.length, 1, 'a real ingested bar should land in snapshot_window');
    assert.equal(windowRows[0].close, 100.5);

    // The Yahoo backfill path -- writeOhlcvRowIfAbsent directly, never through
    // the pipeline -- must NOT appear in snapshot_window.
    await db.writeOhlcvRowIfAbsent({
      symbol: 'INFY', ts_ist: '2024-01-01 09:15:00', actual_ts_ist: '2024-01-01 09:15:00',
      open: 50, high: 51, low: 49, close: 50.5, volume: 500, price_change: 0.5, price_change_pct: 1,
      is_manual_entry: false, source: 'yahoo-backfill',
    });
    windowRows = await db.readAll('SELECT * FROM snapshot_window WHERE symbol = ?', 'INFY');
    assert.equal(windowRows.length, 1, 'a backfill-only write must never appear in snapshot_window');

    // Push enough real bars through the pipeline to exceed the window's
    // per-symbol depth (60) and confirm pruning actually evicts the oldest.
    // 70 more distinct-minute bars on top of the first one = 71 total real
    // bars for INFY, comfortably past the 60-row cap.
    for (let m = 1; m <= 70; m++) {
      const tsIst = tsAtMinuteOffset(m);
      await pipeline.runCycle(tsIst, [
        { symbol: 'INFY', ts_ist: tsIst, actual_ts_ist: tsIst, open: 100, high: 101, low: 99, close: 101, volume: 1000 },
      ]);
    }
    windowRows = await db.readAll('SELECT COUNT(*) AS c FROM snapshot_window WHERE symbol = ?', 'INFY');
    assert.equal(Number(windowRows[0].c), 60, 'snapshot_window should prune back down to its configured per-symbol depth');

    // /api/snapshot (latest_snapshot -> snapshot_window) should reflect the newest bar.
    const snapRes = await app.inject({ method: 'GET', url: '/api/snapshot' });
    const snap = JSON.parse(snapRes.body);
    const infy = snap.rows.find((r) => r.symbol === 'INFY');
    assert.ok(infy);
    assert.equal(infy.close, 101);

    // Recalculate All should rebuild snapshot_window with fresh values even
    // though it never calls syncSnapshotWindowRow itself (it writes
    // indicator_snapshots directly via its own replay loop).
    const putRes = await app.inject({ method: 'PUT', url: '/api/settings', payload: { indicators: { rsi: { period: 3 } } } });
    assert.equal(putRes.statusCode, 200);
    const recalcRes = await app.inject({ method: 'POST', url: '/api/settings/recalculate' });
    const { jobId } = JSON.parse(recalcRes.body);
    let job;
    for (let i = 0; i < 60; i++) {
      job = JSON.parse((await app.inject({ method: 'GET', url: `/api/settings/recalculate/${jobId}` })).body);
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'done', JSON.stringify(job));

    const afterRecalc = await db.readAll('SELECT rsi FROM snapshot_window WHERE symbol = ? ORDER BY ts_ist DESC LIMIT 1', 'INFY');
    assert.ok(afterRecalc[0].rsi != null, 'RSI(3) needs only 4 closes to prime, so the refreshed window should show a real value, not null');
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
