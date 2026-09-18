/**
 * Boots the real server (same pattern as server.boot.test.js) and exercises
 * Watchlists CRUD end to end: create, rename, add/remove symbols
 * (constrained to the tracked universe), delete. Ported from
 * v2/server/test/watchlists.test.js -- v1 has no CSV/manual-upload route
 * (Yahoo Finance is the sole data source), so a tracked symbol is seeded by
 * driving a real ingest cycle directly (ctx.pipeline.runCycle), the same
 * technique ingestPipeline.test.js already uses for v1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('watchlists: create, rename, add/remove symbols (constrained to the tracked universe), delete', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-watchlists-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();

    // Seed one real tracked symbol via a direct ingest cycle, so it exists
    // in the `symbols` table -- watchlist symbol additions are constrained
    // to that universe (routes/watchlists.js) so indicator values always
    // exist for anything addable.
    const ts = '2026-09-16 10:00:00';
    await ctx.pipeline.runCycle(ts, [
      { symbol: 'TCS', ts_ist: ts, actual_ts_ist: ts, open: 3800, high: 3850, low: 3790, close: 3842.5, volume: 1500000 },
    ]);

    // create
    const createRes = await app.inject({ method: 'POST', url: '/api/watchlists', payload: { name: 'My Longs' } });
    assert.equal(createRes.statusCode, 200, createRes.body);
    const watchlist = JSON.parse(createRes.body);
    assert.ok(watchlist.id);
    assert.equal(watchlist.name, 'My Longs');
    assert.deepEqual(watchlist.symbols, []);

    // missing name is rejected
    const badCreateRes = await app.inject({ method: 'POST', url: '/api/watchlists', payload: {} });
    assert.equal(badCreateRes.statusCode, 400);

    // add a known symbol
    const addRes = await app.inject({ method: 'POST', url: `/api/watchlists/${watchlist.id}/symbols`, payload: { symbol: 'TCS' } });
    assert.equal(addRes.statusCode, 200, addRes.body);

    // adding an unknown symbol is rejected
    const addUnknownRes = await app.inject({ method: 'POST', url: `/api/watchlists/${watchlist.id}/symbols`, payload: { symbol: 'NOPE' } });
    assert.equal(addUnknownRes.statusCode, 400);

    // list reflects the addition
    const listRes = await app.inject({ method: 'GET', url: '/api/watchlists' });
    const list = JSON.parse(listRes.body);
    const found = list.find((w) => w.id === watchlist.id);
    assert.ok(found);
    assert.deepEqual(found.symbols, ['TCS']);

    // adding the same symbol twice is a no-op, not a duplicate/error
    const addAgainRes = await app.inject({ method: 'POST', url: `/api/watchlists/${watchlist.id}/symbols`, payload: { symbol: 'TCS' } });
    assert.equal(addAgainRes.statusCode, 200);
    const listAfterDupRes = await app.inject({ method: 'GET', url: '/api/watchlists' });
    assert.deepEqual(JSON.parse(listAfterDupRes.body).find((w) => w.id === watchlist.id).symbols, ['TCS']);

    // rename
    const renameRes = await app.inject({ method: 'PUT', url: `/api/watchlists/${watchlist.id}`, payload: { name: 'Renamed' } });
    assert.equal(renameRes.statusCode, 200);
    const afterRenameRes = await app.inject({ method: 'GET', url: '/api/watchlists' });
    assert.equal(JSON.parse(afterRenameRes.body).find((w) => w.id === watchlist.id).name, 'Renamed');

    // remove symbol
    const removeRes = await app.inject({ method: 'DELETE', url: `/api/watchlists/${watchlist.id}/symbols/TCS` });
    assert.equal(removeRes.statusCode, 200);
    const afterRemoveRes = await app.inject({ method: 'GET', url: '/api/watchlists' });
    assert.deepEqual(JSON.parse(afterRemoveRes.body).find((w) => w.id === watchlist.id).symbols, []);

    // delete
    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/watchlists/${watchlist.id}` });
    assert.equal(deleteRes.statusCode, 200);
    const afterDeleteRes = await app.inject({ method: 'GET', url: '/api/watchlists' });
    assert.equal(JSON.parse(afterDeleteRes.body).find((w) => w.id === watchlist.id), undefined);
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
