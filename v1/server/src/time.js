/**
 * All timestamps are IST (Asia/Kolkata), regardless of server locale.
 * See docs/architecture.md §9 (isolation and robustness requirements).
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { computeSlots } from './marketHours.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = 'Asia/Kolkata';

/** Current time as IST wall-clock 'YYYY-MM-DD HH:mm:ss'. */
export function nowIst() {
  return dayjs().tz(IST).format('YYYY-MM-DD HH:mm:ss');
}

/**
 * The real scheduled slot closest to right now -- used to tag an ad-hoc
 * "Run Now" trigger with a slot instead of its own raw arrival time.
 * Anchored to the actual market-open-anchored grid (computeSlots), same as
 * roundToScheduledSlot -- an earlier version floored to a naive top-of-hour
 * bucket instead (e.g. '13:00' rather than '13:15' for a 09:15-anchored
 * 60-minute grid), which mistagged manual triggers onto a slot that doesn't
 * exist anywhere else on the grid (found live in v2, 2026-09-16 -- see
 * docs/issues.md; v1 inherited the same bug from v2's original pattern).
 */
export function currentScheduledSlot(marketOpenTime, marketCloseTime, intervalMinutes) {
  const slots = computeSlots(marketOpenTime, marketCloseTime, intervalMinutes);
  return roundToScheduledSlot(nowIst(), slots);
}

/** A Unix epoch (seconds) -- e.g. a Yahoo Finance chart candle timestamp -- as IST wall-clock 'YYYY-MM-DD HH:mm:ss'. */
export function unixSecondsToIst(unixSeconds) {
  return dayjs.unix(unixSeconds).tz(IST).format('YYYY-MM-DD HH:mm:ss');
}

/** IST wall-clock 'YYYY-MM-DD' -> Unix epoch seconds, for building a Yahoo Finance chart API date range. */
export function istDateToUnixSeconds(dateStr) {
  return dayjs.tz(dateStr, IST).startOf('day').unix();
}

/**
 * Snaps an IST wall-clock timestamp onto the NEAREST of a day's real
 * scheduled slots (an 'HH:mm' list -- pass marketHours.js's
 * computeSlots(market_open_time, market_close_time, interval_minutes), the
 * exact grid Scheduler._tick() fires orchestrated cycles on: market-open
 * anchored, e.g. 09:15, 10:15, ..., 15:15, then market_close_time forced on
 * as the final slot, e.g. 15:45), keeping its date. So any other writer into
 * ohlcv_snapshots (manual upload, historical backfill) lands in the SAME
 * slot column a live-scraped bar from that hour would have, rather than its
 * own raw arrival/candle time -- History tab's slot-column logic depends on
 * every writer sharing one canonical grid. An earlier version of this
 * floored to a naive top-of-hour bucket instead of the real open-time-
 * anchored grid, which put backfilled/manual columns 15 minutes off the
 * live scraper's own columns (docs/issues.md, 2026-09-09).
 */
export function roundToScheduledSlot(tsIst, slots) {
  const [datePart, timePart] = tsIst.split(' ');
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const targetMin = toMinutes(timePart.slice(0, 5));
  let nearest = slots[0];
  let bestDiff = Infinity;
  for (const slot of slots) {
    const diff = Math.abs(toMinutes(slot) - targetMin);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearest = slot;
    }
  }
  return `${datePart} ${nearest}:00`;
}
