/**
 * Fetches one slot's worth of live bars from Yahoo Finance for every symbol
 * in the (Nifty 50) universe -- the v1 replacement for the old NSE/Playwright
 * scrape+parse step in scheduler.js. Yahoo's unofficial chart API is itself
 * ~15 minutes delayed for NSE symbols during live market hours, and its
 * 60-minute candles for `.NS` tickers land exactly on this app's own
 * market-open-anchored hourly grid (09:15, 10:15, ..., confirmed live,
 * 2026-09-09) -- so scheduler.js fires this ~17 minutes after each slot
 * time, by which point Yahoo's own delayed feed has settled a real candle
 * for it, and this only ever has to find the ONE bar matching that exact
 * slot rather than reconstruct anything.
 */
import { fetchYahooHourlyCandles } from './datasource/yahooChart.js';
import { istDateToUnixSeconds, nowIst } from './time.js';

// Same conservative, deliberately-not-as-fast-as-possible pace
// jobs/backfillYahooHistory.js already uses against this same unofficial
// endpoint -- ~50 symbols at this pace is well within a single hourly slot.
const REQUEST_DELAY_MS = 350;

/**
 * @param {string[]} symbols
 * @param {string} slotTsIst 'YYYY-MM-DD HH:mm:ss' -- the scheduled slot this
 *   cycle is tagged with (not the current time, which is ~17 minutes later).
 * @returns {Promise<{ bars: import('./datasource/MarketDataSource.js').NormalizedBar[], errors: string[] }>}
 */
export async function fetchYahooSlotBars(symbols, slotTsIst) {
  const today = slotTsIst.slice(0, 10);
  const period1 = istDateToUnixSeconds(today);
  const period2 = Math.floor(Date.now() / 1000);
  const actualTsIst = nowIst();

  const bars = [];
  const errors = [];
  for (const symbol of symbols) {
    try {
      const candles = await fetchYahooHourlyCandles(symbol, period1, period2);
      const match = candles.find((c) => c.ts_ist === slotTsIst);
      if (match) {
        bars.push({
          symbol, ts_ist: slotTsIst, actual_ts_ist: actualTsIst,
          open: match.open, high: match.high, low: match.low, close: match.close, volume: match.volume,
          sourceName: 'yahoo-live',
        });
      } else {
        errors.push(`${symbol}: no Yahoo candle for slot ${slotTsIst}`);
      }
    } catch (err) {
      errors.push(`${symbol}: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return { bars, errors };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
