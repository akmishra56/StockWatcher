/**
 * Pure market-hours scheduling logic: which HH:mm slots a given
 * open/close/interval combination produces, and whether a given weekday is
 * enabled. Kept separate from scheduler.js (which owns the actual timer and
 * orchestration side-effects) so this arithmetic is independently testable.
 *
 * Slots are computed by stepping from open to close by intervalMinutes,
 * inclusive of both ends when they land exactly on a step -- e.g. open
 * 09:00, close 15:30, interval 30 -> 09:00, 09:30, ..., 15:00, 15:30.
 */

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function computeSlots(openTime, closeTime, intervalMinutes) {
  const openMin = toMinutes(openTime);
  const closeMin = toMinutes(closeTime);
  if (!(intervalMinutes > 0) || closeMin < openMin) return [];

  const slots = [];
  for (let t = openMin; t <= closeMin; t += intervalMinutes) {
    slots.push(fromMinutes(t));
  }
  // The interval doesn't always divide evenly into the open->close span (e.g.
  // open 09:15, close 15:45, 60min interval lands on ...,14:15,15:15 and
  // would then skip past close) -- the close-time slot is always taken
  // regardless, so force it on as the final slot when the stepped loop
  // didn't already land on it exactly.
  if (slots.length > 0 && slots[slots.length - 1] !== fromMinutes(closeMin)) {
    slots.push(fromMinutes(closeMin));
  }
  return slots;
}

/** @returns {boolean} whether `dateStr` ('YYYY-MM-DD') is in the configured NSE holiday list. */
export function isHoliday(holidays, dateStr) {
  return Array.isArray(holidays) && holidays.includes(dateStr);
}

/** @param {Date|dayjs} dateInIst  anything with a getDay()-compatible weekday, 0=Sunday */
export function weekdayKeyForDayIndex(dayIndex) {
  return WEEKDAY_KEYS[dayIndex];
}

export function isWeekdayActive(activeWeekdays, dayIndex) {
  return !!activeWeekdays?.[weekdayKeyForDayIndex(dayIndex)];
}

/**
 * Whether NSE is officially open right now: an enabled weekday, not a
 * listed holiday, and within [marketOpenTime, marketCloseTime] inclusive.
 * Backs the top bar's Market Open/Closed indicator (App.tsx) -- kept here
 * rather than duplicated client-side since "every timestamp is IST
 * regardless of server/browser locale" is a hard project invariant
 * (docs/architecture.md §9); the caller passes the server's own `nowIst()`.
 * @param {string} nowIstStr 'YYYY-MM-DD HH:mm:ss', IST wall-clock
 */
export function isMarketOpenNow({ marketOpenTime, marketCloseTime, activeWeekdays, holidays }, nowIstStr) {
  const [datePart, timePart] = nowIstStr.split(' ');
  // Calendar-date-only parse (no time-of-day) as UTC midnight -- getUTCDay()
  // then gives the correct weekday for that date regardless of the host's
  // own local timezone, unlike `new Date(nowIstStr).getDay()` would.
  const dayIndex = new Date(`${datePart}T00:00:00Z`).getUTCDay();
  if (!isWeekdayActive(activeWeekdays, dayIndex)) return false;
  if (isHoliday(holidays, datePart)) return false;
  const nowMin = toMinutes(timePart.slice(0, 5));
  return nowMin >= toMinutes(marketOpenTime) && nowMin <= toMinutes(marketCloseTime);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
