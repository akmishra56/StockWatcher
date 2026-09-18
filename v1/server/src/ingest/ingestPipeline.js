/**
 * The ingest cycle orchestrator: missing-symbol detect -> compute -> persist
 * -> filter -> broadcast. Consumes only normalized bars from a
 * MarketDataSource (docs/architecture.md §2a), plus one exception: it DOES
 * know when a bar came from the NSE feed specifically (bar.sourceName
 * 'nse-csv'/'nse-playwright'), because that feed's OPEN/HIGH/LOW are
 * day-cumulative stats, not a real per-interval candle -- see
 * ingest/deriveNseSlotOhlc.js. A broker API's bars are assumed to already
 * be real per-interval OHLC and pass through untouched.
 */
import { deriveNseSlotOhlc } from './deriveNseSlotOhlc.js';

export class IngestPipeline {
  /**
   * @param {object} deps
   * @param {import('../db/client.js').DbClient} deps.db
   * @param {import('../indicators/state.js').IndicatorEngine} deps.indicatorEngine
   * @param {import('../filters/engine.js').FilterEngine} [deps.filterEngine]
   * @param {{ publish: (...msgs: object[]) => void }} [deps.broadcaster]
   * @param {() => Set<string>} deps.getFullUniverse
   * @param {() => string} [deps.getActiveSuperFilter]
   * @param {import('../priceAlerts/engine.js').PriceAlertEngine} [deps.priceAlertEngine]
   * @param {(entries: object[]) => Promise<void>} [deps.onMembershipEvents]  called with this cycle's 'added' membership-log rows (a stock newly entering a saved filter), same fire-and-forget-but-awaited shape as priceAlertEngine's onEvents
   */
  constructor({ db, indicatorEngine, filterEngine, broadcaster, getFullUniverse, getActiveSuperFilter, priceAlertEngine, onMembershipEvents }) {
    this.db = db;
    this.indicatorEngine = indicatorEngine;
    this.filterEngine = filterEngine;
    this.broadcaster = broadcaster ?? { publish: () => {} };
    this.getFullUniverse = getFullUniverse;
    this.getActiveSuperFilter = getActiveSuperFilter ?? (() => 'all');
    this.priceAlertEngine = priceAlertEngine;
    this.onMembershipEvents = onMembershipEvents;
  }

