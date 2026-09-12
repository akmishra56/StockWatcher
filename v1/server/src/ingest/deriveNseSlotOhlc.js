/**
 * NSE's live equity feed (both the watch-folder CSV and the scheduled
 * Playwright scrape -- see columnMap.js) reports OPEN/HIGH/LOW as
 * day-cumulative values: OPEN is literally the day's opening price (same
 * every poll all day), HIGH/LOW are the day's running extremes since
 * market open, and only LTP (-> close) actually moves poll to poll.
 * Storing those columns directly as if they were a per-interval candle
 * means every hourly "bar" looks like a flat open/low with an
 * ever-widening high -- confirmed live, 2026-09-09 (docs/issues.md).
 *
 * This derives an actual per-slot candle from that feed instead:
 *   - open  = the previous slot's close (this slot's price action picks up
 *             where the last one left off; the very first slot of the day
 *             has no previous close, so it falls back to the day's own
 *             open, which is correct for that one slot)
 *   - close = LTP, unchanged from what NSE reports
 *   - high  = the day's cumulative high, but ONLY if it just increased
 *             since the previous poll -- a rising day-high can only have
 *             been set within this interval, so that's real information
 *             about this slot specifically. If it didn't move, fall back to
 *             the higher of this slot's own open/close (a real per-slot
 *             high may have happened and receded between polls; this is a
 *             floor, not a guess).
 *   - low   = the mirror of high, against the day's cumulative low.
 *
 * This is a best-effort approximation from a feed that fundamentally
 * doesn't carry true per-interval data -- reconciled ~30 minutes later
 * against Yahoo Finance's real hourly candle once the exchange has settled
 * that hour (see jobs/reconcileNseSlot.js).
 *
 * @param {{ prevClose: number|null, rawOpen: number, rawHigh: number, rawLow: number,
 *   close: number, prevRawHigh: number|null, prevRawLow: number|null }} args
 * @returns {{ open: number, high: number, low: number, close: number }}
 */
export function deriveNseSlotOhlc({ prevClose, rawOpen, rawHigh, rawLow, close, prevRawHigh, prevRawLow }) {
  const open = prevClose ?? rawOpen;

  const dayHighMoved = prevRawHigh == null || rawHigh > prevRawHigh;
  const dayLowMoved = prevRawLow == null || rawLow < prevRawLow;

  const highCandidates = [open, close];
  if (dayHighMoved) highCandidates.push(rawHigh);
  const lowCandidates = [open, close];
  if (dayLowMoved) lowCandidates.push(rawLow);

  return {
    open,
    high: Math.max(...highCandidates),
    low: Math.min(...lowCandidates),
    close,
  };
}
