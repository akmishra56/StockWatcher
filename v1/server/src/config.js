import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

export const config = {
  port: Number(process.env.PORT ?? 4100),
  dbPath: process.env.SW_DB_PATH ?? path.join(ROOT, 'data', 'watchlist.duckdb'),
  // Connection registry (docs/architecture.md §2b): which data-source
  // connections exist and which is active. sourcesDir is where a
  // newly-added (non-built-in) connection's DB file is created. v1 only
  // ever has one built-in connection (Yahoo Finance), but the registry
  // machinery is generic and unchanged from v2.
  registryPath: process.env.SW_REGISTRY_PATH ?? path.join(ROOT, 'data', 'data-connections.json'),
  sourcesDir: process.env.SW_SOURCES_DIR ?? path.join(ROOT, 'data', 'sources'),
  // Rolling DB checkpoints taken after every scheduled run -- see
  // checkpointManager.js.
  checkpointsDir: process.env.SW_CHECKPOINTS_DIR ?? path.join(ROOT, 'data', 'checkpoints'),
  // Plain-text mirror of filter_membership_log (DB table) -- see
  // logging/membershipLogFile.js.
  logsDir: process.env.SW_LOGS_DIR ?? path.join(ROOT, 'logs'),
  // v1's scheduler polls Yahoo Finance hourly (matching Yahoo's own hourly
  // candle grid for NSE symbols), not every 15 minutes -- see scheduler.js.
  defaultIntervalMinutes: 60,
  // Local HTTPS (mkcert-issued cert -- see README "Local HTTPS"). Optional:
  // server.js falls back to plain HTTP if these files don't exist, so a
  // machine without mkcert set up (CI, a fresh clone) still boots fine.
  tlsKeyPath: process.env.SW_TLS_KEY_PATH ?? path.join(ROOT, 'certs', 'localhost-key.pem'),
  tlsCertPath: process.env.SW_TLS_CERT_PATH ?? path.join(ROOT, 'certs', 'localhost.pem'),
};
