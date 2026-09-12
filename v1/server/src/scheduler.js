/**
 * Automation orchestration (v1, Yahoo-only): on each active market-hours
 * slot (see marketHours.js), waits until ~17 minutes after the slot time --
 * long enough for Yahoo Finance's own ~15-minute-delayed feed to have
 * settled a real candle for it -- then fetches that slot's bar for every
 * symbol in the universe (yahooLiveScheduler.js) and feeds it through the
 * normal ingest pipeline. No Playwright, no NSE site, no premarket run --
 * see docs/roadmap.md for the v1/v2 split.
 */
import cron from 'node-cron';
import { nowIst, currentScheduledSlot } from './time.js';
import { computeSlots, isWeekdayActive, isHoliday } from './marketHours.js';
import { enqueueScrape } from './scrapeQueue.js';
import { saveScheduledCheckpoint } from './checkpointManager.js';
import { fetchYahooSlotBars } from './yahooLiveScheduler.js';

// How long after a slot's own time to actually fetch it -- Yahoo Finance's
// unofficial chart API is itself ~15 minutes delayed for NSE symbols during
// live market hours; this gives it a couple of minutes of headroom to have
// definitely settled a real candle for the slot (e.g. the 10:15 slot is
// fetched at 10:32, per the user's explicit 2026-09-09 instruction).
const YAHOO_DELAY_MINUTES = 17;

export class Scheduler {
  /**
   * @param {import('./db/client.js').DbClient} db
   * @param {{ pipeline: () => import('./ingest/ingestPipeline.js').IngestPipeline, getFullUniverse: () => Set<string>,
   *           connectionId?: string }} deps
   */
  constructor(db, deps = {}) {
    this.db = db;
    this.getPipeline = deps.pipeline ?? (() => null);
    this.getFullUniverse = deps.getFullUniverse ?? (() => new Set());
    this.connectionId = deps.connectionId ?? null;

    this.intervalMinutes = 60;
    this.enabled = true;
    this.marketOpenTime = '09:15';
    this.marketCloseTime = '15:45';
    this.activeWeekdays = { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false };
    this.holidays = [];
    this.minRunGapSeconds = 30; // Yahoo's own per-symbol pacing lives in yahooLiveScheduler.js; this just floors the gap between separate cycles (scheduled tick vs. Run Now)
    this._task = null;
    this._running = false;
    this._lastFiredSlot = null; // guards against re-firing the same HH:mm slot twice within its minute
  }

  async init() {
    const row = await this.db.readSchedulerConfig();
    this.intervalMinutes = row.interval_minutes;
    this.enabled = row.enabled;
    this.marketOpenTime = row.market_open_time;
    this.marketCloseTime = row.market_close_time;
    this.activeWeekdays = row.active_weekdays;
    this.holidays = row.holidays ?? [];
    this.minRunGapSeconds = row.min_run_gap_seconds ?? 30;
    this._schedule();
  }

  _schedule() {
    if (this._task) this._task.stop();
    // Ticks every minute and checks against each slot's delayed fire time --
    // a generic `*/N` cron can't express "N minutes after a non-:00-aligned,
    // per-slot offset".
    this._task = cron.schedule('* * * * *', () => this._tick());
  }

  async _tick() {
    if (!this.enabled || this._running) return;

    const now = nowIst(); // 'YYYY-MM-DD HH:mm:ss'
    const today = now.slice(0, 10);
    const hhmm = now.slice(11, 16);
    const dayIndex = new Date(now.replace(' ', 'T')).getDay();

    if (!isWeekdayActive(this.activeWeekdays, dayIndex)) return;
    if (isHoliday(this.holidays, today)) return;

    const slots = computeSlots(this.marketOpenTime, this.marketCloseTime, this.intervalMinutes);
    const dueSlot = slots.find((slot) => addMinutes(slot, YAHOO_DELAY_MINUTES) === hhmm);
    if (!dueSlot) return;

    const slotKey = `${today} ${dueSlot}`;
    if (this._lastFiredSlot === slotKey) return; // already fired for this exact slot
    this._lastFiredSlot = slotKey;

    this._running = true;
    try {
      const scheduledTsIst = `${today} ${dueSlot}:00`;
      await enqueueScrape(() => this._runOrchestrationCycle(scheduledTsIst), this.minRunGapSeconds * 1000);
      try {
        await saveScheduledCheckpoint(this.db, this.connectionId, scheduledTsIst);
      } catch (err) {
        console.error('scheduler: checkpoint after scheduled run failed', err);
      }
    } finally {
      this._running = false;
    }
  }

  /** Exposed for the Settings "Run Now" button -- fetches the current slot immediately, bypassing the delay check. */
  async runNow() {
    if (this._running) throw new Error('A fetch+ingest cycle is already running');
    this._running = true;
    try {
      await enqueueScrape(() => this._runOrchestrationCycle(currentScheduledSlot(this.intervalMinutes)), this.minRunGapSeconds * 1000);
    } finally {
      this._running = false;
    }
  }

  async _runOrchestrationCycle(scheduledTsIst) {
    const pipeline = this.getPipeline();
    if (!pipeline) return;

    await this.db.run("UPDATE scheduler_config SET last_run_at_ist = ? WHERE key = 'default'", nowIst());

    const symbols = [...this.getFullUniverse()];
    const { bars, errors } = await fetchYahooSlotBars(symbols, scheduledTsIst);
    if (bars.length === 0) {
      console.error('yahoo scheduler: no bars fetched for slot', scheduledTsIst, errors.slice(0, 3));
      return;
    }
    await pipeline.runCycle(scheduledTsIst, bars, { sourceErrors: errors });
  }

  isRunning() {
    return this._running;
  }

  scheduledSlot() {
    return currentScheduledSlot(this.intervalMinutes);
  }

  async setInterval(minutes) {
    this.intervalMinutes = minutes;
    await this.db.writeSchedulerConfig({ interval_minutes: minutes }, nowIst());
  }

  async setEnabled(enabled) {
    this.enabled = enabled;
    await this.db.writeSchedulerConfig({ enabled }, nowIst());
  }

  async setMarketHours(openTime, closeTime) {
    this.marketOpenTime = openTime;
    this.marketCloseTime = closeTime;
    await this.db.writeSchedulerConfig({ market_open_time: openTime, market_close_time: closeTime }, nowIst());
  }

  async setActiveWeekdays(activeWeekdays) {
    this.activeWeekdays = activeWeekdays;
    await this.db.writeSchedulerConfig({ active_weekdays: activeWeekdays }, nowIst());
  }

  async setHolidays(holidays) {
    this.holidays = holidays;
    await this.db.writeSchedulerConfig({ holidays }, nowIst());
  }

  async setMinRunGapSeconds(seconds) {
    this.minRunGapSeconds = seconds;
    await this.db.writeSchedulerConfig({ min_run_gap_seconds: seconds }, nowIst());
  }

  stop() {
    this._task?.stop();
  }
}

function addMinutes(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
