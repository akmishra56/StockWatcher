-- StockWatcher DuckDB schema
-- Matches docs/erd.md. Idempotent — safe to run against an existing database.

CREATE TABLE IF NOT EXISTS symbols (
    symbol TEXT PRIMARY KEY,
    display_name TEXT
);

CREATE TABLE IF NOT EXISTS ohlcv_snapshots (
    symbol TEXT NOT NULL,
    ts_ist TEXT NOT NULL,          -- scheduled cycle slot, IST wall-clock 'YYYY-MM-DD HH:MM:SS'
    actual_ts_ist TEXT NOT NULL,   -- when this row was actually ingested, IST
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    close DOUBLE,
    volume BIGINT,
    price_change DOUBLE,
    price_change_pct DOUBLE,
    is_manual_entry BOOLEAN DEFAULT FALSE,
    source TEXT DEFAULT 'live',    -- 'live-nse' (derived per-slot bar, see ingest/deriveNseSlotOhlc.js -- reconciled later against Yahoo) | 'live-broker' (real bar from a broker connection) | 'manual' | 'yahoo-backfill'
    PRIMARY KEY (symbol, ts_ist)
);
ALTER TABLE ohlcv_snapshots ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'live';

CREATE TABLE IF NOT EXISTS indicator_snapshots (
    symbol TEXT NOT NULL,
    ts_ist TEXT NOT NULL,
    bb_upper DOUBLE,
    bb_lower DOUBLE,
    bb_ma DOUBLE,
    rsi DOUBLE,
    macd DOUBLE,
    macd_signal DOUBLE,
    macd_hist DOUBLE,
    atr DOUBLE,
    ema10 DOUBLE,
    ema30 DOUBLE,
    supertrend_value DOUBLE,
    supertrend_direction TEXT,     -- 'up' | 'down'
    macd_cross TEXT,                -- 'bullish' | 'bearish' | NULL -- edge-triggered, true only on the crossing tick
    bb_cross TEXT,                   -- 'upper' | 'lower' | NULL -- edge-triggered, true only on the crossing tick
    PRIMARY KEY (symbol, ts_ist)
);
ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS macd_cross TEXT;
ALTER TABLE indicator_snapshots ADD COLUMN IF NOT EXISTS bb_cross TEXT;

-- Not time-series: one row per symbol, overwritten every cycle.
-- Exists purely for O(1) hydration on boot (docs/development_plan.md §3).
CREATE TABLE IF NOT EXISTS indicator_state (
    symbol TEXT PRIMARY KEY,
    state JSON,
    updated_at TEXT
);

-- Nifty 50 / BankNifty / F&O-eligible membership, from admin CSV uploads.
-- Drives the dashboard's "super filter" (docs/erd.md).
-- Each classification has its OWN updated_at column, not one shared per-row
-- column -- a symbol can belong to several indices at once (e.g. Nifty 50
-- *and* F&O-eligible), and a single shared `updated_at` meant uploading one
-- classification silently bumped the *displayed* "last updated" timestamp
-- for every other classification that symbol also happened to carry, even
-- though their own TRUE/FALSE membership was untouched (docs/issues.md).
CREATE TABLE IF NOT EXISTS symbol_classification (
    symbol TEXT PRIMARY KEY,
    is_nifty50 BOOLEAN DEFAULT FALSE,
    is_banknifty BOOLEAN DEFAULT FALSE,
    is_fno_eligible BOOLEAN DEFAULT FALSE,
    is_nifty500 BOOLEAN DEFAULT FALSE,   -- auto-derived from every regular (non-premarket) equity scrape, not CSV-uploaded -- that page only ever returns the Nifty 500 list, so it's authoritative. Backs the History tab's Nifty 500 / All super filter.
    is_emerge BOOLEAN DEFAULT FALSE,     -- SME/Emerge platform membership, CSV-uploaded like nifty50/banknifty/fno
    source_file TEXT,
    updated_at TEXT,                     -- kept for backward compat / row-level "any activity" use; superseded by the per-classification columns below for display
    nifty50_updated_at TEXT,
    banknifty_updated_at TEXT,
    fno_updated_at TEXT,
    nifty500_updated_at TEXT,
    emerge_updated_at TEXT
);
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS is_nifty500 BOOLEAN DEFAULT FALSE;
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS is_emerge BOOLEAN DEFAULT FALSE;
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS nifty50_updated_at TEXT;
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS banknifty_updated_at TEXT;
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS fno_updated_at TEXT;
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS nifty500_updated_at TEXT;
ALTER TABLE symbol_classification ADD COLUMN IF NOT EXISTS emerge_updated_at TEXT;

