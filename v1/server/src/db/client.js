import duckdb from 'duckdb';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Rows kept per symbol in snapshot_window (schema.sql) -- generous margin
// over the largest default indicator lookback (MACD signal ~35, EMA30,
// Bollinger 20, RSI/ATR 14) and the History tab's own 20-slot maximum. Bump
// this if an indicator period is ever configured larger than it via
// Settings > Indicator Parameters.
const SNAPSHOT_WINDOW_SIZE = 60;

/**
 * DuckDB's Node driver returns BIGINT columns (e.g. volume) as JS `bigint`,
 * which JSON.stringify can't serialize. Every value in this app's schema
 * that's BIGINT (volume) is safely within Number.MAX_SAFE_INTEGER, so this
 * converts bigint -> number at the read boundary rather than making every
 * caller (REST routes, WS broadcaster, tests) handle bigint separately.
 */
function sanitizeRow(row) {
  for (const key in row) {
    if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
  }
  return row;
}

/**
 * Thin promise wrapper around the DuckDB Node driver, plus the typed
 * query helpers the rest of the app uses. One instance per process.
 */
export class DbClient {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new duckdb.Database(dbPath);
    // Two connections against the one open Database -- `conn` for every
    // write (run/exec) plus the handful of reads that must share a
    // connection with a write (RETURNING, and cloneDatabaseTo's PRAGMA
    // immediately before its own ATTACH -- ATTACH/DETACH state is
    // per-connection, so that whole clone sequence has to stay on one
    // connection), and `readConn` for everything else, i.e. every readAll()
    // call. DuckDB uses MVCC, so readConn always sees a consistent snapshot
    // and never blocks on or is blocked by writeConn -- verified directly
    // (a standalone stress test ran 60 concurrent reads against readConn
    // while writeConn did inserts, CHECKPOINT, and the exact ATTACH+COPY+
    // DETACH sequence checkpointManager.js uses: zero errors, correct final
    // row count) before this split was built, per docs/researchOutput.md's
    // 2026-09-09 load audit, which found the single shared connection
    // meant every read queued behind whatever bulk write (backfill,
    // recalculate) happened to be running at the time.
    this.conn = this.db.connect();
    this.readConn = this.db.connect();
    // Each connection gets its OWN serialized queue -- the DuckDB Node
    // driver isn't documented as safe for concurrent calls on a single
    // Connection, so calls sharing a connection still queue behind each
    // other (e.g. two overlapping writes), but the two connections' queues
    // never block each other.
    this._queue = Promise.resolve();
    this._readQueue = Promise.resolve();
    // Tracked separately so the System Health tab's "DB query latency /
    // queue depth" signal (routes/systemHealth.js) can show read load and
    // write load as the two independent things they now are.
    this._metrics = { queueDepth: 0, completed: 0, durationsMs: [] };
    this._readMetrics = { queueDepth: 0, completed: 0, durationsMs: [] };
  }

  _enqueueOn(queueKey, metricsKey, fn) {
    const metrics = this[metricsKey];
    metrics.queueDepth++;
    const timed = async () => {
      const startedAt = process.hrtime.bigint();
      try {
        return await fn();
      } finally {
        metrics.queueDepth--;
        metrics.completed++;
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        // Rolling window, not an unbounded log -- only the last 500 calls'
        // durations are needed to compute a live p50/p95.
        metrics.durationsMs.push(ms);
        if (metrics.durationsMs.length > 500) metrics.durationsMs.shift();
      }
    };
    const result = this[queueKey].then(timed, timed);
    this[queueKey] = result.then(
      () => {},
      () => {} // one failed statement must never wedge every statement queued after it
    );
    return result;
  }

  _enqueue(fn) {
    return this._enqueueOn('_queue', '_metrics', fn);
  }

  _enqueueRead(fn) {
    return this._enqueueOn('_readQueue', '_readMetrics', fn);
  }

  /** Snapshot for GET /api/system-health -- see routes/systemHealth.js. */
  getQueryMetrics() {
    const summarize = (metrics) => {
      const durations = [...metrics.durationsMs].sort((a, b) => a - b);
      const pct = (p) => (durations.length === 0 ? null : durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]);
      return {
        queueDepth: metrics.queueDepth,
        completed: metrics.completed,
        sampleSize: durations.length,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        maxMs: durations.length ? durations[durations.length - 1] : null,
      };
    };
    return { write: summarize(this._metrics), read: summarize(this._readMetrics) };
  }

  /** Run the schema (idempotent -- CREATE TABLE/VIEW IF NOT EXISTS / OR REPLACE). */
  async init() {
    await this.exec(SCHEMA_SQL);
    // One-time migration for a DB that had rows before snapshot_window
    // existed -- without this, latest_snapshot (now sourced from
    // snapshot_window) would read empty until the next live ingest cycle
    // fills it in, up to an hour away. Only runs when the window is
    // actually empty, so it's a no-op on every boot after the first.
    const [{ c }] = await this.all('SELECT COUNT(*) AS c FROM snapshot_window');
    if (Number(c) === 0) await this.refreshSnapshotWindow();
  }

  /**
   * Folds the WAL into the main .duckdb file, shrinking the window of
   * writes that exist only in the WAL (see docs/issues.md, 2026-09-09 WAL
   * corruption incident). Routed through the same serialized exec queue as
   * everything else, so it can't land mid another write.
   */
  async checkpoint() {
    await this.exec('CHECKPOINT');
  }

  /**
   * Clones the entire live database into a brand-new file at `destPath`,
   * via DuckDB's own engine (ATTACH the destination + COPY FROM DATABASE)
   * rather than an OS-level file copy. This matters on Windows specifically:
   * DuckDB holds an exclusive handle on the live .duckdb file for as long as
   * this connection is open, so a plain fs.copyFile against that path fails
   * with EBUSY (and if it doesn't fail outright, a copy racing DuckDB's own
   * writes can produce a torn/corrupt file) -- see checkpointManager.js.
   * ATTACH+COPY goes through the query engine instead, so it's safe to call
   * on a live, actively-written-to connection.
   */
  async cloneDatabaseTo(destPath) {
    // Stays on the write connection (this.all, not readAll) -- ATTACH is
    // per-connection state, so this PRAGMA check and the ATTACH right after
    // it must run on the SAME connection.
    const [row] = await this.all('PRAGMA database_list');
    const sourceName = row.name;
    const alias = `checkpoint_clone_${Date.now()}`;
    const escapedPath = destPath.replace(/'/g, "''");
    await this.exec(`ATTACH '${escapedPath}' AS ${alias}`);
    try {
      await this.exec(`COPY FROM DATABASE ${sourceName} TO ${alias}`);
    } finally {
      await this.exec(`DETACH ${alias}`);
    }
  }

  exec(sql) {
    return this._enqueue(
      () =>
        new Promise((resolve, reject) => {
          this.conn.exec(sql, (err) => (err ? reject(err) : resolve()));
        })
    );
  }

  run(sql, ...params) {
    return this._enqueue(
      () =>
        new Promise((resolve, reject) => {
          this.conn.run(sql, ...params, (err) => (err ? reject(err) : resolve()));
        })
    );
  }

  /**
   * Write-connection reads only -- a write statement that returns rows
   * (INSERT ... RETURNING) and cloneDatabaseTo's PRAGMA-immediately-before-
   * its-own-ATTACH. Every other read in this file uses readAll() instead.
   */
  all(sql, ...params) {
    return this._enqueue(
      () =>
        new Promise((resolve, reject) => {
          this.conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows.map(sanitizeRow))));
        })
    );
  }

  /** Every true read (SELECT) in this file -- see the constructor comment on why this has its own connection. */
  readAll(sql, ...params) {
    return this._enqueueRead(
      () =>
        new Promise((resolve, reject) => {
          this.readConn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows.map(sanitizeRow))));
        })
    );
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---- symbols ----------------------------------------------------------

  async ensureSymbols(symbols) {
    for (const symbol of symbols) {
      await this.run('INSERT INTO symbols (symbol) VALUES (?) ON CONFLICT (symbol) DO NOTHING', symbol);
    }
  }

  // ---- indicator state (hydration) --------------------------------------

  /** @returns {Promise<Map<string, object>>} symbol -> parsed state object */
  async hydrateIndicatorState() {
    const rows = await this.readAll('SELECT symbol, state FROM indicator_state');
    const map = new Map();
    for (const row of rows) {
      try {
        map.set(row.symbol, JSON.parse(row.state));
      } catch {
        // corrupt row -- symbol cold-starts instead of crashing hydration
      }
    }
    return map;
  }

  async writeIndicatorState(symbol, state, nowIst) {
    await this.run(
      `INSERT INTO indicator_state (symbol, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (symbol) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      symbol,
      JSON.stringify(state),
      nowIst
    );
  }

  // ---- snapshots ----------------------------------------------------------

  async writeOhlcvRow(row) {
    await this.run(
      `INSERT INTO ohlcv_snapshots
         (symbol, ts_ist, actual_ts_ist, open, high, low, close, volume, price_change, price_change_pct, is_manual_entry, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, ts_ist) DO UPDATE SET
         actual_ts_ist = excluded.actual_ts_ist, open = excluded.open, high = excluded.high,
         low = excluded.low, close = excluded.close, volume = excluded.volume,
         price_change = excluded.price_change, price_change_pct = excluded.price_change_pct,
         is_manual_entry = excluded.is_manual_entry, source = excluded.source`,
      row.symbol, row.ts_ist, row.actual_ts_ist, row.open, row.high, row.low, row.close,
      row.volume, row.price_change, row.price_change_pct, row.is_manual_entry ?? false, row.source ?? 'live'
    );
  }

  /**
   * Same shape as writeOhlcvRow, but ON CONFLICT DO NOTHING -- for backfill
   * sources (e.g. the Yahoo Finance historical importer) that must only
   * ever fill in a gap, never overwrite a real live-scraped/broker row
   * that happens to already exist at the same (symbol, ts_ist).
   */
  async writeOhlcvRowIfAbsent(row) {
    await this.run(
      `INSERT INTO ohlcv_snapshots
         (symbol, ts_ist, actual_ts_ist, open, high, low, close, volume, price_change, price_change_pct, is_manual_entry, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, ts_ist) DO NOTHING`,
      row.symbol, row.ts_ist, row.actual_ts_ist, row.open, row.high, row.low, row.close,
      row.volume, row.price_change, row.price_change_pct, row.is_manual_entry ?? false, row.source ?? 'backfill'
    );
  }

  async writeIndicatorRow(row) {
    await this.run(
      `INSERT INTO indicator_snapshots
         (symbol, ts_ist, bb_upper, bb_lower, bb_ma, rsi, macd, macd_signal, macd_hist, atr, ema10, ema30, supertrend_value, supertrend_direction, macd_cross, bb_cross)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, ts_ist) DO UPDATE SET
         bb_upper = excluded.bb_upper, bb_lower = excluded.bb_lower, bb_ma = excluded.bb_ma,
         rsi = excluded.rsi, macd = excluded.macd, macd_signal = excluded.macd_signal, macd_hist = excluded.macd_hist,
         atr = excluded.atr, ema10 = excluded.ema10, ema30 = excluded.ema30,
         supertrend_value = excluded.supertrend_value, supertrend_direction = excluded.supertrend_direction,
         macd_cross = excluded.macd_cross, bb_cross = excluded.bb_cross`,
      row.symbol, row.ts_ist, row.bb_upper, row.bb_lower, row.bb_ma, row.rsi,
      row.macd, row.macd_signal, row.macd_hist, row.atr, row.ema10, row.ema30,
      row.supertrend_value, row.supertrend_direction, row.macd_cross ?? null, row.bb_cross ?? null
    );
  }

  /**
   * Same upsert as writeIndicatorRow, but for many rows in one statement --
   * used by jobs/recalculate.js's full-history replay, where one individual
   * awaited INSERT per historical bar (up to ~1M+ bars across the full
   * Nifty 500 universe once Yahoo backfill has run) was the dominant cost,
   * not the indicator math itself (docs/issues.md-style finding, 2026-09-09).
   * Chunked to keep any single statement's placeholder count reasonable.
   */
  async writeIndicatorRowsBatch(rows) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = [];
      for (const row of chunk) {
        params.push(
          row.symbol, row.ts_ist, row.bb_upper, row.bb_lower, row.bb_ma, row.rsi,
          row.macd, row.macd_signal, row.macd_hist, row.atr, row.ema10, row.ema30,
          row.supertrend_value, row.supertrend_direction, row.macd_cross ?? null, row.bb_cross ?? null
        );
      }
      await this.run(
        `INSERT INTO indicator_snapshots
           (symbol, ts_ist, bb_upper, bb_lower, bb_ma, rsi, macd, macd_signal, macd_hist, atr, ema10, ema30, supertrend_value, supertrend_direction, macd_cross, bb_cross)
         VALUES ${values}
         ON CONFLICT (symbol, ts_ist) DO UPDATE SET
           bb_upper = excluded.bb_upper, bb_lower = excluded.bb_lower, bb_ma = excluded.bb_ma,
           rsi = excluded.rsi, macd = excluded.macd, macd_signal = excluded.macd_signal, macd_hist = excluded.macd_hist,
           atr = excluded.atr, ema10 = excluded.ema10, ema30 = excluded.ema30,
           supertrend_value = excluded.supertrend_value, supertrend_direction = excluded.supertrend_direction,
           macd_cross = excluded.macd_cross, bb_cross = excluded.bb_cross`,
        ...params
      );
    }
  }

  // ---- snapshot_window (bounded "current state" cache, see schema.sql) ----

  async syncSnapshotWindowRow(row) {
    await this.run(
      `INSERT INTO snapshot_window
         (symbol, ts_ist, actual_ts_ist, open, high, low, close, volume, price_change, price_change_pct,
          is_manual_entry, source, bb_upper, bb_lower, bb_ma, rsi, macd, macd_signal, macd_hist, atr,
          ema10, ema30, supertrend_value, supertrend_direction, macd_cross, bb_cross)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, ts_ist) DO UPDATE SET
         actual_ts_ist = excluded.actual_ts_ist, open = excluded.open, high = excluded.high,
         low = excluded.low, close = excluded.close, volume = excluded.volume,
         price_change = excluded.price_change, price_change_pct = excluded.price_change_pct,
         is_manual_entry = excluded.is_manual_entry, source = excluded.source,
         bb_upper = excluded.bb_upper, bb_lower = excluded.bb_lower, bb_ma = excluded.bb_ma,
         rsi = excluded.rsi, macd = excluded.macd, macd_signal = excluded.macd_signal, macd_hist = excluded.macd_hist,
         atr = excluded.atr, ema10 = excluded.ema10, ema30 = excluded.ema30,
         supertrend_value = excluded.supertrend_value, supertrend_direction = excluded.supertrend_direction,
         macd_cross = excluded.macd_cross, bb_cross = excluded.bb_cross`,
      row.symbol, row.ts_ist, row.actual_ts_ist, row.open, row.high, row.low, row.close, row.volume,
      row.price_change, row.price_change_pct, row.is_manual_entry ?? false, row.source ?? 'live',
      row.bb_upper, row.bb_lower, row.bb_ma, row.rsi, row.macd, row.macd_signal, row.macd_hist, row.atr,
      row.ema10, row.ema30, row.supertrend_value, row.supertrend_direction, row.macd_cross ?? null, row.bb_cross ?? null
    );
    // Prune this symbol back down to the newest SNAPSHOT_WINDOW_SIZE rows --
    // one INSERT above (or UPDATE, on a same-slot re-ingest) never adds more
    // than one row per symbol, so this only ever has at most one row to
    // evict.
    await this.run(
      `DELETE FROM snapshot_window
       WHERE symbol = ? AND ts_ist NOT IN (
         SELECT ts_ist FROM snapshot_window WHERE symbol = ? ORDER BY ts_ist DESC LIMIT ?
       )`,
      row.symbol, row.symbol, SNAPSHOT_WINDOW_SIZE
    );
  }

  /**
   * Rebuilds snapshot_window from scratch against current
   * ohlcv_snapshots/indicator_snapshots -- used once at boot if the window
   * is empty (a DB that had rows before this table existed) and again after
   * Recalculate All (jobs/recalculate.js), so a changed indicator parameter
   * shows up immediately rather than waiting for the next live tick to
   * overwrite the window's now-stale cached values.
   */
  async refreshSnapshotWindow() {
    await this.run('DELETE FROM snapshot_window');
    await this.run(
      `INSERT INTO snapshot_window
         (symbol, ts_ist, actual_ts_ist, open, high, low, close, volume, price_change, price_change_pct,
          is_manual_entry, source, bb_upper, bb_lower, bb_ma, rsi, macd, macd_signal, macd_hist, atr,
          ema10, ema30, supertrend_value, supertrend_direction, macd_cross, bb_cross)
       SELECT o.symbol, o.ts_ist, o.actual_ts_ist, o.open, o.high, o.low, o.close, o.volume,
              o.price_change, o.price_change_pct, o.is_manual_entry, o.source,
              i.bb_upper, i.bb_lower, i.bb_ma, i.rsi, i.macd, i.macd_signal, i.macd_hist, i.atr,
              i.ema10, i.ema30, i.supertrend_value, i.supertrend_direction, i.macd_cross, i.bb_cross
       FROM ohlcv_snapshots o
       JOIN indicator_snapshots i USING (symbol, ts_ist)
       QUALIFY ROW_NUMBER() OVER (PARTITION BY o.symbol ORDER BY o.ts_ist DESC) <= ?`,
      SNAPSHOT_WINDOW_SIZE
    );
  }

  async readLatestSnapshot() {
    return this.readAll('SELECT * FROM latest_snapshot ORDER BY symbol');
  }

  async readDashboardSnapshot() {
    return this.readAll('SELECT * FROM dashboard_snapshot ORDER BY symbol');
  }

  /**
   * Each symbol's second-most-recent row in snapshot_window -- the "previous
   * tick" a crosses_above/crosses_below filter condition (filters/conditions.js)
   * needs to detect an edge. Returns a Map keyed by symbol rather than an
   * array since every caller looks rows up per-symbol against a current-row set.
   */
  async readPreviousSnapshotMap() {
    const rows = await this.readAll(
      `SELECT * FROM snapshot_window
       QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts_ist DESC) = 2`
    );
    return new Map(rows.map((r) => [r.symbol, r]));
  }

  /**
   * Each symbol's most-recent row in snapshot_window as of RIGHT NOW --
   * i.e. before the current ingest cycle writes its own row. ingestPipeline
   * uses this to find "the previous slot's close" for deriveNseSlotOhlc.js.
   */
  async readLatestSnapshotMap() {
    const rows = await this.readAll(
      `SELECT * FROM snapshot_window
       QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts_ist DESC) = 1`
    );
    return new Map(rows.map((r) => [r.symbol, r]));
  }

  // ---- nse_day_tracker (raw day-cumulative high/low, see deriveNseSlotOhlc.js) ----

  /** @returns {Promise<Map<string, { raw_high: number, raw_low: number }>>} */
  async readNseDayTracker(symbols, tradeDate) {
    if (symbols.length === 0) return new Map();
    const placeholders = symbols.map(() => '?').join(', ');
    const rows = await this.readAll(
      `SELECT symbol, raw_high, raw_low FROM nse_day_tracker WHERE trade_date = ? AND symbol IN (${placeholders})`,
      tradeDate, ...symbols
    );
    return new Map(rows.map((r) => [r.symbol, r]));
  }

  async writeNseDayTrackerRow(symbol, tradeDate, rawHigh, rawLow) {
    await this.run(
      `INSERT INTO nse_day_tracker (symbol, trade_date, raw_high, raw_low)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (symbol, trade_date) DO UPDATE SET raw_high = excluded.raw_high, raw_low = excluded.raw_low`,
      symbol, tradeDate, rawHigh, rawLow
    );
  }

  /**
   * Overwrites a live-NSE-derived row's OHLCV with the real values once
   * Yahoo Finance has settled that hour (jobs/reconcileNseSlot.js). Scoped
   * to source = 'live-nse' so it can never touch a broker/manual/backfill
   * row, even if called with a stale/mistaken (symbol, ts_ist). Propagates
   * to snapshot_window too when that row is still in the window (it always
   * will be 30 minutes later, given the window holds the last 60 slots).
   */
  async reconcileOhlcvRow(symbol, tsIst, { open, high, low, close, volume }) {
    const priceChange = close - open;
    const priceChangePct = open !== 0 ? (priceChange / open) * 100 : 0;
    const result = await this.all(
      `UPDATE ohlcv_snapshots SET open = ?, high = ?, low = ?, close = ?, volume = ?,
         price_change = ?, price_change_pct = ?
       WHERE symbol = ? AND ts_ist = ? AND source = 'live-nse'
       RETURNING symbol`,
      open, high, low, close, volume, priceChange, priceChangePct, symbol, tsIst
    );
    if (result.length === 0) return false;
    await this.run(
      `UPDATE snapshot_window SET open = ?, high = ?, low = ?, close = ?, volume = ?,
         price_change = ?, price_change_pct = ?
       WHERE symbol = ? AND ts_ist = ? AND source = 'live-nse'`,
      open, high, low, close, volume, priceChange, priceChangePct, symbol, tsIst
    );
    return true;
  }

  // ---- ingestion / missing-symbol logs ------------------------------------

  async writeIngestionLog(entry) {
    const rows = await this.all(
      `INSERT INTO ingestion_log
         (scheduled_ts_ist, file_name, ingested_at_ist, row_count, expected_row_count, missing_symbol_count, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      entry.scheduled_ts_ist, entry.file_name, entry.ingested_at_ist, entry.row_count,
      entry.expected_row_count, entry.missing_symbol_count ?? 0, entry.status, entry.error_message ?? null
    );
    return rows[0]?.id;
  }

  async writeMissingSymbolLog(ingestionLogId, tsIst, symbols) {
    for (const symbol of symbols) {
      await this.run(
        'INSERT INTO missing_symbol_log (ingestion_log_id, symbol, ts_ist) VALUES (?, ?, ?)',
        ingestionLogId, symbol, tsIst
      );
    }
  }

  async readMonitorLog(limit = 20) {
    return this.readAll('SELECT * FROM ingestion_log ORDER BY id DESC LIMIT ?', limit);
  }

  /** Ingestion log entries with their missing-symbol detail attached (docs/component_design.md §6). */
  async readMonitorLogWithMissing(limit = 20) {
    const entries = await this.readMonitorLog(limit);
    if (entries.length === 0) return [];
    const ids = entries.map((e) => e.id);
    const placeholders = ids.map(() => '?').join(', ');
    const missingRows = await this.readAll(
      `SELECT ingestion_log_id, symbol FROM missing_symbol_log WHERE ingestion_log_id IN (${placeholders})`,
      ...ids
    );
    const byLogId = new Map();
    for (const row of missingRows) {
      if (!byLogId.has(row.ingestion_log_id)) byLogId.set(row.ingestion_log_id, []);
      byLogId.get(row.ingestion_log_id).push(row.symbol);
    }
    return entries.map((e) => ({ ...e, missingSymbols: byLogId.get(e.id) ?? [] }));
  }

  // ---- filters / membership log --------------------------------------------

  async readActiveFilters() {
    return this.readAll('SELECT * FROM filters WHERE is_active = TRUE');
  }

  async writeMembershipLog(entries) {
    for (const e of entries) {
      await this.run(
        'INSERT INTO filter_membership_log (filter_id, symbol, action, ts_ist) VALUES (?, ?, ?, ?)',
        e.filterId, e.symbol, e.action, e.ts_ist
      );
    }
  }

  async readMembershipLog(filterId, limit = 50) {
    if (filterId) {
      return this.readAll(
        'SELECT * FROM filter_membership_log WHERE filter_id = ? ORDER BY id DESC LIMIT ?',
        filterId, limit
      );
    }
    return this.readAll('SELECT * FROM filter_membership_log ORDER BY id DESC LIMIT ?', limit);
  }

  // ---- settings -------------------------------------------------------------

  async readSetting(key) {
    const rows = await this.readAll('SELECT value FROM settings WHERE key = ?', key);
    return rows[0] ? JSON.parse(rows[0].value) : undefined;
  }

  async readAllSettings() {
    const rows = await this.readAll('SELECT key, value FROM settings');
    const out = {};
    for (const row of rows) out[row.key] = JSON.parse(row.value);
    return out;
  }

  async writeSetting(key, value, nowIst) {
    await this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, JSON.stringify(value), nowIst
    );
  }

  // ---- symbol classification / super filter -----------------------------------

  async upsertSymbolClassification(indexType, symbols, sourceFile, nowIst) {
    const column = { nifty50: 'is_nifty50', banknifty: 'is_banknifty', fno: 'is_fno_eligible', nifty500: 'is_nifty500', emerge: 'is_emerge' }[indexType];
    const updatedAtColumn = {
      nifty50: 'nifty50_updated_at', banknifty: 'banknifty_updated_at', fno: 'fno_updated_at',
      nifty500: 'nifty500_updated_at', emerge: 'emerge_updated_at',
    }[indexType];
    if (!column) throw new Error(`Unknown indexType: ${indexType}`);
    // A fresh upload replaces membership for that index entirely -- otherwise
    // a symbol dropped from this year's Nifty 50 list would stay flagged
    // forever since upsert only ever sets the column TRUE, never FALSE. Only
    // THIS classification's own updated_at moves -- a symbol's other
    // classifications (e.g. F&O-eligible) must not appear "updated" just
    // because it also happens to be in this upload.
    await this.run(`UPDATE symbol_classification SET ${column} = FALSE`);
    for (const symbol of symbols) {
      await this.run(
        `INSERT INTO symbol_classification (symbol, ${column}, source_file, updated_at, ${updatedAtColumn})
         VALUES (?, TRUE, ?, ?, ?)
         ON CONFLICT (symbol) DO UPDATE SET
           ${column} = TRUE, source_file = excluded.source_file, updated_at = excluded.updated_at,
           ${updatedAtColumn} = excluded.${updatedAtColumn}`,
        symbol, sourceFile, nowIst, nowIst
      );
    }
  }

  /** @returns {Promise<Map<string, {is_nifty50: boolean, is_banknifty: boolean, is_fno_eligible: boolean}>>} */
  async readClassificationMap() {
    const rows = await this.readAll('SELECT * FROM symbol_classification');
    return new Map(rows.map((r) => [r.symbol, r]));
  }

  /** Alphabetical symbol list for a classification column -- backs the Position Calculator's ticker autocomplete. */
  async readSymbolsForClassification(column) {
    const rows = await this.readAll(`SELECT symbol FROM symbol_classification WHERE ${column} = TRUE ORDER BY symbol`);
    return rows.map((r) => r.symbol);
  }

  async readAllSymbols() {
    const rows = await this.readAll('SELECT symbol FROM symbols ORDER BY symbol');
    return rows.map((r) => r.symbol);
  }

  async readClassificationStatus() {
    // Each classification's "last updated" comes from its OWN column, not
    // a shared row-level one -- see schema.sql's comment on
    // symbol_classification. MAX(...) still collapses to "the most recent
    // upload/auto-derivation for this classification, across every symbol
    // that carries it" (unchanged behavior), it just no longer picks up
    // timestamps from unrelated classifications' uploads.
    const rows = await this.readAll(
      `SELECT
         SUM(CASE WHEN is_nifty50 THEN 1 ELSE 0 END) AS nifty50_count,
         MAX(nifty50_updated_at) AS nifty50_updated_at,
         SUM(CASE WHEN is_banknifty THEN 1 ELSE 0 END) AS banknifty_count,
         MAX(banknifty_updated_at) AS banknifty_updated_at,
         SUM(CASE WHEN is_fno_eligible THEN 1 ELSE 0 END) AS fno_count,
         MAX(fno_updated_at) AS fno_updated_at,
         SUM(CASE WHEN is_emerge THEN 1 ELSE 0 END) AS emerge_count,
         MAX(emerge_updated_at) AS emerge_updated_at,
         SUM(CASE WHEN is_nifty500 THEN 1 ELSE 0 END) AS nifty500_count,
         MAX(nifty500_updated_at) AS nifty500_updated_at
       FROM symbol_classification`
    );
    const r = rows[0] ?? {};
    return {
      nifty50: { count: r.nifty50_count ?? 0, updatedAt: r.nifty50_updated_at ?? null },
      banknifty: { count: r.banknifty_count ?? 0, updatedAt: r.banknifty_updated_at ?? null },
      fno: { count: r.fno_count ?? 0, updatedAt: r.fno_updated_at ?? null },
      emerge: { count: r.emerge_count ?? 0, updatedAt: r.emerge_updated_at ?? null },
      nifty500: { count: r.nifty500_count ?? 0, updatedAt: r.nifty500_updated_at ?? null },
    };
  }

  // ---- data sources -----------------------------------------------------

  async readDataSources() {
    return this.readAll('SELECT * FROM data_sources ORDER BY label');
  }

  async upsertDataSource(source) {
    await this.run(
      `INSERT INTO data_sources (id, label, url, expected_filename_pattern, is_active, last_fetched_at_ist, last_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label, url = excluded.url,
         expected_filename_pattern = excluded.expected_filename_pattern,
         is_active = excluded.is_active`,
      source.id, source.label, source.url, source.expectedFilenamePattern ?? null,
      source.isActive ?? true, source.lastFetchedAtIst ?? null, source.lastStatus ?? null
    );
  }

  async deleteDataSource(id) {
    await this.run('DELETE FROM data_sources WHERE id = ?', id);
  }

  // ---- index snapshots (NSE live indices) --------------------------------

  async writeIndexRow(row) {
    await this.run(
      `INSERT INTO index_snapshots (index_name, ts_ist, value, change, change_pct, is_manual_entry)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (index_name, ts_ist) DO UPDATE SET
         value = excluded.value, change = excluded.change, change_pct = excluded.change_pct,
         is_manual_entry = excluded.is_manual_entry`,
      row.index_name, row.ts_ist, row.value, row.change ?? null, row.change_pct ?? null, row.is_manual_entry ?? false
    );
  }

  async readIndexHistory(indexName, limit = 100) {
    return this.readAll(
      'SELECT * FROM index_snapshots WHERE index_name = ? ORDER BY ts_ist DESC LIMIT ?',
      indexName, limit
    );
  }

  // ---- history tab (docs/component_design.md §8) -------------------------

  // ---- recalculate-all (docs/component_design.md §6) --------------------

  async readDistinctSymbolsWithHistory() {
    const rows = await this.readAll('SELECT DISTINCT symbol FROM ohlcv_snapshots ORDER BY symbol');
    return rows.map((r) => r.symbol);
  }

  async countOhlcvRows() {
    const rows = await this.readAll('SELECT COUNT(*) AS n FROM ohlcv_snapshots');
    return rows[0]?.n ?? 0;
  }

  /** A symbol's full bar history, oldest first -- what recalculate replays through the indicator engine. */
  async readOhlcvHistoryForSymbol(symbol) {
    return this.readAll(
      'SELECT symbol, ts_ist, actual_ts_ist, open, high, low, close, volume FROM ohlcv_snapshots WHERE symbol = ? ORDER BY ts_ist',
      symbol
    );
  }

  /**
   * Long-format rows for every distinct scheduled slot, most recent
   * `slotLimit` slots. `superFilter` narrows which SYMBOLS' rows come back
   * (not which slot columns exist) -- each non-'all' value restricts to the
   * matching symbol_classification column ('nifty500' is auto-derived from
   * the regular equity scrape, see scheduler.js; the rest are CSV-uploaded
   * via Settings > Index Classification). 'all' returns every ingested
   * symbol regardless of classification (e.g. the wider pre-open "ALL" universe).
   */
  /**
   * Reads from snapshot_window, not ohlcv_snapshots -- the History tab only
   * ever shows the most recent `slotLimit` (<= 20) scheduled slots, well
   * within the window's per-symbol depth, and the window never contains
   * Yahoo-backfilled rows in the first place (only ingestPipeline.js syncs
   * it), so this also structurally can't repeat the "backfill timestamps
   * pollute the recent-slots list" class of bug (docs/issues.md, 2026-09-09).
   */
  async readHistoryRows(slotLimit = 20, superFilter = 'nifty500') {
    const slots = await this.readAll(
      'SELECT DISTINCT ts_ist FROM snapshot_window ORDER BY ts_ist DESC LIMIT ?',
      slotLimit
    );
    const tsList = slots.map((s) => s.ts_ist).reverse(); // ascending for display
    if (tsList.length === 0) return { tsList: [], rows: [] };

    const placeholders = tsList.map(() => '?').join(', ');
    const classificationColumn = {
      nifty500: 'is_nifty500', nifty50: 'is_nifty50', banknifty: 'is_banknifty',
      fno: 'is_fno_eligible', emerge: 'is_emerge',
    }[superFilter];
    const symbolFilter = classificationColumn
      ? `AND o.symbol IN (SELECT symbol FROM symbol_classification WHERE ${classificationColumn} = TRUE)`
      : '';
    const rows = await this.readAll(
      `SELECT o.symbol, o.ts_ist, o.open, o.high, o.low, o.close, o.volume
       FROM snapshot_window o
       WHERE o.ts_ist IN (${placeholders}) ${symbolFilter}
       ORDER BY o.symbol, o.ts_ist`,
      ...tsList
    );
    return { tsList, rows };
  }

  // ---- scheduler config (market hours / weekdays) ------------------------

  async readSchedulerConfig() {
    const rows = await this.readAll("SELECT * FROM scheduler_config WHERE key = 'default'");
    const row = rows[0];
    return {
      ...row,
      active_weekdays: typeof row.active_weekdays === 'string' ? JSON.parse(row.active_weekdays) : row.active_weekdays,
      holidays: typeof row.holidays === 'string' ? JSON.parse(row.holidays) : (row.holidays ?? []),
    };
  }

  async writeSchedulerConfig(patch, nowIst) {
    const current = await this.readSchedulerConfig();
    const next = { ...current, ...patch };
    await this.run(
      `UPDATE scheduler_config SET
         interval_minutes = ?, enabled = ?, market_open_time = ?, market_close_time = ?,
         active_weekdays = ?, holidays = ?, premarket_enabled = ?, premarket_run_time = ?,
         min_run_gap_seconds = ?, updated_at = ?
       WHERE key = 'default'`,
      next.interval_minutes, next.enabled, next.market_open_time, next.market_close_time,
      JSON.stringify(next.active_weekdays), JSON.stringify(next.holidays ?? []),
      next.premarket_enabled, next.premarket_run_time, next.min_run_gap_seconds ?? 120, nowIst
    );
  }

  // ---- scraper run log (Settings > System Health) ------------------------

  async startScraperRun(tsIst, startedAtIst) {
    const rows = await this.all(
      `INSERT INTO scraper_run_log (ts_ist, started_at_ist, status, indices_status, equity_status)
       VALUES (?, ?, 'running', 'pending', 'pending') RETURNING id`,
      tsIst, startedAtIst
    );
    return rows[0].id;
  }

  async updateScraperRun(id, patch) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    await this.run(`UPDATE scraper_run_log SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  }

  async readScraperRuns(limit = 5) {
    return this.readAll('SELECT * FROM scraper_run_log ORDER BY id DESC LIMIT ?', limit);
  }

  // ---- manual snapshot timestamp correction (History tab) ----------------

  /** Whether any row already exists at `tsIst` -- guards against silently merging two snapshots together. */
  async snapshotExists(tsIst) {
    const rows = await this.readAll('SELECT 1 FROM ohlcv_snapshots WHERE ts_ist = ? LIMIT 1', tsIst);
    return rows.length > 0;
  }

  /**
   * Renames a scheduled snapshot slot's ts_ist everywhere it's a key --
   * ohlcv/indicator/index snapshots plus the log tables that reference it.
   * `actual_ts_ist` (when the data was really fetched) is untouched; only
   * the scheduled-slot label moves. Caller must have already confirmed
   * `newTsIst` doesn't collide with an existing slot (snapshotExists).
   */
  async renameSnapshotTs(oldTsIst, newTsIst) {
    await this.run('UPDATE ohlcv_snapshots SET ts_ist = ? WHERE ts_ist = ?', newTsIst, oldTsIst);
    await this.run('UPDATE indicator_snapshots SET ts_ist = ? WHERE ts_ist = ?', newTsIst, oldTsIst);
    await this.run('UPDATE snapshot_window SET ts_ist = ? WHERE ts_ist = ?', newTsIst, oldTsIst);
    await this.run('UPDATE index_snapshots SET ts_ist = ? WHERE ts_ist = ?', newTsIst, oldTsIst);
    await this.run('UPDATE ingestion_log SET scheduled_ts_ist = ? WHERE scheduled_ts_ist = ?', newTsIst, oldTsIst);
    await this.run('UPDATE missing_symbol_log SET ts_ist = ? WHERE ts_ist = ?', newTsIst, oldTsIst);
    await this.run('UPDATE scraper_run_log SET ts_ist = ? WHERE ts_ist = ?', newTsIst, oldTsIst);
  }

  // ---- per-symbol chart (History tab candlestick view) -------------------

  async readOhlcSeriesForSymbol(symbol, limit = 200) {
    return this.readAll(
      `SELECT ts_ist, open, high, low, close, volume FROM ohlcv_snapshots
       WHERE symbol = ? ORDER BY ts_ist DESC LIMIT ?`,
      symbol, limit
    ).then((rows) => rows.reverse());
  }

  // ---- trade log (Dashboard > Position Calculator > "Save to Trade Log") -

  async createTradeLogEntry(entry, nowIstStr) {
    const rows = await this.all(
      `INSERT INTO trade_log
         (symbol, side, entry_price, stop_loss_price, target_price, risk_reward_ratio, quantity,
          expected_profit, potential_loss, status, trade_status, trade_entered, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'inactive', FALSE, ?, ?)
       RETURNING id`,
      entry.symbol, entry.side, entry.entryPrice, entry.stopLossPrice, entry.targetPrice,
      entry.riskRewardRatio, entry.quantity, entry.expectedProfit, entry.potentialLoss,
      nowIstStr, nowIstStr
    );
    return rows[0].id;
  }

  async readTradeLog() {
    const rows = await this.readAll(
      `SELECT t.*, p.close AS current_price, p.ts_ist AS current_price_ts_ist
       FROM trade_log t
       LEFT JOIN latest_price_snapshot p USING (symbol)
       ORDER BY t.id DESC`
    );
    // current_pnl is deliberately never stored -- it's only meaningful
    // while a trade is 'active' (an 'inactive' row hasn't entered yet; a
    // 'completed' row already has the real actual_pnl) and it changes
    // every 15-minute price refresh, so it's computed fresh on every read
    // rather than risking a stale stored value.
    for (const row of rows) {
      row.current_pnl =
        row.trade_status === 'active' && typeof row.current_price === 'number'
          ? (row.current_price - row.entry_price) * row.quantity * (row.side === 'long' ? 1 : -1)
          : null;
    }
    return rows;
  }

  async readTradeLogByStatus(status) {
    return this.readAll('SELECT * FROM trade_log WHERE status = ? ORDER BY id', status);
  }

  async updateTradeLogEntry(id, patch, nowIstStr) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    fields.push('updated_at = ?');
    values.push(nowIstStr);
    await this.run(`UPDATE trade_log SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  }

  async deleteTradeLogEntry(id) {
    await this.run('DELETE FROM trade_log WHERE id = ?', id);
  }

  /** Most recent ingested close for a symbol -- the trade-log checker's fallback when no 15-min price exists yet. */
  async readLatestCloseForSymbol(symbol) {
    const rows = await this.readAll(
      'SELECT close, ts_ist FROM ohlcv_snapshots WHERE symbol = ? ORDER BY ts_ist DESC LIMIT 1',
      symbol
    );
    return rows[0] ?? null;
  }

  // ---- latest price snapshot (TradeLogScheduler's own 15-min Nifty 500 --
  // price refresh -- never touches ohlcv_snapshots/indicator_snapshots) ----

  async upsertLatestPrices(rows, tsIst) {
    for (const r of rows) {
      await this.run(
        `INSERT INTO latest_price_snapshot (symbol, close, ts_ist) VALUES (?, ?, ?)
         ON CONFLICT (symbol) DO UPDATE SET close = excluded.close, ts_ist = excluded.ts_ist`,
        r.symbol, r.close, tsIst
      );
    }
  }

  async readLatestPrice(symbol) {
    const rows = await this.readAll('SELECT close, ts_ist FROM latest_price_snapshot WHERE symbol = ?', symbol);
    return rows[0] ?? null;
  }
}
