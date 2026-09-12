/**
 * Points every path config.js reads at a private temp directory, so a test
 * run can never read or write the real project's data/ directory (or, worse,
 * collide with a real dev server running at the same time). See
 * docs/issues.md, 2026-09-09: a missing SW_REGISTRY_PATH override here is
 * exactly what let tests corrupt the real registry file previously.
 */
import path from 'node:path';

export function setTestEnv(dir) {
  const dbPath = path.join(dir, 'test.duckdb');
  const registryPath = path.join(dir, 'data-connections.json');
  const sourcesDir = path.join(dir, 'sources');
  const checkpointsDir = path.join(dir, 'checkpoints');
  const logsDir = path.join(dir, 'logs');

  process.env.SW_DB_PATH = dbPath;
  process.env.SW_REGISTRY_PATH = registryPath;
  process.env.SW_SOURCES_DIR = sourcesDir;
  process.env.SW_CHECKPOINTS_DIR = checkpointsDir;
  process.env.SW_LOGS_DIR = logsDir;
  process.env.PORT = '0';

  return { dbPath, registryPath, sourcesDir, checkpointsDir, logsDir };
}
