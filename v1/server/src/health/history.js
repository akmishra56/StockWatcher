/**
 * Rolling in-memory time-series + edge-triggered alert log for the System
 * Health tab's charts (see routes/systemHealth.js). Process-local, like
 * everything else in health/metrics.js -- resets on restart, which is fine
 * since it's "how has the process been doing recently," not an analytics
 * pipeline. A separate, DB-backed alert source (real ingest-cycle
 * failures/partials from `ingestion_log`) is merged in at the route level
 * so genuine data-pipeline failures survive a restart even though these
 * process-resource threshold alerts don't.
 */
import { nowIst } from '../time.js';
import { httpLatency, eventLoopMetrics, processMetrics, dbFileMetrics } from './metrics.js';

const SAMPLE_INTERVAL_MS = 20_000;
const MAX_SAMPLES = 240; // 240 * 20s = 80 minutes of chart history
const MAX_ALERTS = 60;

// Same generous defaults as SystemHealthTab.tsx's own thresholds -- a live
// signal existing at all matters more than precise tuning here.
const THRESHOLDS = {
  httpP95: { warn: 300, bad: 1000, label: 'HTTP p95 latency', unit: 'ms' },
  dbWriteQueue: { warn: 5, bad: 20, label: 'DB write queue depth', unit: '' },
  dbReadQueue: { warn: 5, bad: 20, label: 'DB read queue depth', unit: '' },
  eventLoopP95: { warn: 50, bad: 200, label: 'Event loop lag (p95)', unit: 'ms' },
  checkpointAgeMin: { warn: 120, bad: 360, label: 'Time since last checkpoint', unit: 'min' },
};

const samples = [];
const alerts = [];
const openAlerts = new Map(); // metric -> alert still in progress

function levelFor(v, t) {
  if (v == null) return null;
  if (v >= t.bad) return 'bad';
  if (v >= t.warn) return 'warn';
  return 'ok';
}

function noteAlert(metric, level, value, tsIst) {
  const t = THRESHOLDS[metric];
  const open = openAlerts.get(metric);
  if (level === null || level === 'ok') {
    if (open) {
      open.endedAtIst = tsIst;
      openAlerts.delete(metric);
    }
    return;
  }
  if (open && open.severity === level) return; // still ongoing, same severity
  if (open) { open.endedAtIst = tsIst; openAlerts.delete(metric); } // severity changed -- close and re-open
  const alert = {
    id: `${metric}-${Date.now()}`,
    source: 'threshold',
    severity: level,
    label: t.label,
    message: `${t.label} ${level === 'bad' ? 'critically' : ''} above threshold (${value}${t.unit} >= ${level === 'bad' ? t.bad : t.warn}${t.unit})`.replace('  ', ' '),
    startedAtIst: tsIst,
    endedAtIst: null,
  };
  alerts.push(alert);
  if (alerts.length > MAX_ALERTS) alerts.shift();
  openAlerts.set(metric, alert);
}

/**
 * Starts the sampler. Takes `ctx` itself (not `ctx.db`/`ctx.connectionId`
 * destructured) and re-reads them from it on every tick -- `ctx` is mutated
 * in place on a data-connection switch (server.js's `activateConnection`),
 * so capturing the fields once here would keep sampling a stale connection
 * after a switch. Returns the interval handle, already `.unref()`'d so it
 * never blocks shutdown/tests (docs/issues.md, 2026-09-09).
 */
export function startHealthHistorySampler({ ctx, config }) {
  const tick = () => {
    if (!ctx.db) return; // mid-switch, between activateConnection's stop and its new db open
    const tsIst = nowIst();
    const http = httpLatency.snapshot();
    const dbMetrics = ctx.db.getQueryMetrics();
    const el = eventLoopMetrics();
    const proc = processMetrics();
    const dbFile = dbFileMetrics({ dbPath: config.dbPath, checkpointsDir: config.checkpointsDir, connectionId: ctx.connectionId });
    const checkpointAgeMin = dbFile.secondsSinceCheckpoint == null ? null : round1(dbFile.secondsSinceCheckpoint / 60);

    const sample = {
      tsIst,
      httpP95: http.p95Ms,
      dbWriteQueue: dbMetrics.write.queueDepth,
      dbReadQueue: dbMetrics.read.queueDepth,
      eventLoopP95: el.p95Ms,
      rssMb: proc.rssMb,
      dbSizeMb: dbFile.dbSizeMb,
      walSizeMb: dbFile.walSizeMb,
      checkpointAgeMin,
    };
    samples.push(sample);
    if (samples.length > MAX_SAMPLES) samples.shift();

    for (const metric of Object.keys(THRESHOLDS)) {
      noteAlert(metric, levelFor(sample[metric], THRESHOLDS[metric]), sample[metric], tsIst);
    }
  };

  tick();
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  timer.unref();
  return timer;
}

export function getHealthHistory() {
  return samples;
}

export function getThresholdAlerts() {
  return alerts;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
