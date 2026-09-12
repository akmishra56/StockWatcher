import { useEffect, useState } from 'react';
import { api } from '../../api';
import { parseHolidayDates } from '../../holidayParse';

export function AutomationSchedulerSection({ onSchedulerChanged }: { onSchedulerChanged: () => void }) {
  const [scheduler, setScheduler] = useState<Awaited<ReturnType<typeof api.getScheduler>> | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function refresh() {
    api.getScheduler().then(setScheduler);
  }

  useEffect(refresh, []);

  async function toggleEnabled() {
    if (!scheduler) return;
    await api.putScheduler({ enabled: !scheduler.enabled });
    refresh();
    onSchedulerChanged();
  }

  async function saveInterval(minutes: number) {
    await api.putScheduler({ intervalMinutes: minutes });
    refresh();
  }

  async function saveMarketHours(openTime: string, closeTime: string) {
    await api.putScheduler({ marketOpenTime: openTime, marketCloseTime: closeTime });
    refresh();
  }

  async function toggleWeekday(day: string) {
    if (!scheduler) return;
    await api.putScheduler({ activeWeekdays: { ...scheduler.activeWeekdays, [day]: !scheduler.activeWeekdays[day as keyof typeof scheduler.activeWeekdays] } });
    refresh();
  }

  async function runNow() {
    setStatus('Running…');
    try {
      const res: any = await api.runSchedulerNow();
      setStatus(res.note ?? res.error ?? 'Done');
    } finally {
      refresh();
    }
  }

  async function saveMinRunGap(seconds: number) {
    await api.putScheduler({ minRunGapSeconds: seconds });
    refresh();
  }

  const [newHoliday, setNewHoliday] = useState('');
  async function addHoliday() {
    if (!scheduler || !newHoliday) return;
    if (scheduler.holidays.includes(newHoliday)) return;
    await api.putScheduler({ holidays: [...scheduler.holidays, newHoliday].sort() });
    setNewHoliday('');
    refresh();
  }
  async function removeHoliday(date: string) {
    if (!scheduler) return;
    await api.putScheduler({ holidays: scheduler.holidays.filter((d) => d !== date) });
    refresh();
  }

  async function uploadHolidayFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !scheduler) return;
    const text = await file.text();
    const parsed = parseHolidayDates(text);
    if (parsed.length === 0) {
      setStatus('No dates recognized in that file -- expected one date per line (or a CSV with a date column), e.g. "2026-01-26" or "26-Jan-2026".');
      return;
    }
    const merged = Array.from(new Set([...scheduler.holidays, ...parsed])).sort();
    await api.putScheduler({ holidays: merged });
    setStatus(`Added ${parsed.length} date(s) from file (${merged.length} holiday(s) total).`);
    refresh();
  }

  if (!scheduler) return <div className="text-3">Loading…</div>;

  return (
    <div className="settings-section">
      <h3>Automation &amp; Scheduler</h3>

      <div className="param-group">
        <div className="param-group-title">Schedule</div>
        <p className="text-2" style={{ fontSize: 12 }}>
          Each slot's Yahoo Finance quote is fetched ~17 minutes after the slot time, once Yahoo's own ~15-minute
          delayed feed has caught up to it -- e.g. the 10:15 slot is actually fetched at 10:32.
        </p>
        <div className="param-group-fields">
          <label className="streaming-toggle">
            <input type="checkbox" checked={scheduler.enabled} onChange={toggleEnabled} />
            <span className="slider" />
            <span className="text-2" style={{ fontSize: 11 }}>Automation {scheduler.enabled ? 'ON' : 'OFF'}</span>
          </label>
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Interval (minutes)</span>
            <input
              type="number"
              min={1}
              value={scheduler.intervalMinutes}
              onChange={(e) => saveInterval(Number(e.target.value))}
            />
          </label>
          <button className="chip-toggle" onClick={runNow}>Run Now</button>
        </div>
        <div className="text-2 mono" style={{ fontSize: 11, marginTop: 8 }}>
          Last run: {scheduler.lastRunAtIst ?? '-'}
        </div>
        {status && <div className="text-2" style={{ fontSize: 11.5, marginTop: 6 }}>{status}</div>}
      </div>

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title">Market hours</div>
        <p className="text-2" style={{ fontSize: 12 }}>
          The scheduler only runs between these times, on the weekdays enabled below (e.g. switch a day off for a
          holiday). At a {scheduler.intervalMinutes}-minute interval it runs every {scheduler.intervalMinutes} minutes
          starting from market open, through close.
        </p>
        <div className="param-group-fields">
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Market open</span>
            <input type="time" value={scheduler.marketOpenTime} onChange={(e) => saveMarketHours(e.target.value, scheduler.marketCloseTime)} />
          </label>
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Market close</span>
            <input type="time" value={scheduler.marketCloseTime} onChange={(e) => saveMarketHours(scheduler.marketOpenTime, e.target.value)} />
          </label>
        </div>
        <div className="weekday-row">
          {(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((day) => (
            <button
              key={day}
              className={`weekday-chip ${scheduler.activeWeekdays[day] ? 'weekday-chip-active' : ''}`}
              onClick={() => toggleWeekday(day)}
            >
              {day.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title">Minimum gap between runs</div>
        <p className="text-2" style={{ fontSize: 12 }}>
          A floor enforced across every trigger (scheduled ticks, Run Now) so two fetch+ingest cycles never start
          closer together than this.
        </p>
        <div className="param-group-fields">
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Seconds</span>
            <input
              type="number"
              min={0}
              value={scheduler.minRunGapSeconds}
              onChange={(e) => saveMinRunGap(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title">NSE holidays</div>
        <p className="text-2" style={{ fontSize: 12 }}>
          The scheduler skips these dates entirely, even on an enabled weekday.
        </p>
        <div className="holiday-chips">
          {scheduler.holidays.length === 0 && <span className="text-3" style={{ fontSize: 11.5 }}>No holidays configured.</span>}
          {scheduler.holidays.map((d) => (
            <span key={d} className="chip-sm holiday-chip">
              {d}
              <button onClick={() => removeHoliday(d)}>✕</button>
            </span>
          ))}
        </div>
        <div className="param-group-fields" style={{ marginTop: 8 }}>
          <input type="date" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} />
          <button className="chip-toggle" onClick={addHoliday}>+ Add holiday</button>
        </div>
        <div className="param-group-fields" style={{ marginTop: 8 }}>
          <label className="chip-toggle" style={{ cursor: 'pointer' }}>
            Upload holiday list (CSV/TXT)
            <input type="file" accept=".csv,.txt" onChange={uploadHolidayFile} style={{ display: 'none' }} />
          </label>
        </div>
      </div>
    </div>
  );
}
