/**
 * The ONE generic broker orchestrator every broker connection uses --
 * polling cadence, weekday/holiday/market-hours gating, universe
 * batching, and NormalizedBar assembly are all here, once. A new broker
 * (Zerodha, Upstox, ...) plugs in by implementing BrokerClient.js only;
 * this file never changes and is never duplicated per-broker. Implements
 * the same MarketDataSource contract the NSE CSV adapter does (onCycle/
 * start/stop), so server.js can hand a BrokerBridge instance to
 * `ctx.adapter` and reuse the exact same `adapter.onCycle(...) ->
 * pipeline.runCycle(...)` wiring already built for the CSV path -- nothing
 * downstream (ingestPipeline, indicators, filters, the frontend) knows or
 * cares whether bars came from a scraped CSV or a broker REST call.
 *
 * Deliberately reuses scheduler_config (interval/market-hours/weekday/
 * holiday settings) rather than inventing a parallel schedule -- the same
 * Settings > Automation & Scheduler UI drives both an NSE-scrape
 * connection and a broker connection; only the underlying data source
 * differs. Deliberately does NOT go through scrapeQueue.js: that exists to
 * throttle scraping a website that can flag automated traffic as abuse,
 * which doesn't apply to an authenticated REST API call to a broker (see
 * docs/erd.md: "a broker connection can use much less" for min_run_gap).
 */
import cron from 'node-cron';
import { computeSlots, isWeekdayActive, isHoliday } from '../../marketHours.js';
import { MarketDataSource } from '../MarketDataSource.js';

export class BrokerBridge extends MarketDataSource {
  /**
   * @param {object} deps
   * @param {import('./BrokerClient.js').BrokerClient} deps.client
   * @param {() => (Set<string> | string[] | Promise<Set<string> | string[]>)} deps.getUniverse
   *   Symbols to poll each cycle -- called fresh every cycle (may be async),
   *   never cached by BrokerBridge itself. Unlike the CSV path, a broker has
   *   no scrape result to organically grow the universe from, so this
   *   should read the current `symbols` table (or a classification-based
   *   subset of it) directly rather than a snapshot captured once at
   *   connection-activation time.
   * @param {() => string} deps.nowIst
   * @param {() => Promise<{ interval_minutes: number, market_open_time: string, market_close_time: string, active_weekdays: object, holidays: string[], enabled: boolean }>} deps.getScheduleConfig
   */
  constructor({ client, getUniverse, nowIst, getScheduleConfig }) {
    super();
    this.client = client;
    this.getUniverse = getUniverse;
    this.nowIst = nowIst;
    this.getScheduleConfig = getScheduleConfig;
    this._callback = null;
    this._task = null;
    this._lastFiredSlot = null;
    this._running = false;
  }

  onCycle(callback) {
    this._callback = callback;
  }

  start() {
    this._task = cron.schedule('* * * * *', () => this._tick());
  }

  stop() {
    this._task?.stop();
  }

  async _tick() {
    if (this._running) return;

    const config = await this.getScheduleConfig();
    if (!config.enabled) return;

    const now = this.nowIst(); // 'YYYY-MM-DD HH:mm:ss'
    const today = now.slice(0, 10);
    const hhmm = now.slice(11, 16);
    const dayIndex = new Date(now.replace(' ', 'T')).getDay();

    if (!isWeekdayActive(config.active_weekdays, dayIndex)) return;
    if (isHoliday(config.holidays, today)) return;

    const slots = computeSlots(config.market_open_time, config.market_close_time, config.interval_minutes);
    if (!slots.includes(hhmm)) return;

    const slotKey = `${today} ${hhmm}`;
    if (this._lastFiredSlot === slotKey) return; // already fired for this exact slot
    this._lastFiredSlot = slotKey;

    this._running = true;
    try {
      await this.runCycle(`${slotKey}:00`);
    } finally {
      this._running = false;
    }
  }

  /** Exposed directly (not just via the cron tick) so a "Run Now"-style manual trigger can reuse it. */
  async runCycle(scheduledTsIst) {
    if (!(await this.client.isAuthenticated())) {
      console.warn(`[broker-bridge] ${this.client.label} is not authenticated -- skipping this cycle`);
      return;
    }

    const universe = [...(await this.getUniverse())];
    if (universe.length === 0) return;

    const batchSize = Number.isFinite(this.client.maxSymbolsPerRequest) ? this.client.maxSymbolsPerRequest : universe.length;
    const quotes = [];
    for (let i = 0; i < universe.length; i += batchSize) {
      const batch = universe.slice(i, i + batchSize);
      try {
        quotes.push(...(await this.client.getQuotes(batch)));
      } catch (err) {
        // One bad batch must never take down the whole cycle -- the other
        // batches' symbols are still worth ingesting.
        console.error(`[broker-bridge] ${this.client.label} getQuotes failed for a batch of ${batch.length} symbols`, err);
      }
    }
    if (quotes.length === 0 || !this._callback) return;

    const actualTsIst = this.nowIst();
    const bars = quotes.map((q) => ({
      symbol: q.symbol, ts_ist: scheduledTsIst, actual_ts_ist: actualTsIst,
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume,
      sourceName: `broker-${this.client.label.toLowerCase()}`,
    }));

    // Awaited deliberately (unlike NseCsvAdapter's fire-and-forget
    // callback, which is fine there since nothing else depends on
    // knowing exactly when a file-watch cycle's DB writes finish) --
    // runCycle() is exposed for direct/manual use (see the docstring
    // above), so callers need to be able to rely on "awaited = done".
    await this._callback(bars, { scheduledTsIst, actualTsIst, fileNames: [] });
  }
}