-- One row per indicator's parameter set, one for colorRules, one for the
-- active super-filter selection -- JSON per key so new params/operators
-- never require a migration.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSON,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS filters (
    id TEXT PRIMARY KEY,
    name TEXT,
    condition_json JSON,           -- flat AND/OR tree, v1
    is_active BOOLEAN DEFAULT TRUE,
    created_at TEXT
);

CREATE SEQUENCE IF NOT EXISTS filter_membership_log_id_seq;
CREATE TABLE IF NOT EXISTS filter_membership_log (
    id INTEGER PRIMARY KEY DEFAULT nextval('filter_membership_log_id_seq'),
    filter_id TEXT,
    symbol TEXT,
    action TEXT,                   -- 'added' | 'removed'
    ts_ist TEXT
);

CREATE SEQUENCE IF NOT EXISTS ingestion_log_id_seq;
CREATE TABLE IF NOT EXISTS ingestion_log (
    id INTEGER PRIMARY KEY DEFAULT nextval('ingestion_log_id_seq'),
    scheduled_ts_ist TEXT,
    file_name TEXT,
    ingested_at_ist TEXT,
    row_count INTEGER,
    expected_row_count INTEGER,
    missing_symbol_count INTEGER DEFAULT 0,
    status TEXT,                   -- 'ok' | 'partial' | 'failed'
    error_message TEXT
);

CREATE SEQUENCE IF NOT EXISTS missing_symbol_log_id_seq;
CREATE TABLE IF NOT EXISTS missing_symbol_log (
    id INTEGER PRIMARY KEY DEFAULT nextval('missing_symbol_log_id_seq'),
    ingestion_log_id INTEGER,
    symbol TEXT,
    ts_ist TEXT
);

CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY,
    label TEXT,
    url TEXT,
    expected_filename_pattern TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_fetched_at_ist TEXT,
    last_status TEXT
);

-- Singleton row, key = 'default'.
CREATE TABLE IF NOT EXISTS scheduler_config (
    key TEXT PRIMARY KEY,
    interval_minutes INTEGER DEFAULT 15,
    enabled BOOLEAN DEFAULT TRUE,
    next_run_at_ist TEXT,
    last_run_at_ist TEXT,
    market_open_time TEXT DEFAULT '09:15',   -- HH:mm, IST wall-clock
    market_close_time TEXT DEFAULT '15:45',  -- HH:mm, IST wall-clock
    active_weekdays JSON DEFAULT '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":false,"sun":false}',
    holidays JSON DEFAULT '[]',                    -- ['YYYY-MM-DD', ...] NSE trading holidays; scheduler + premarket run both skip these
    premarket_enabled BOOLEAN DEFAULT TRUE,
    premarket_run_time TEXT DEFAULT '09:10',       -- fires one full scrape+ingest cycle before market open, outside the interval-slot mechanism
    min_run_gap_seconds INTEGER DEFAULT 120,       -- floor enforced by scrapeQueue.js between the end of one run and the start of the next; NSE Playwright needs real spacing (120s default), a future broker API/webhook connection can safely use much less (e.g. 60s) -- per-connection since each connection has its own scheduler_config
    updated_at TEXT
);
INSERT INTO scheduler_config (key) VALUES ('default') ON CONFLICT (key) DO NOTHING;

-- One row per orchestrated scrape+ingest attempt -- backs the Settings >
-- System Health traffic-light panel. 'running' while in progress so the
-- panel can show yellow; indices_status/equity_status track each of the
-- two downloads separately since one can fail while the other succeeds.
CREATE SEQUENCE IF NOT EXISTS scraper_run_log_id_seq;
CREATE TABLE IF NOT EXISTS scraper_run_log (
    id INTEGER PRIMARY KEY DEFAULT nextval('scraper_run_log_id_seq'),
    ts_ist TEXT,                   -- scheduled cycle slot this run was for
    started_at_ist TEXT,
    finished_at_ist TEXT,
    status TEXT,                   -- 'running' | 'success' | 'failed'
    indices_status TEXT,           -- 'pending' | 'ok' | 'failed'
    equity_status TEXT,            -- 'pending' | 'ok' | 'failed'
    error_message TEXT
);

