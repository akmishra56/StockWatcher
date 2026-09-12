# StockWatcher

A local-first application that ingests hourly OHLCV data for the Nifty 50 from Yahoo Finance, computes technical indicators (Bollinger Bands, RSI, MACD, ATR, EMA10/30, Supertrend) in real time, and serves a live browser dashboard styled as a dark, futuristic trading terminal.

Built as a browser-accessible web app (Fastify + DuckDB backend, React/Vite frontend); native desktop support (Tauri) is deferred until the browser app is in daily use.

> **This is v1** — the stable version of StockWatcher, and the only version pushed to this repository. If you've cloned this repo from GitHub, what you have is v1, complete and self-contained.

> **Status:** actively built and running. A scheduler polls Yahoo Finance's unofficial chart API once per hour, per Nifty 50 symbol, timed to fire a few minutes after Yahoo's own ~15-minute-delayed feed has settled a real candle for that hour's slot (e.g. the 10:15 slot is actually fetched at 10:32) -- there is no premarket run and no other data source. A one-time historical backfill from Yahoo Finance seeds the last ~30 days of hourly bars for the Nifty 50 before indicators can be computed on day one. Two top-level tabs (Dashboard, Settings), a live Market Open/Closed indicator, ticker search, saved filters, and a Position Calculator on the Dashboard, local HTTPS (mkcert) end to end, and a backend test suite (`server/test/`, run via `npm test` in `server/`) all exist and are exercised against real data.

## What v1 does

- **Universe: Nifty 50.** The Dashboard tracks exactly these 50 symbols.
- **Data source: Yahoo Finance.** A scheduler polls Yahoo Finance's unofficial chart API directly -- that's the only place data comes from.
- **Cadence: hourly.** Slots are anchored to market open (09:15 IST by default) at a 60-minute interval, matching Yahoo's own hourly candle boundaries for NSE symbols, each fetched a few minutes after the slot time so Yahoo's own delayed feed has settled a real candle for it.
- **Two tabs: Dashboard and Settings.** The Dashboard shows the live watchlist table, saved filters, ticker search, and a Position Calculator; Settings covers indicator parameters, color rules, data & recalculate, the monitor log, automation & scheduling, and index classification.
- **Recent data.** The initial backfill covers roughly the last 30 days as a one-time seeding scope for the backfill job.
- **Its own database, its own ports.** Fully self-contained -- see "Getting started" below.

## Disclaimer

StockWatcher is provided for **educational and informational purposes only**. Nothing shown in this application — prices, indicators, filters, alerts, or any other output — constitutes financial, investment, or trading advice, or a recommendation to buy, sell, or hold any security or financial instrument.

Trading and investing in equities, derivatives, and other financial instruments carries substantial risk, including the potential loss of your entire capital. Past performance and technical indicators are not reliable indicators of future results.

You should independently evaluate your own financial situation and consult a qualified, SEBI-registered financial advisor before making any investment or trading decision. The creators and operators of this application accept no liability for any loss or damage arising from reliance on the data or tools provided here.

This same disclaimer is shown as a popup every time the app is opened, and is always reachable afterward via the "Disclaimer" link next to the Settings tab (`v1/web/src/components/Disclaimer/DisclaimerModal.tsx`).

## Project structure

```
StockWatcher/
├── v1/                 # this version -- the only one pushed to git
│   ├── server/         # Node.js + Fastify backend -- ingest, indicators, filters, REST + WS API
│   │   ├── src/
│   │   │   ├── datasource/yahooChart.js  # Yahoo Finance unofficial chart API client
│   │   │   ├── db/              # DuckDB schema + DbClient (read/write-connection split)
│   │   │   ├── indicators/      # Bollinger/RSI/MACD/ATR/EMA/Supertrend, incremental
│   │   │   ├── ingest/           # Pipeline orchestration
│   │   │   ├── jobs/              # Background jobs: recalculate, Yahoo historical backfill
│   │   │   ├── logging/            # Plain-text mirror of DB logs (e.g. filter membership) to logs/
│   │   │   ├── routes/            # REST endpoints, one file per resource
│   │   │   ├── scheduler.js        # Hourly Yahoo Finance poll orchestration
│   │   │   └── server.js           # Boot sequence
│   │   └── test/            # node:test suite -- run with `npm test`
│   ├── web/                # React (Vite) + TypeScript frontend
│   │   └── src/components/  # Dashboard, Settings
│   ├── data/               # watchlist.duckdb + checkpoints (git-ignored)
│   ├── logs/               # membership_log.log (git-ignored)
│   ├── certs/              # local mkcert TLS cert (git-ignored, see "Local HTTPS" below)
│   └── requirements.txt    # environment/package manifest for porting to another machine
├── docs/               # planning docs (git-ignored)
├── run_summary.md      # end-of-session change log
├── LICENSE.md
└── README.md
```

