/**
 * One-off historical backfill from Yahoo Finance's unofficial chart API --
 * fills `ohlcv_snapshots` with hourly candles for a date range this app
 * never itself ingested live (e.g. before this project existed). Runs as a
 * background job (same pattern as jobs/recalculate.js -- hundreds of
 * symbols, one HTTP request each, is not something a request should block
 * on), progress polled via GET /api/backfill/yahoo-history/:jobId.
 *
 * Deliberately writes via db.writeOhlcvRowIfAbsent (ON CONFLICT DO
 * NOTHING), never db.writeOhlcvRow -- this must only ever fill a gap where
 * no row exists yet, never overwrite a real live-scraped/broker row at the
 * same (symbol, ts_ist). Rows are tagged source='yahoo-backfill'
 * (schema.sql) so they're always identifiable later. Indicators are NOT
 * computed here -- run POST /api/settings/recalculate afterward (existing
 * machinery, jobs/recalculate.js) to replay indicator state over the newly
 * backfilled history; duplicating that logic here isn't worth it.
 */
import { istDateToUnixSeconds, roundToScheduledSlot, nowIst } from '../time.js';
import { computeSlots } from '../marketHours.js';
import { fetchYahooHourlyCandles } from '../datasource/yahooChart.js';

/** @type {Map<string, { status: string, processed: number, total: number, rowsInserted: number, errors: {symbol: string, reason: string}[] }>} */
const jobs = new Map();

// Yahoo's unofficial endpoint has no documented rate limit -- this is a
// deliberately conservative pace (not "as fast as possible") so a 500+
// symbol backfill doesn't look like abuse.
const REQUEST_DELAY_MS = 350;

export function getBackfillJob(jobId) {
  return jobs.get(jobId);
}

/**
 * @param {string} jobId
 * @param {{ db: import('../db/client.js').DbClient, symbols: string[], fromDate: string, toDate?: string }} opts
 *   fromDate/toDate are IST calendar dates, 'YYYY-MM-DD'. toDate defaults to
 *   TODAY -- per the user's 2026-09-09 instruction, Yahoo backfill only ever
 *   covers up through YESTERDAY's close; today and any future date is the
 *   live NSE scraper's job, never Yahoo's. Passing `istDateToUnixSeconds`
 *   today's own date gives the start of today (00:00 IST) as an exclusive
 *   upper bound, which already sits after yesterday's last real candle
 *   (~15:15-15:30) and before today's first (09:15) -- no separate
 *   "yesterday" date math needed. This also sidesteps Yahoo stamping an
 *   in-progress candle for the current session with a near-fetch-time
 *   timestamp instead of a clean slot boundary (docs/issues.md, 2026-09-09).
 */
export function startYahooBackfillJob(jobId, { db, symbols, fromDate, toDate }) {
  jobs.set(jobId, { status: 'running', processed: 0, total: symbols.length, rowsInserted: 0, errors: [] });
  runBackfill(jobId, { db, symbols, fromDate, toDate }).catch((err) => {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'failed', error: err.message });
  });
}

async function runBackfill(jobId, { db, symbols, fromDate, toDate }) {
  const period1 = istDateToUnixSeconds(fromDate);
  const period2 = istDateToUnixSeconds(toDate ?? nowIst().slice(0, 10));
  // Yahoo's own candle boundaries don't necessarily match this app's
  // scheduled-slot grid -- snap every candle onto the REAL grid
  // (market-open-anchored, e.g. 09:15, 10:15, ..., 15:15, then
  // market_close_time forced on as the final slot, e.g. 15:45 -- see
  // computeSlots) so a backfilled bar lands in the SAME History-tab column
  // a live-scraped bar from that hour would have, rather than fragmenting
  // into its own stray column (docs/issues.md, 2026-09-09).
  const { interval_minutes: intervalMinutes, market_open_time: openTime, market_close_time: closeTime } = await db.readSchedulerConfig();
  const slots = computeSlots(openTime, closeTime, intervalMinutes);

  let processed = 0;
  let rowsInserted = 0;
  const errors = [];

  for (const symbol of symbols) {
    try {
      const bars = await fetchYahooHourlyCandles(symbol, period1, period2);
      await db.ensureSymbols([symbol]);
      for (const bar of bars) {
        await db.writeOhlcvRowIfAbsent({
          symbol,
          ts_ist: roundToScheduledSlot(bar.ts_ist, slots),
          actual_ts_ist: bar.ts_ist, // the candle's own real time, for delay_seconds/audit -- not "actually ingested" (meaningless here) but the closest analog
          open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
          price_change: bar.close - bar.open,
          price_change_pct: bar.open !== 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0,
          is_manual_entry: false,
          source: 'yahoo-backfill',
        });
        rowsInserted++;
      }
    } catch (err) {
      errors.push({ symbol, reason: err.message });
    }
    processed++;
    jobs.set(jobId, { status: 'running', processed, total: symbols.length, rowsInserted, errors });
    await sleep(REQUEST_DELAY_MS);
  }

  jobs.set(jobId, { status: 'done', processed, total: symbols.length, rowsInserted, errors });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
