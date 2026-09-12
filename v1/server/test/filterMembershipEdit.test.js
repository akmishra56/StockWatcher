/**
 * Editing a saved filter's conditions can instantly widen or narrow its
 * match set (e.g. removing a condition), but without reconciling against
 * FilterEngine.lastKnownMatches at edit time, the Membership Log stays
 * silent about that change until the next real ingest cycle -- which may be
 * hours away, or (outside market hours) may not come today at all. See
 * routes/filters.js PUT /api/filters/:id and reconcileMembershipLog.
 *
 * Kept in its own file/process (not alongside filterMembershipSeed.test.js)
 * -- every other buildServer()-based test in this suite calls it exactly
 * once; two buildServer() calls in one process is an untested pattern here
 * and reproducibly hit a DuckDB native-binding internal error when tried
 * (see docs/issues.md's existing note on the binding's fragility around
 * reopening within one process).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('PUT /api/filters/:id: editing conditions logs only the REAL transition right away, not a wholesale re-add', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-filter-edit-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { pipeline } = ctx;

    const tsIst = '2026-09-09 11:15:00';
    await pipeline.runCycle(tsIst, [
      { symbol: 'INFY', ts_ist: tsIst, actual_ts_ist: tsIst, open: 100, high: 101, low: 99, close: 105, volume: 1000 },
      { symbol: 'TCS', ts_ist: tsIst, actual_ts_ist: tsIst, open: 100, high: 101, low: 99, close: 95, volume: 1000 },
    ]);

    // Narrow condition: only INFY (change > 4%) matches at creation.
    const createRes = await app.inject({
      method: 'POST', url: '/api/filters',
      payload: { name: 'Big movers', conditionTree: { join: 'AND', conditions: [{ field: 'price_change_pct', operator: '>', value: 4 }] } },
    });
    const filter = JSON.parse(createRes.body);
    let logRows = await ctx.db.readMembershipLog(filter.id, 10);
    assert.deepEqual(logRows.map((r) => [r.symbol, r.action]), [['INFY', 'added']]);

    // Widen it to `> -10`: now both INFY and TCS match. Only TCS is a real
    // transition (INFY already matched) -- confirm it logs just TCS, not a
    // wholesale re-add of everything currently matching.
    await app.inject({
      method: 'PUT', url: `/api/filters/${filter.id}`,
      payload: { conditionTree: { join: 'AND', conditions: [{ field: 'price_change_pct', operator: '>', value: -10 }] } },
    });
    logRows = await ctx.db.readMembershipLog(filter.id, 10);
    assert.deepEqual(
      logRows.map((r) => [r.symbol, r.action]).sort(),
      [['INFY', 'added'], ['TCS', 'added']].sort(),
      'widening to include TCS should log only TCS as newly added, not re-log INFY'
    );

    // Narrow to `< 0`: TCS (change -5%) still matches -- it was already in
    // the baseline from the previous edit, so this must log ONLY INFY's
    // removal, not re-log TCS as newly added.
    await app.inject({
      method: 'PUT', url: `/api/filters/${filter.id}`,
      payload: { conditionTree: { join: 'AND', conditions: [{ field: 'price_change_pct', operator: '<', value: 0 }] } },
    });
    // readMembershipLog orders newest-first (ORDER BY id DESC) -- logRows[0]
    // is this step's own new row, not the oldest.
    logRows = await ctx.db.readMembershipLog(filter.id, 10);
    assert.equal(logRows.length, 3, 'still-matching TCS must not be re-logged a second time');
    assert.deepEqual([logRows[0].symbol, logRows[0].action], ['INFY', 'removed']);
    assert.ok(ctx.filterEngine.lastKnownMatches.get(filter.id)?.has('TCS'));
    assert.equal(ctx.filterEngine.lastKnownMatches.get(filter.id)?.has('INFY'), false);
  } finally {
    await app.close();
  }
});
