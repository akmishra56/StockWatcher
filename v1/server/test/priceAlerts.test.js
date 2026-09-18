/**
 * End-to-end: configure a price alert, drive two real ingest cycles through
 * the pipeline so the symbol's close crosses the alert level, and confirm
 * the crossing lands in GET /api/price-alerts (status flips to "triggered"),
 * shows up in the ticker feed, and does NOT yet appear in the log (still
 * inside its 24h window). A second alert that never crosses stays "watching"
 * and never appears in either feed. Ported from
 * v2/server/test/priceAlerts.test.js. The 24h ticker->log rollover itself is
 * covered separately in priceAlertsExpiry.test.js -- split into its own
 * file because DuckDB can't open a second Database in the same process, so
 * each buildServer()-calling test gets its own file (same reason v1's
 * ingestPipeline.test.js keeps its two buildServer-adjacent cases together
 * only because neither calls buildServer() itself).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';
import { nowIst } from '../src/time.js';

// GET /api/price-alerts, /ticker and /logs all compare event.triggered_at_ist
// against the REAL wall clock (routes/priceAlerts.js calls nowIst()), so
// cycle timestamps here must be anchored to real "now", not a fixed
// historical date (which would already read as >24h stale). Treats the IST
// string as a naive wall clock for the offset, same as
// ingestPipeline.js's own secondsBetween().
function shiftIst(tsIst, minutesDelta) {
  const [datePart, timePart] = tsIst.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, se] = timePart.split(':').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se) + minutesDelta * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

test('price alerts: crossing detection, ticker/log split, and CRUD', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-price-alerts-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { pipeline } = ctx;

    // Seed one tick below the alert level for both symbols first, so the
    // second tick has a real "previous" row to cross against (crosses_above
    // fails closed on a symbol's first-ever tick -- same rule saved filters use).
    const anchor = nowIst();
    const t0 = shiftIst(anchor, -120);
    await pipeline.runCycle(t0, [
      { symbol: 'INFY', ts_ist: t0, actual_ts_ist: t0, open: 1600, high: 1605, low: 1595, close: 1600, volume: 1000 },
      { symbol: 'TCS', ts_ist: t0, actual_ts_ist: t0, open: 3800, high: 3805, low: 3795, close: 3800, volume: 1000 },
    ]);

    // Configure: INFY crosses above 1650, TCS crosses above 3900 (never happens).
    const infyAlertRes = await app.inject({ method: 'POST', url: '/api/price-alerts', payload: { symbol: 'INFY', direction: 'above', alertPrice: 1650 } });
    assert.equal(infyAlertRes.statusCode, 200, infyAlertRes.body);
    const infyAlert = JSON.parse(infyAlertRes.body);

    const tcsAlertRes = await app.inject({ method: 'POST', url: '/api/price-alerts', payload: { symbol: 'TCS', direction: 'above', alertPrice: 3900 } });
    assert.equal(tcsAlertRes.statusCode, 200, tcsAlertRes.body);

    // unknown symbol rejected
    const badRes = await app.inject({ method: 'POST', url: '/api/price-alerts', payload: { symbol: 'NOPE', direction: 'above', alertPrice: 100 } });
    assert.equal(badRes.statusCode, 400);
    // bad direction rejected
    const badDirRes = await app.inject({ method: 'POST', url: '/api/price-alerts', payload: { symbol: 'INFY', direction: 'sideways', alertPrice: 100 } });
    assert.equal(badDirRes.statusCode, 400);

    // Second tick: INFY jumps above 1650, TCS stays flat.
    const t1 = shiftIst(anchor, -60);
    await pipeline.runCycle(t1, [
      { symbol: 'INFY', ts_ist: t1, actual_ts_ist: t1, open: 1600, high: 1670, low: 1600, close: 1668.3, volume: 1200 },
      { symbol: 'TCS', ts_ist: t1, actual_ts_ist: t1, open: 3800, high: 3820, low: 3790, close: 3805, volume: 1200 },
    ]);

    const listRes = await app.inject({ method: 'GET', url: '/api/price-alerts' });
    const list = JSON.parse(listRes.body);
    const infyRow = list.find((a) => a.id === infyAlert.id);
    const tcsRow = list.find((a) => a.symbol === 'TCS');
    assert.equal(infyRow.status, 'triggered');
    assert.equal(infyRow.current_price, 1668.3);
    assert.equal(tcsRow.status, 'watching');

    // Ticker (still-active events) should show INFY only.
    const tickerRes = await app.inject({ method: 'GET', url: '/api/price-alerts/ticker' });
    const ticker = JSON.parse(tickerRes.body);
    assert.equal(ticker.length, 1);
    assert.equal(ticker[0].symbol, 'INFY');
    assert.equal(ticker[0].price_after_crossed, 1668.3);
    assert.equal(ticker[0].slot_ts_ist, t1);
    assert.equal(ticker[0].current_price, 1668.3);

    // Not yet 24h old -- must not appear in the log yet.
    const logsRes = await app.inject({ method: 'GET', url: '/api/price-alerts/logs' });
    assert.deepEqual(JSON.parse(logsRes.body), []);

    // A third cycle where INFY is still above the level must NOT spawn a
    // second event (one activation per 24h window, not one per qualifying tick).
    const t2 = shiftIst(anchor, 0);
    await pipeline.runCycle(t2, [
      { symbol: 'INFY', ts_ist: t2, actual_ts_ist: t2, open: 1668, high: 1672, low: 1660, close: 1670, volume: 1000 },
      { symbol: 'TCS', ts_ist: t2, actual_ts_ist: t2, open: 3805, high: 3810, low: 3800, close: 3805, volume: 1000 },
    ]);
    const ticker2 = JSON.parse((await app.inject({ method: 'GET', url: '/api/price-alerts/ticker' })).body);
    assert.equal(ticker2.length, 1, 'still one activation, not a second event');
    assert.equal(ticker2[0].price_after_crossed, 1668.3, 'the original crossing event, unchanged');

    // Pause the TCS alert, then delete it.
    const pauseRes = await app.inject({ method: 'PUT', url: `/api/price-alerts/${JSON.parse(tcsAlertRes.body).id}`, payload: { isActive: false } });
    assert.equal(pauseRes.statusCode, 200);
    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/price-alerts/${JSON.parse(tcsAlertRes.body).id}` });
    assert.equal(deleteRes.statusCode, 200);
    const afterDeleteList = JSON.parse((await app.inject({ method: 'GET', url: '/api/price-alerts' })).body);
    assert.equal(afterDeleteList.find((a) => a.symbol === 'TCS'), undefined);
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
