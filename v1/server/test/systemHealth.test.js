/**
 * GET /api/system-health -- boots the real server (same pattern as
 * server.boot.test.js) and checks the shape of every panel the System
 * Health tab reads, plus that a DB write actually moves the queue-depth/
 * completed counters (proving the DbClient instrumentation is live, not
 * just present).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('system health endpoint reports HTTP, DB, event-loop, process, DB-file, WS, and ingest signals', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-health-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();

    // A real DB write, so the queue-depth/completed counters have moved off zero.
    await ctx.db.ensureSymbols(['TCS']);

    // A prior request, so the HTTP-latency tracker has something to report --
    // the health endpoint's own onResponse hook fires after ITS body is
    // already built, so it can't see itself.
    await app.inject({ method: 'GET', url: '/api/settings' });

    const res = await app.inject({ method: 'GET', url: '/api/system-health' });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);

    assert.ok(body.generatedAtIst);

    assert.ok('p50Ms' in body.http && 'statusCounts' in body.http);
    assert.ok(body.http.totalRequests >= 1, 'a prior request should count');

    // db.write/db.read are tracked separately -- ensureSymbols is a write,
    // so only the write connection's completed counter should have moved.
    assert.ok(body.db.write.completed >= 1, 'ensureSymbols should have moved the write-connection completed counter');
    assert.equal(body.db.write.queueDepth, 0, 'write queue should be drained by the time the response is built');
    assert.ok(body.db.read.completed >= 1, "the health route's own reads (e.g. readMonitorLog) should have moved the read-connection completed counter");
    assert.equal(body.db.read.queueDepth, 0, 'read queue should be drained by the time the response is built');

    assert.ok('meanMs' in body.eventLoop);

    assert.ok(body.process.pid > 0);
    assert.ok(body.process.uptimeSeconds >= 0);
    assert.ok(body.process.rssMb > 0);

    assert.ok('dbSizeMb' in body.dbFile);
    assert.ok('walSizeMb' in body.dbFile);
    // No scheduled cycle has run in this fresh test DB, so there's no
    // checkpoint yet -- both should degrade to null, not throw.
    assert.equal(body.dbFile.lastCheckpointAtIst, null);

    assert.equal(body.websocket.connectedClients, 0);

    assert.deepEqual(body.ingest, { recentCycles: 0, successRate: null, avgMissingSymbols: null, lastCycle: null });
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
