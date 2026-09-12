/**
 * Boots the real server (config, DB, indicator engine, filter engine, the
 * Yahoo-only scheduler, Fastify routes) against temp directories and
 * confirms the REST API is actually live. v1 has no watch-folder/CSV-drop
 * path (that was NSE/Playwright-specific) -- its only live ingest path is
 * scheduler.js's hourly Yahoo Finance poll, which hits the real network and
 * isn't exercised here; this test is the "does the whole app actually boot
 * and serve" smoke test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('server boot: REST API is live after boot', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-boot-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app } = await buildServer();

  // Everything from here must run inside try/finally: if an assertion
  // throws before app.close(), the server/db are left open and orphaned,
  // hanging the rest of the test run rather than just failing this one test
  // (this is exactly what happened before time.js's dayjs format-string bug
  // was fixed -- see docs/issues.md).
  try {
    await app.ready();

    const snapshotRes = await app.inject({ method: 'GET', url: '/api/snapshot' });
    assert.equal(snapshotRes.statusCode, 200);
    const snapshot = JSON.parse(snapshotRes.body);
    assert.deepEqual(snapshot.rows, [], 'a fresh DB has no snapshot rows yet');

    const settingsRes = await app.inject({ method: 'GET', url: '/api/settings' });
    const settings = JSON.parse(settingsRes.body);
    assert.ok(settings.indicators.rsi.period === 14, 'default indicator params should be served');

    const schedulerRes = await app.inject({ method: 'GET', url: '/api/scheduler' });
    assert.equal(schedulerRes.statusCode, 200);
    const scheduler = JSON.parse(schedulerRes.body);
    assert.equal(typeof scheduler.isMarketOpen, 'boolean');

    const filterCreate = await app.inject({
      method: 'POST', url: '/api/filters',
      payload: { name: 'Positive', conditionTree: { join: 'AND', conditions: [{ field: 'price_change_pct', operator: '>', value: 0 }] } },
    });
    assert.equal(filterCreate.statusCode, 200);
  } finally {
    await app.close(); // triggers the onClose hook: stops the scheduler, closes db
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