-- CREATE TABLE IF NOT EXISTS only covers a brand-new database; a database
-- created before these columns existed needs them added explicitly, or an
-- already-running install would never pick up the new scheduler fields.
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS market_open_time TEXT DEFAULT '09:15';
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS market_close_time TEXT DEFAULT '15:45';
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS active_weekdays JSON DEFAULT '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":false,"sun":false}';
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS holidays JSON DEFAULT '[]';
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS premarket_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS premarket_run_time TEXT DEFAULT '09:10';
ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS min_run_gap_seconds INTEGER DEFAULT 120;

-- Saved position calculations (Dashboard > Position Calculator > "Save to
-- Trade Log") plus their live-tracked outcome, driven by tradeLogScheduler.js
-- (docs/architecture.md). `status` is the row's own lifecycle ('new' while
-- being tracked, 'closed' once the trade completes); `trade_status` is the
-- position's market state within that ('inactive' -> 'active' -> 'completed').
-- `trade_entered` is a separate, user-controlled toggle (did the user
-- actually place this trade for real) -- the scheduler never touches it.
CREATE SEQUENCE IF NOT EXISTS trade_log_id_seq;
CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY DEFAULT nextval('trade_log_id_seq'),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,                    -- 'long' | 'short'
    entry_price DOUBLE NOT NULL,
    stop_loss_price DOUBLE NOT NULL,
    target_price DOUBLE NOT NULL,
    risk_reward_ratio DOUBLE NOT NULL,
    quantity DOUBLE NOT NULL DEFAULT 1,
    expected_profit DOUBLE,                -- fixed at save time (reward/share * quantity)
    potential_loss DOUBLE,                 -- fixed at save time (risk/share * quantity)
    status TEXT NOT NULL DEFAULT 'new',    -- 'new' | 'closed'
    trade_status TEXT NOT NULL DEFAULT 'inactive', -- 'inactive' | 'active' | 'completed'
    trade_entered BOOLEAN NOT NULL DEFAULT FALSE,
    exit_price DOUBLE,
    actual_pnl DOUBLE,
    comments TEXT,                         -- free-text, max 500 chars (enforced in routes/tradeLog.js)
    before_chart_path TEXT,                -- TradingView screenshot filename, captured/uploaded when trade_status -> 'active'
    after_chart_path TEXT,                 -- ditto, when trade_status -> 'completed'
    created_at TEXT,
    updated_at TEXT
);
ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS comments TEXT;
ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS before_chart_path TEXT;
ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS after_chart_path TEXT;

-- Current price per symbol at TradeLogScheduler's own 15-minute cadence
-- (its own Nifty 500 scrape -- see tradeLogScheduler.js) -- deliberately
-- NOT ohlcv_snapshots, which the 1-hour main Scheduler writes and the
-- indicator engine's candles are built from. Only the Trade Log tab's
-- "Current Price" / "Current P&L" columns (and, as of this table's
-- introduction, the trade-log state-machine checks themselves, matching
-- the original "15min timeframe" spec) read this.
CREATE TABLE IF NOT EXISTS latest_price_snapshot (
    symbol TEXT PRIMARY KEY,
    close DOUBLE NOT NULL,
    ts_ist TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_snapshots (
    index_name TEXT NOT NULL,      -- 'NIFTY50' | 'BANKNIFTY' | ...
    ts_ist TEXT NOT NULL,
    value DOUBLE,
    change DOUBLE,
    change_pct DOUBLE,
    is_manual_entry BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (index_name, ts_ist)
);

-- Rolling per-symbol window of already-joined (ohlcv + indicator) rows,
-- bounded at SNAPSHOT_WINDOW_SIZE (client.js) rows per symbol -- generous
-- margin over the largest default indicator lookback (MACD signal ~35,
-- EMA30, Bollinger 20, RSI/ATR 14) and the History tab's own 20-slot
-- maximum. Synced by ingestPipeline.js after every bar it processes
-- (live scrape, broker poll, or manual upload -- never the Yahoo backfill,
-- which intentionally writes only to ohlcv_snapshots and never touches
-- "current state"), and rebuilt wholesale by DbClient.refreshSnapshotWindow
-- after Recalculate All. Exists so latest_snapshot/readHistoryRows below
-- never have to scan the full (now 300K+ and growing) ohlcv_snapshots
-- table just to answer "what's current" -- see docs/researchOutput.md,
-- 2026-09-09 load audit: that scan was measured adding ~250-450ms per
-- Dashboard poll once history grew past a few hundred thousand rows.
-- Tracks the RAW day-cumulative high/low NSE's live equity feed reported
-- for a symbol on its last poll (see ingest/deriveNseSlotOhlc.js) -- NSE's
-- OPEN/HIGH/LOW columns are the day's running stats since market open, not
-- a per-interval candle, so this is what lets the next poll detect "did the
-- day's high/low just move" and derive a real per-slot bar from it. One row
-- per symbol per trading day; naturally resets itself each new date since
-- a new date has no existing row yet.
CREATE TABLE IF NOT EXISTS nse_day_tracker (
    symbol TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    raw_high DOUBLE,
    raw_low DOUBLE,
    PRIMARY KEY (symbol, trade_date)
);

CREATE TABLE IF NOT EXISTS snapshot_window (
    symbol TEXT NOT NULL,
    ts_ist TEXT NOT NULL,
    actual_ts_ist TEXT NOT NULL,
    open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT,
    price_change DOUBLE, price_change_pct DOUBLE,
    is_manual_entry BOOLEAN DEFAULT FALSE,
    source TEXT DEFAULT 'live',
    bb_upper DOUBLE, bb_lower DOUBLE, bb_ma DOUBLE,
    rsi DOUBLE, macd DOUBLE, macd_signal DOUBLE, macd_hist DOUBLE,
    atr DOUBLE, ema10 DOUBLE, ema30 DOUBLE,
    supertrend_value DOUBLE, supertrend_direction TEXT,
    macd_cross TEXT, bb_cross TEXT,
    PRIMARY KEY (symbol, ts_ist)
);

-- One row per symbol, most recent scheduled cycle only, with delay computed
-- on the fly (never stored redundantly -- cheap arithmetic, would go stale).
-- Reads snapshot_window (bounded, already-joined), not the full
-- ohlcv_snapshots/indicator_snapshots tables.
CREATE OR REPLACE VIEW latest_snapshot AS
SELECT
    *,
    date_diff('second', strptime(ts_ist, '%Y-%m-%d %H:%M:%S'),
                         strptime(actual_ts_ist, '%Y-%m-%d %H:%M:%S')) AS delay_seconds
FROM snapshot_window
QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts_ist DESC) = 1;

