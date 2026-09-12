/**
 * GET /api/system-health -- backs the System Health tab (same level as
 * Settings). Aggregates: HTTP latency, DB query queue depth/latency, event
 * loop lag, process resources, DB/WAL file health, WebSocket fan-out, and a
 * rollup of the existing ingest-cycle log. Polled from the frontend on an
 * interval (see SystemHealthTab.tsx) -- nothing here is pushed over the
 * WebSocket, since this is operator-facing diagnostics, not market data.
 *
 * Deliberately reuses signals that already exist (ingestion_log,
 * checkpointManager.js's rolling checkpoints) rather than duplicating them --
 * see docs/researchOutput.md, 2026-09-09 load audit.
 */
import { config } from '../config.js';
import { httpLatency, eventLoopMetrics, processMetrics, dbFileMetrics } from '../health/metrics.js';
import { getHealthHistory, getThresholdAlerts } from '../health/history.js';

export function registerSystemHealthRoutes(app, ctx) {
  app.get('/api/system-health', async () => {
    const { db, broadcaster, connectionId } = ctx;

    const recentCycles = await db.readMonitorLog(20);
    const ingest = summarizeIngest(recentCycles);

    return {
      generatedAtIst: new Date().toISOString(),
      http: httpLatency.snapshot(),
      db: db.getQueryMetrics(),
      eventLoop: eventLoopMetrics(),
      process: processMetrics(),
      dbFile: dbFileMetrics({ dbPath: config.dbPath, checkpointsDir: config.checkpointsDir, connectionId }),
      websocket: { connectedClients: broadcaster.clients.size },
      ingest,
      history: getHealthHistory(),
      alerts: mergeAlerts(getThresholdAlerts(), recentCycles),
    };
  });
}

/**
 * Two alert sources, merged newest-first: (1) process/DB threshold breaches
 * (health/history.js, in-memory, resets on restart) and (2) real ingest
 * cycle failures/partials straight from `ingestion_log` (DB-persisted, so
 * these survive a restart -- a genuine data-pipeline failure shouldn't
 * disappear from the log just because the server happened to restart).
 */
function mergeAlerts(thresholdAlerts, recentCycles) {
  const ingestAlerts = recentCycles
    .filter((c) => c.status !== 'ok')
    .map((c) => ({
      id: `ingest-${c.id}`,
      source: 'ingest',
      severity: c.status === 'failed' ? 'bad' : 'warn',
      label: c.status === 'failed' ? 'Ingest cycle failed' : 'Ingest cycle partial',
      message: c.error_message || (c.missing_symbol_count ? `${c.missing_symbol_count} missing symbol(s)` : 'see Settings > Scraper Runs'),
      startedAtIst: c.scheduled_ts_ist,
      endedAtIst: c.scheduled_ts_ist,
    }));
  return [...thresholdAlerts, ...ingestAlerts]
    .sort((a, b) => (a.startedAtIst < b.startedAtIst ? 1 : a.startedAtIst > b.startedAtIst ? -1 : 0))
    .slice(0, 30);
}

function summarizeIngest(cycles) {
  if (cycles.length === 0) return { recentCycles: 0, successRate: null, avgMissingSymbols: null, lastCycle: null };
  const ok = cycles.filter((c) => c.status === 'ok').length;
  const totalMissing = cycles.reduce((sum, c) => sum + (c.missing_symbol_count ?? 0), 0);
  return {
    recentCycles: cycles.length,
    successRate: round1((ok / cycles.length) * 100),
    avgMissingSymbols: round1(totalMissing / cycles.length),
    lastCycle: {
      scheduledTsIst: cycles[0].scheduled_ts_ist,
      status: cycles[0].status,
      rowCount: cycles[0].row_count,
      missingSymbolCount: cycles[0].missing_symbol_count,
    },
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
