/**
 * Process-wide health signals for the System Health tab (see
 * routes/systemHealth.js and docs/researchOutput.md's 2026-09-09 load
 * audit, which this module exists to make live-visible rather than only
 * discoverable by hand-testing with curl). Everything here is cheap,
 * in-memory, and process-local -- there is deliberately no persistence or
 * cross-restart history; this is "how is the process doing right now",
 * not an analytics pipeline.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const HTTP_WINDOW = 500; // last N requests -- enough for a live p50/p95 without unbounded growth

/**
 * HTTP latency ring buffer, fed by a Fastify onResponse hook (server.js).
 * Fastify already computes per-request responseTime for its own pino log
 * line -- this just also keeps a rolling window of it in memory.
 */
class HttpLatencyTracker {
  constructor() {
    this._durationsMs = [];
    this._total = 0;
    this._statusCounts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  }

  record(durationMs, statusCode) {
    this._total++;
    this._durationsMs.push(durationMs);
    if (this._durationsMs.length > HTTP_WINDOW) this._durationsMs.shift();
    const bucket = `${Math.floor(statusCode / 100)}xx`;
    if (bucket in this._statusCounts) this._statusCounts[bucket]++;
  }

  snapshot() {
    const sorted = [...this._durationsMs].sort((a, b) => a - b);
    const pct = (p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
    return {
      totalRequests: this._total,
      sampleSize: sorted.length,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      statusCounts: { ...this._statusCounts },
    };
  }
}

export const httpLatency = new HttpLatencyTracker();

// Node's own standard signal for "the event loop itself is falling behind"
// (GC pauses, a long synchronous stretch, etc.) -- distinct from any single
// request or DB call being slow. Resolution 10ms is Node's documented
// default and plenty for a health-tab display refreshed every ~10s.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

export function eventLoopMetrics() {
  const ms = (ns) => (Number.isFinite(ns) ? ns / 1e6 : null);
  const snapshot = {
    meanMs: ms(eventLoopDelay.mean),
    p95Ms: ms(eventLoopDelay.percentile(95)),
    maxMs: ms(eventLoopDelay.max),
  };
  eventLoopDelay.reset();
  return snapshot;
}

export function processMetrics() {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: round1(mem.rss / 1024 / 1024),
    heapUsedMb: round1(mem.heapUsed / 1024 / 1024),
    heapTotalMb: round1(mem.heapTotal / 1024 / 1024),
    pid: process.pid,
  };
}

/**
 * DB/WAL file size plus time since the newest rolling checkpoint
 * (checkpointManager.js) -- the exact risk window behind every WAL
 * corruption incident this project has hit (docs/issues.md, 2026-09-09):
 * anything written since the last checkpoint exists only in the WAL and is
 * lost if the process is ever force-killed instead of closed cleanly.
 */
export function dbFileMetrics({ dbPath, checkpointsDir, connectionId }) {
  const dbSizeMb = fileSizeMb(dbPath);
  const walSizeMb = fileSizeMb(`${dbPath}.wal`);

  let lastCheckpointAtIst = null;
  let secondsSinceCheckpoint = null;
  const dir = path.join(checkpointsDir, connectionId ?? 'default');
  if (existsSync(dir)) {
    // Filenames embed 'YYYY-MM-DD-HH-MM-SS' (checkpointManager.js), which
    // sorts chronologically as a plain string.
    const files = readdirSync(dir).filter((f) => f.endsWith('.duckdb')).sort();
    const newest = files[files.length - 1];
    if (newest) {
      // 'watchlist-YYYY-MM-DD-HH-MM-SS.duckdb' -> 'YYYY-MM-DD HH:MM:SS'
      const stamp = newest.replace(/^watchlist-/, '').replace(/\.duckdb$/, '');
      const [y, mo, d, h, mi, se] = stamp.split('-');
      lastCheckpointAtIst = y && se ? `${y}-${mo}-${d} ${h}:${mi}:${se}` : null;
      const stat = statSync(path.join(dir, newest));
      secondsSinceCheckpoint = Math.round((Date.now() - stat.mtimeMs) / 1000);
    }
  }

  return { dbSizeMb, walSizeMb, lastCheckpointAtIst, secondsSinceCheckpoint };
}

function fileSizeMb(p) {
  if (!existsSync(p)) return null;
  return round1(statSync(p).size / 1024 / 1024);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
