/**
 * A new filter can instantly match symbols against the current snapshot
 * (GET /api/filters/:id/matches), but FilterEngine.reevaluateAll only logs
 * membership transitions on the next ingest cycle, diffed against
 * lastKnownMatches -- which has no entry yet for a filter created after
 * boot. Without seeding, the Membership Log silently shows nothing for a
 * new filter until the next scrape/upload even though the sidebar already
 * shows real matches. See routes/filters.js POST /api/filters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('POST /api/filters: instantly-matching symbols are logged as "added" right away, not just on the next ingest cycle', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-filter-seed-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { pipeline } = ctx;

    // One real ingest cycle so a snapshot exists to match against.
    const tsIst = '2026-09-09 11:15:00';
    await pipeline.runCycle(tsIst, [
      { symbol: 'INFY', ts_ist: tsIst, actual_ts_ist: tsIst, open: 100, high: 101, low: 99, close: 105, volume: 1000 },
      { symbol: 'TCS', ts_ist: tsIst, actual_ts_ist: tsIst, open: 100, high: 101, low: 99, close: 95, volume: 1000 },
    ]);

    const createRes = await app.inject({
      method: 'POST', url: '/api/filters',
      payload: { name: 'Positive change', conditionTree: { join: 'AND', conditions: [{ field: 'price_change_pct', operator: '>', value: 0 }] } },
    });
    const filter = JSON.parse(createRes.body);
    assert.equal(createRes.statusCode, 200);

    // The log should show INFY (close > open, positive change) as 'added'
    // immediately -- no second ingest cycle required.
    const logRows = await ctx.db.readMembershipLog(filter.id, 10);
    assert.equal(logRows.length, 1, 'exactly one symbol should have matched and been logged');
    assert.equal(logRows[0].symbol, 'INFY');
    assert.equal(logRows[0].action, 'added');

    // The engine's baseline should now include INFY -- so the NEXT real
    // ingest cycle (still matching) must NOT re-log it as newly added.
    assert.ok(ctx.filterEngine.lastKnownMatches.get(filter.id)?.has('INFY'));

    await pipeline.runCycle('2026-09-09 12:15:00', [
      { symbol: 'INFY', ts_ist: '2026-09-09 12:15:00', actual_ts_ist: '2026-09-09 12:15:00', open: 100, high: 101, low: 99, close: 106, volume: 1000 },
      { symbol: 'TCS', ts_ist: '2026-09-09 12:15:00', actual_ts_ist: '2026-09-09 12:15:00', open: 100, high: 101, low: 99, close: 94, volume: 1000 },
    ]);
    const logRowsAfter = await ctx.db.readMembershipLog(filter.id, 10);
    assert.equal(logRowsAfter.length, 1, 'still-matching INFY must not be re-logged as added a second time');

    // Deleting the filter must clear its lastKnownMatches entry too.
    await app.inject({ method: 'DELETE', url: `/api/filters/${filter.id}` });
    assert.equal(ctx.filterEngine.lastKnownMatches.has(filter.id), false);
  } finally {
    // app.close() (not ctx.db.close() directly) -- its onClose hook is what
    // stops the scheduler's cron task and the NseCsvAdapter's chokidar
    // watcher before closing the DB; skipping it leaves those handles open
    // and the test process never exits (docs/issues.md pattern).
    await app.close();
  }
});
