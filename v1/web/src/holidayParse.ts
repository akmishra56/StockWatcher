/**
 * Parses an uploaded NSE holiday list (CSV or plain text, one date per line,
 * optionally with other columns/description text alongside it) into
 * 'YYYY-MM-DD' strings -- the exact format `scheduler_config.holidays`
 * already stores (matching the existing single-date `<input type="date">`
 * add flow in AutomationSchedulerSection.tsx). NSE's own published holiday
 * calendars vary in date format release to release, so this accepts the
 * common ones rather than requiring one exact layout.
 */
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function normalizeDate(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, '');
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  // DD-MM-YYYY / DD/MM/YYYY -- Indian date convention (day first), matching
  // how NSE's own circulars are dated.
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  // 26-Jan-2026 / 26 Jan 2026 / 26 January 2026
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s,-]+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
  }

  // Jan 26, 2026 / January 26 2026
  m = s.match(/^([A-Za-z]{3,})[\s]+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }

  return null;
}

export function parseHolidayDates(text: string): string[] {
  const dates = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    // Try the whole line first (plain one-date-per-line files), then fall
    // back to scanning each comma-separated cell (a CSV with a date column
    // alongside a description/day-name column).
    const whole = normalizeDate(rawLine);
    if (whole) { dates.add(whole); continue; }
    for (const cell of rawLine.split(',')) {
      const d = normalizeDate(cell);
      if (d) { dates.add(d); break; }
    }
  }
  return [...dates].sort();
}
