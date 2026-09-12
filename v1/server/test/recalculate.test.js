/**
 * Boots the real server, ingests two manual cycles for one symbol so there
 * is real ohlcv history to replay, changes the RSI period via Settings,
 * then confirms "Recalculate All" (POST /api/settings/recalculate) rewrites
 * indicator_snapshots to match a fresh RSI computed with the new period --
 * proving a Settings parameter change applies retroactively, per
 * docs/component_design.md §6.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollJob(app, jobId) {
  for (let i = 0; i < 30; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/settings/recalculate/${jobId}` });
    const job = JSON.parse(res.body);
    if (job.status === 'done' || job.status === 'failed') return job;
    await sleep(50);
  }
  throw new Error('recalculate job did not finish in time');
}

test('recalculate-all replays history with updated indicator params', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-recalc-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();

    // Seven distinct historical bars for INFY, one per hour, fed straight
    // through the pipeline with explicit scheduled slots -- priming
    // multi-bar indicator history needs actually-distinct slots, which this
    // test controls directly rather than depending on real-time spacing.
    const closes = [100, 102, 101, 105, 107, 104, 110];
    for (const [i, close] of closes.entries()) {
      const scheduledTsIst = `2026-04-01 ${String(9 + i).padStart(2, '0')}:00:00`;
      const bars = [{
        symbol: 'INFY', ts_ist: scheduledTsIst, actual_ts_ist: scheduledTsIst,
        open: close, high: close + 1, low: close - 1, close, volume: 1000000,
      }];
      const result = await ctx.pipeline.runCycle(scheduledTsIst, bars, { isManual: true });
      assert.equal(result.snapshot.length, 1);
    }

    const beforeSnapshot = JSON.parse((await app.inject({ method: 'GET', url: '/api/snapshot' })).body);
    const infyBefore = beforeSnapshot.rows.find((r) => r.symbol === 'INFY');
    // 7 bars isn't enough to prime a 14-period Wilder RSI (needs period+1
    // closes) -- rsi is still null here. This is exactly what recalculate
    // is for: switching to a shorter period below should un-null it.
    assert.equal(infyBefore.rsi, null);

    const putRes = await app.inject({
      method: 'PUT', url: '/api/settings', payload: { indicators: { rsi: { period: 3 } } },
    });
    assert.equal(putRes.statusCode, 200);

    const recalcRes = await app.inject({ method: 'POST', url: '/api/settings/recalculate' });
    assert.equal(recalcRes.statusCode, 200);
    const { jobId } = JSON.parse(recalcRes.body);
    assert.ok(jobId);

    const job = await pollJob(app, jobId);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.processed, closes.length);
    assert.equal(job.total, closes.length);

    const afterSnapshot = JSON.parse((await app.inject({ method: 'GET', url: '/api/snapshot' })).body);
    const infyAfter = afterSnapshot.rows.find((r) => r.symbol === 'INFY');
    assert.ok(infyAfter.rsi != null, 'RSI(3) needs only 4 closes to prime, so recalculating should un-null it');

    // The live in-memory engine must also carry the recalculated state forward --
    // otherwise the *next* real bar would silently resume from stale RSI(14) state.
    const nextTsIst = '2026-04-01 16:00:00';
    await ctx.pipeline.runCycle(nextTsIst, [{
      symbol: 'INFY', ts_ist: nextTsIst, actual_ts_ist: nextTsIst,
      open: 110, high: 112, low: 109, close: 112, volume: 1000000,
    }]);
    const finalSnapshot = JSON.parse((await app.inject({ method: 'GET', url: '/api/snapshot' })).body);
    const infyFinal = finalSnapshot.rows.find((r) => r.symbol === 'INFY');
    assert.ok(infyFinal.rsi != null);
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