-- What the dashboard table actually queries -- latest_snapshot narrowed by
-- the active super filter. super_filter is 'all' | 'nifty50' | 'banknifty' | 'fno'.
CREATE OR REPLACE VIEW dashboard_snapshot AS
SELECT s.*
FROM latest_snapshot s
LEFT JOIN symbol_classification c USING (symbol)
WHERE
    CASE (SELECT value::TEXT FROM settings WHERE key = 'super_filter')
        WHEN '"nifty50"'   THEN COALESCE(c.is_nifty50, FALSE)
        WHEN '"banknifty"' THEN COALESCE(c.is_banknifty, FALSE)
        WHEN '"fno"'       THEN COALESCE(c.is_fno_eligible, FALSE)
        WHEN '"emerge"'    THEN COALESCE(c.is_emerge, FALSE)
        WHEN '"nifty500"'  THEN COALESCE(c.is_nifty500, FALSE)
        ELSE TRUE
    END;

-- Watchlists tab (ported from v2, 2026-09-16 -- no news-scraping tables here,
-- v1 doesn't have that feature). Named, collapsible groups of symbols.
CREATE TABLE IF NOT EXISTS watchlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS watchlist_symbols (
    watchlist_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    added_at TEXT,
    PRIMARY KEY (watchlist_id, symbol)
);

-- Price alert ticker (ported from v2, 2026-09-16). User-configured price
-- levels; direction is the crossing edge priceAlerts/engine.js watches for
-- via the same edge-triggered crosses_above/crosses_below semantics
-- filters/conditions.js already implements for saved filters.
CREATE TABLE IF NOT EXISTS price_alerts (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,          -- 'above' | 'below'
    alert_price DOUBLE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TEXT
);

-- One row per detected crossing. An alert shows in the bottom ticker bar for
-- 24h from triggered_at_ist (real wall-clock time), then rolls off into the
-- Settings > Price Alerts log -- ticker vs. log membership is computed at
-- query time (routes/priceAlerts.js), not tracked as a separate state here.
-- current price for both the ticker and the log is joined live from
-- latest_snapshot at read time, never stored on this row.
CREATE SEQUENCE IF NOT EXISTS price_alert_events_id_seq;
CREATE TABLE IF NOT EXISTS price_alert_events (
    id INTEGER PRIMARY KEY DEFAULT nextval('price_alert_events_id_seq'),
    alert_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    alert_price DOUBLE NOT NULL,
    price_after_crossed DOUBLE NOT NULL,
    slot_ts_ist TEXT NOT NULL,
    triggered_at_ist TEXT NOT NULL
);
