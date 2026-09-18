/**
 * A symbol newly entering a saved filter (e.g. an "Oversold" condition)
 * triggers a Telegram send via IngestPipeline.onMembershipEvents, formatted
 * like the Membership Log panel's own line ("<symbol> added to <filter>").
 * Leaving the filter must NOT send anything -- only "entering" is a
 * notification-worthy event. Own file per the DuckDB single-open-per-process
 * convention (same reason telegramCycle.test.js is split from telegram.test.js).
 * Ported unchanged from v2/server/test/membershipTelegramCycle.test.js.
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

test('a symbol entering a saved filter sends a Telegram digest; leaving one sends nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-membership-telegram-cycle-test-'));
  setTestEnv(dir);

  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { db, pipeline } = ctx;
    await db.writeSetting('telegram', { enabled: true, botToken: 't', chatId: 'c' }, nowIst());

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/filters',
      payload: { name: 'Oversold', conditionTree: { join: 'AND', conditions: [{ field: 'price_change_pct', operator: '<', value: -2 }] } },
    });
    assert.equal(createRes.statusCode, 200, createRes.body);
    // Filter creation itself calls reconcileMembershipLog, not
    // IngestPipeline -- it must not trigger a Telegram send on its own.
    assert.equal(sent.length, 0, 'creating a filter with no current matches sends nothing');

    const anchor = nowIst();
    const t0 = shiftIst(anchor, -60);
    // Cycle 1: RELIANCE is flat -- does not match "Oversold".
    await pipeline.runCycle(t0, [{ symbol: 'RELIANCE', ts_ist: t0, actual_ts_ist: t0, open: 2790, high: 2795, low: 2785, close: 2790, volume: 1000 }]);
    assert.equal(sent.length, 0);

    const t1 = shiftIst(anchor, 0);
    // Cycle 2: RELIANCE drops >2% -- now matches, i.e. "enters" the filter.
    await pipeline.runCycle(t1, [{ symbol: 'RELIANCE', ts_ist: t1, actual_ts_ist: t1, open: 2790, high: 2790, low: 2700, close: 2710, volume: 1000 }]);
    assert.equal(sent.length, 1, 'exactly one Telegram send for the one symbol entering the filter');
    assert.match(sent[0].text, /RELIANCE/);
    assert.match(sent[0].text, /added to Oversold/);

    const config = await db.readSetting('telegram');
    assert.equal(config.lastStatus, 'ok');

    const t2 = shiftIst(anchor, 5);
    // Cycle 3: RELIANCE recovers -- no longer matches, i.e. "leaves" the
    // filter. Must not send anything (only entering is notification-worthy).
    await pipeline.runCycle(t2, [{ symbol: 'RELIANCE', ts_ist: t2, actual_ts_ist: t2, open: 2710, high: 2790, low: 2705, close: 2789, volume: 1000 }]);
    assert.equal(sent.length, 1, 'leaving a filter must not trigger a Telegram send');
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