  /**
   * @param {string} scheduledTsIst
   * @param {import('../datasource/MarketDataSource.js').NormalizedBar[]} bars
   * @param {{ isManual?: boolean, fileNames?: string[], parseErrors?: object[], sourceErrors?: string[] }} [meta]
   */
  async runCycle(scheduledTsIst, bars, meta = {}) {
    const isManual = meta.isManual ?? false;
    const parseErrors = meta.parseErrors ?? [];
    const sourceErrors = meta.sourceErrors ?? [];

    const fullUniverse = this.getFullUniverse();
    const presentSymbols = new Set(bars.map((b) => b.symbol));
    const missingSymbols = [...fullUniverse].filter((s) => !presentSymbols.has(s));

    // NSE's live feed (watch-folder CSV or the scheduled Playwright scrape)
    // reports day-cumulative OPEN/HIGH/LOW, not a real per-interval candle
    // -- deriveNseSlotOhlc.js turns that into an actual per-slot bar, which
    // needs the previous slot's close and the day's raw high/low as of the
    // last poll. Broker/manual bars are already real bars and skip this.
    const nseBars = bars.filter((b) => b.sourceName?.startsWith('nse-'));
    const tradeDate = scheduledTsIst.slice(0, 10);
    const previousMap = nseBars.length > 0 ? await this.db.readLatestSnapshotMap() : new Map();
    const dayTracker = nseBars.length > 0
      ? await this.db.readNseDayTracker(nseBars.map((b) => b.symbol), tradeDate)
      : new Map();

    const snapshot = [];
    const nseSymbols = [];
    for (const bar of bars) {
      const actualTsIst = bar.actual_ts_ist;
      const isNse = bar.sourceName?.startsWith('nse-') ?? false;

      let open = bar.open, high = bar.high, low = bar.low;
      if (isNse) {
        const prevTracker = dayTracker.get(bar.symbol);
        const derived = deriveNseSlotOhlc({
          prevClose: previousMap.get(bar.symbol)?.close ?? null,
          rawOpen: bar.open, rawHigh: bar.high, rawLow: bar.low, close: bar.close,
          prevRawHigh: prevTracker?.raw_high ?? null, prevRawLow: prevTracker?.raw_low ?? null,
        });
        // Track NSE's own raw day-high/day-low (not our derived values) so
        // the next poll can tell whether they actually moved this interval.
        await this.db.writeNseDayTrackerRow(bar.symbol, tradeDate, bar.high, bar.low);
        ({ open, high, low } = derived);
        nseSymbols.push(bar.symbol);
      }

      const priceChange = bar.close - open;
      const priceChangePct = open !== 0 ? (priceChange / open) * 100 : 0;

      const indicatorOutput = this.indicatorEngine.applyBar(bar.symbol, { ...bar, open, high, low });

      const ohlcvRow = {
        symbol: bar.symbol, ts_ist: scheduledTsIst, actual_ts_ist: actualTsIst,
        open, high, low, close: bar.close, volume: bar.volume,
        price_change: priceChange, price_change_pct: priceChangePct, is_manual_entry: isManual,
        source: isManual ? 'manual' : isNse ? 'live-nse' : bar.sourceName?.startsWith('broker-') ? 'live-broker' : 'live',
      };
      const indicatorRow = { symbol: bar.symbol, ts_ist: scheduledTsIst, ...indicatorOutput };

      await this.db.ensureSymbols([bar.symbol]);
      await this.db.writeOhlcvRow(ohlcvRow);
      await this.db.writeIndicatorRow(indicatorRow);
      // Keeps snapshot_window (schema.sql) in sync with every bar this
      // pipeline processes -- live scrape, broker poll, or manual upload.
      // The Yahoo backfill deliberately never goes through this pipeline
      // (writes ohlcv_snapshots directly, no indicators), so it never
      // touches the window either -- see docs/researchOutput.md, 2026-09-09.
      await this.db.syncSnapshotWindowRow({ ...ohlcvRow, ...indicatorOutput });
      await this.indicatorEngine.persistState(this.db, bar.symbol, actualTsIst);

      snapshot.push({
        ...ohlcvRow, ...indicatorOutput,
        delaySeconds: secondsBetween(scheduledTsIst, actualTsIst),
      });
    }

    const actualTsIstForLog = bars[0]?.actual_ts_ist ?? scheduledTsIst;
    const status = sourceErrors.length > 0 || missingSymbols.length > 0 ? 'partial' : 'ok';
    const ingestionLogId = await this.db.writeIngestionLog({
      scheduled_ts_ist: scheduledTsIst,
      file_name: (meta.fileNames ?? []).join('; '),
      ingested_at_ist: actualTsIstForLog,
      row_count: bars.length,
      expected_row_count: fullUniverse.size,
      missing_symbol_count: missingSymbols.length,
      status,
      error_message: [...parseErrors.map((e) => e.reason), ...sourceErrors].join('; ') || null,
    });
    if (missingSymbols.length > 0) {
      await this.db.writeMissingSymbolLog(ingestionLogId, scheduledTsIst, missingSymbols);
    }

    const superFilter = this.getActiveSuperFilter();
    const { logRows } = this.filterEngine
      ? await this.filterEngine.reevaluateAll(snapshot, superFilter)
      : { logRows: [] };
    if (logRows.length > 0) await this.db.writeMembershipLog(logRows);
    // Only newly-entering symbols ("added") notify -- "removed" is the
    // absence of a match, not an event worth a Telegram ping, and matches
    // the user's own framing of this feature ("whenever a stock enters a
    // filter list").
    const membershipAdditions = logRows.filter((r) => r.action === 'added');
    if (membershipAdditions.length > 0 && this.onMembershipEvents) {
      await this.onMembershipEvents(membershipAdditions).catch(() => {});
    }

    // Runs after the per-row snapshot_window sync above, same timing
    // FilterEngine.reevaluateAll relies on for its own crosses_above/
    // crosses_below conditions -- this cycle's row is already in place, so
    // readPreviousSnapshotMap's rank-2 lookup is exactly the prior tick.
    const { events: priceAlertEvents } = this.priceAlertEngine
      ? await this.priceAlertEngine.reevaluateAll(snapshot, scheduledTsIst, actualTsIstForLog)
      : { events: [] };
    if (priceAlertEvents.length > 0) {
      this.broadcaster.publish({ type: 'price-alert:triggered', events: priceAlertEvents });
    }

    this.broadcaster.publish({ type: 'snapshot:update', rows: snapshot });
    // logRows carry `filterId` (camelCase, what db.writeMembershipLog/
    // appendMembershipLogFile expect) -- the WS wire format and the REST
    // GET /api/filters/:id/matches shape both use `filter_id` (snake_case,
    // matching the DB column), so translate before publishing or the
    // frontend's LogEntry.filter_id is undefined for every live-pushed row.
    if (logRows.length > 0) {
      this.broadcaster.publish({
        type: 'log:new',
        entries: logRows.map((r) => ({ filter_id: r.filterId, symbol: r.symbol, action: r.action, ts_ist: r.ts_ist })),
      });
    }
    if (missingSymbols.length > 0) {
      this.broadcaster.publish({
        type: 'alert:missing-symbols', count: missingSymbols.length,
        symbols: missingSymbols, ts_ist: scheduledTsIst,
      });
    }

    return { snapshot, missingSymbols, parseErrors, sourceErrors, ingestionLogId, nseSymbols };
  }
}

function secondsBetween(scheduledTsIst, actualTsIst) {
  const parse = (s) => {
    // 'YYYY-MM-DD HH:MM:SS' parsed as a wall-clock instant, timezone-agnostic
    // for the purpose of a *difference* (both sides are IST wall-clock).
    const [datePart, timePart] = s.split(' ');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi, se] = timePart.split(':').map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, se);
  };
  return Math.round((parse(actualTsIst) - parse(scheduledTsIst)) / 1000);
}