## Getting started

Two processes, run separately:

**Backend** (`v1/server/`):
```
npm install
npm run dev     # node src/server.js -- listens on :4100 by default
```
Config is environment-driven with sensible defaults (`v1/server/src/config.js`) -- `PORT`, `SW_DB_PATH`, `SW_REGISTRY_PATH`, `SW_SOURCES_DIR`, `SW_CHECKPOINTS_DIR`, `SW_LOGS_DIR`, `SW_TLS_KEY_PATH`, `SW_TLS_CERT_PATH` -- none need to be set for local development. (`npm install` at the repo root also works -- the root `package.json`'s workspaces point at `v1/server` and `v1/web`.)

**Frontend** (`v1/web/`):
```
npm install
npm run dev     # vite -- listens on :5273, proxies /api and /ws to :4100
```

**Tests** (`v1/server/`):
```
npm test         # node --test
```

Once both are running, open `https://localhost:5273` (or `http://localhost:5273` if you skipped "Local HTTPS" below). Before the Dashboard shows anything, the database needs seeding once:

1. **Settings > Index Classification** -- upload a Nifty 50 symbol-list CSV (a plain symbol list, or a full NSE market-watch export -- only the SYMBOL column is used).
2. `POST /api/backfill/yahoo-history` with `{"universe":"nifty50","fromDate":"<~30 days ago>"}` -- fills the last ~30 days of hourly history for those 50 symbols from Yahoo Finance. There's no UI button for this yet; call it directly (e.g. with `curl`).
3. `POST /api/settings/recalculate` (Settings > Data & Recalculate has a button for this) -- computes indicators over the newly-backfilled history.

After that, the hourly scheduler (Settings > Automation & Scheduler) keeps the Dashboard current on its own during market hours.

## Local HTTPS

Both dev servers can serve over HTTPS using a locally-trusted cert from [mkcert](https://github.com/FiloSottile/mkcert) -- optional, and only affects the two localhost dev servers (the one external connection this app makes, to Yahoo Finance, is already `https://` regardless). Skipped entirely if the cert files aren't present: both `server.js` and `vite.config.ts` fall back to plain HTTP/WS automatically, so this step can be skipped on a fresh clone or in CI.

1. Install mkcert (e.g. `choco install mkcert` on Windows with an elevated shell, `brew install mkcert` on macOS, or grab a binary release directly from the project) and run `mkcert -install` once -- this creates and trusts a local CA in your OS/browser trust store, so the browser shows no warnings.
2. Generate a cert into `v1/certs/` (git-ignored, machine-specific):
   ```
   mkdir certs
   cd certs
   mkcert -key-file localhost-key.pem -cert-file localhost.pem localhost 127.0.0.1 ::1
   ```
3. Start both dev servers as usual -- `server.js` detects `certs/localhost-key.pem`/`certs/localhost.pem` (or `SW_TLS_KEY_PATH`/`SW_TLS_CERT_PATH` if overridden) and serves HTTPS on `:4100`; Vite does the same for `:5273` and proxies `/api`/`/ws` to the backend as `https://`/`wss://`. The frontend's WebSocket connection auto-upgrades to `wss://` based on the page's own protocol, so no separate configuration is needed there.

To force plain HTTP on the frontend even with certs present (e.g. right after generating a cert but before restarting the backend to match), run `SW_DEV_HTTPS=0 npm run dev` in `v1/web/`.

## License

MIT — see [LICENSE.md](LICENSE.md).
