/**
 * Split out of priceAlerts.test.js -- DuckDB can't open a second Database
 * against the same process twice, so each test file that calls
 * buildServer() gets exactly one such call. Ported from
 * v2/server/test/priceAlertsExpiry.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('price alerts: an event rolls from the ticker into the log exactly at the 24h mark', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-price-alerts-24h-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { db } = ctx;
    await db.createPriceAlert({ id: 'a1', symbol: 'RELIANCE', direction: 'above', alertPrice: 2800, createdAt: '2026-09-14 09:00:00' });
    await db.insertPriceAlertEvent({
      alertId: 'a1', symbol: 'RELIANCE', direction: 'above', alertPrice: 2800,
      priceAfterCrossed: 2825, slotTsIst: '2026-09-15 10:00:00', triggeredAtIst: '2026-09-15 10:00:00',
    });

    // Just under 24h later -- still in the ticker, not yet in the log.
    const justBefore = await db.readActivePriceAlertTicker('2026-09-16 09:59:00');
    assert.equal(justBefore.length, 1);
    assert.equal((await db.readPriceAlertLog('2026-09-16 09:59:00')).length, 0);

    // Just past 24h -- rolled into the log, gone from the ticker.
    const justAfter = await db.readActivePriceAlertTicker('2026-09-16 10:01:00');
    assert.equal(justAfter.length, 0);
    const log = await db.readPriceAlertLog('2026-09-16 10:01:00');
    assert.equal(log.length, 1);
    assert.equal(log[0].alert_price, 2800);
    assert.equal(log[0].price_after_crossed, 2825);
    assert.equal(log[0].slot_ts_ist, '2026-09-15 10:00:00');

    // Also reflected in GET /api/price-alerts' status -- but that route uses
    // the real wall clock, so it can only be exercised indirectly here via
    // the same DB methods it calls; readActivePriceAlertEvents mirrors the
    // ticker split exactly.
    const stillActive = await db.readActivePriceAlertEvents('2026-09-16 09:59:00');
    assert.ok(stillActive.has('a1'));
    const noLongerActive = await db.readActivePriceAlertEvents('2026-09-16 10:01:00');
    assert.ok(!noLongerActive.has('a1'));
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
