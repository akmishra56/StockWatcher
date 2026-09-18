/**
 * Split out of telegram.test.js -- DuckDB can't open a second Database in
 * the same process, so each buildServer()-calling test gets its own file
 * (same reason priceAlertsExpiry.test.js is separate from priceAlerts.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';
import { nowIst } from '../src/time.js';

function shiftIst(tsIst, minutesDelta) {
  const [datePart, timePart] = tsIst.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, se] = timePart.split(':').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se) + minutesDelta * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

test('a real price-alert crossing triggers a Telegram send via PriceAlertEngine.onEvents, and a send failure never breaks the ingest cycle', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-telegram-cycle-test-'));
  setTestEnv(dir);

  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    // Simulate a Telegram outage -- the ingest cycle below must still complete cleanly.
    return { ok: false, status: 500, json: async () => ({ ok: false, description: 'Internal Server Error' }) };
  };

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { db, pipeline } = ctx;
    await db.writeSetting('telegram', { enabled: true, botToken: 't', chatId: 'c' }, nowIst());

    const anchor = nowIst();
    const t0 = shiftIst(anchor, -60);
    await pipeline.runCycle(t0, [{ symbol: 'RELIANCE', ts_ist: t0, actual_ts_ist: t0, open: 2790, high: 2795, low: 2785, close: 2790, volume: 1000 }]);

    const alertRes = await app.inject({ method: 'POST', url: '/api/price-alerts', payload: { symbol: 'RELIANCE', direction: 'above', alertPrice: 2800 } });
    assert.equal(alertRes.statusCode, 200, alertRes.body);

    const t1 = shiftIst(anchor, 0);
    // Must not throw even though the mocked Telegram call above always fails.
    await pipeline.runCycle(t1, [{ symbol: 'RELIANCE', ts_ist: t1, actual_ts_ist: t1, open: 2790, high: 2820, low: 2790, close: 2812, volume: 1200 }]);

    assert.equal(sent.length, 1, 'exactly one Telegram send attempted for the one crossing');
    assert.match(sent[0].text, /RELIANCE/);
    assert.match(sent[0].text, /crossed above/);

    const config = await db.readSetting('telegram');
    assert.equal(config.lastStatus, 'failed');
    assert.equal(config.lastError, 'Internal Server Error');

    // The ticker itself is unaffected by the notification failure.
    const ticker = JSON.parse((await app.inject({ method: 'GET', url: '/api/price-alerts/ticker' })).body);
    assert.equal(ticker.length, 1);
  } finally {
    globalThis.fetch = original;
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
