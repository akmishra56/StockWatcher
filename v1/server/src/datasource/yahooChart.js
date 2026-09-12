/**
 * Shared client for Yahoo Finance's unofficial chart API -- factored out of
 * jobs/backfillYahooHistory.js so jobs/reconcileNseSlot.js (the 30-minutes-
 * later correction pass for live NSE-derived bars, see
 * ingest/deriveNseSlotOhlc.js) can reuse the exact same fetch, rather than
 * duplicating the User-Agent workaround and response parsing.
 */
import { unixSecondsToIst } from '../time.js';

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

/**
 * @param {string} symbol plain NSE symbol, e.g. 'RELIANCE'
 * @returns {Promise<{ts_ist: string, open: number, high: number, low: number, close: number, volume: number}[]>}
 */
export async function fetchYahooHourlyCandles(symbol, period1, period2) {
  const ticker = `${symbol}.NS`;
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=60m&period1=${period1}&period2=${period2}&events=history`;
  // A bare/minimal User-Agent gets HTTP 429 ("Edge: Too Many Requests")
  // immediately from this unofficial endpoint -- confirmed live,
  // 2026-09-09 (see docs/researchOutput.md). A fuller, ordinary-browser
  // header set gets through reliably.
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reason = body?.chart?.error?.description ?? `HTTP ${res.status}`;
    throw new Error(`Yahoo Finance request failed: ${reason}`);
  }
  const result = body?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo Finance: no result for ${ticker} (${body?.chart?.error?.description ?? 'unknown reason'})`);
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];
    // Yahoo returns null OHLC for non-trading gaps within an otherwise
    // valid response (holidays, partial sessions) -- skip, don't error.
    if ([o, h, l, c].some((n) => typeof n !== 'number' || !Number.isFinite(n))) continue;
    bars.push({ ts_ist: unixSecondsToIst(timestamps[i]), open: o, high: h, low: l, close: c, volume: typeof v === 'number' ? v : 0 });
  }
  return bars;
}
