/**
 * Unit tests for the Telegram notifier itself (mocked global.fetch, same
 * pattern rssFetcher.test.js/newsSources.test.js use -- never a real
 * network call), plus an end-to-end config-route test. The live-cycle test
 * confirming PriceAlertEngine's onEvents hook actually fires a Telegram
 * send is in telegramCycle.test.js -- split out because DuckDB can't open a
 * second Database in the same process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';
import { sendTelegramMessage, formatPriceAlertMessage } from '../src/telegram/notifier.js';

test('sendTelegramMessage: posts to the bot API and reports Telegram\'s own error text on failure', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url.includes('bad-token')) {
      return { ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const ok = await sendTelegramMessage({ botToken: 'good-token', chatId: '12345' }, 'hello');
    assert.deepEqual(ok, { ok: true });
    assert.equal(calls[0].url, 'https://api.telegram.org/botgood-token/sendMessage');
    assert.equal(calls[0].body.chat_id, '12345');
    assert.equal(calls[0].body.text, 'hello');

    const failed = await sendTelegramMessage({ botToken: 'bad-token', chatId: '12345' }, 'hello');
    assert.deepEqual(failed, { ok: false, error: 'Unauthorized' });

    const unconfigured = await sendTelegramMessage({ botToken: null, chatId: null }, 'hello');
    assert.equal(unconfigured.ok, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('formatPriceAlertMessage: escapes HTML and renders both directions', () => {
  const up = formatPriceAlertMessage({ symbol: 'M&M', direction: 'above', alertPrice: 2800, priceAfterCrossed: 2825.5, triggeredAtIst: '2026-09-17 10:00:00' });
  assert.match(up, /M&amp;M/);
  assert.match(up, /crossed above/);
  assert.match(up, /2800\.00/);
  assert.match(up, /2825\.50/);

  const down = formatPriceAlertMessage({ symbol: 'TCS', direction: 'below', alertPrice: 3800, priceAfterCrossed: 3790, triggeredAtIst: '2026-09-17 10:00:00' });
  assert.match(down, /crossed below/);
});

test('telegram config routes: GET never echoes the bot token, PUT persists, test-send reports failure without throwing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-telegram-test-'));
  setTestEnv(dir);

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) });

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app } = await buildServer();

  try {
    await app.ready();

    const initialRes = await app.inject({ method: 'GET', url: '/api/telegram/config' });
    const initial = JSON.parse(initialRes.body);
    assert.equal(initial.enabled, false);
    assert.equal(initial.hasToken, false);
    assert.ok(!('botToken' in initial), 'raw token must never be returned');

    const putRes = await app.inject({
      method: 'PUT', url: '/api/telegram/config',
      payload: { enabled: true, botToken: '123:ABC', chatId: '-100999' },
    });
    assert.equal(putRes.statusCode, 200);

    const afterPutRes = await app.inject({ method: 'GET', url: '/api/telegram/config' });
    const afterPut = JSON.parse(afterPutRes.body);
    assert.equal(afterPut.enabled, true);
    assert.equal(afterPut.hasToken, true);
    assert.ok(!('botToken' in afterPut));

    // Test-send fails (mocked 401) but must surface as a normal error
    // response, not a 500/crash.
    const testRes = await app.inject({ method: 'POST', url: '/api/telegram/test' });
    assert.equal(testRes.statusCode, 400);
    const testBody = JSON.parse(testRes.body);
    assert.equal(testBody.ok, false);
    assert.equal(testBody.error, 'Unauthorized');

    const afterTestRes = await app.inject({ method: 'GET', url: '/api/telegram/config' });
    const afterTest = JSON.parse(afterTestRes.body);
    assert.equal(afterTest.lastStatus, 'failed');
    assert.equal(afterTest.lastError, 'Unauthorized');
    assert.ok(afterTest.lastSentAtIst);
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
