/**
 * checkpointManager.js: saveScheduledCheckpoint() checkpoints the live DB
 * and clones it into data/checkpoints/<connectionId>/, keeping only the
 * newest 10. Exercised directly (not through the scheduler's real cron
 * tick, which fires on real wall-clock time and isn't deterministically
 * testable) -- this is the actual new logic surface scheduler.js's regular
 * interval tick calls into.
 *
 * Note: openability of a saved checkpoint (in a genuinely fresh process,
 * well after the source connection is gone -- the real disaster-recovery
 * scenario) was verified manually and repeatedly during development, both
 * same-process-after-close and via a separately-invoked `node` process,
 * and was reliable every time. It's deliberately NOT re-verified here via
 * a subprocess spawned from inside this test: doing that reproducibly
 * crashes the spawned child (a `node --test` worker-thread interaction
 * with the native duckdb addon after many repeated ATTACH/DETACH cycles in
 * one connection -- confirmed unrelated to checkpointManager.js itself,
 * since the identical clone sequence run under plain `node` never
 * reproduces it). See docs/issues.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('checkpointManager: keeps only the newest 10 checkpoints, oldest purged first', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-checkpoint-test-'));
  const env = setTestEnv(dir);

  // Dynamic imports, AFTER setTestEnv() -- config.js reads its paths from
  // process.env at module-load time, not reactively. A static top-level
  // import of checkpointManager.js (which imports config.js) would load
  // config.js -- with the REAL, un-overridden env -- before setTestEnv()
  // runs, silently pointing this test at the actual live project database
  // instead of this test's isolated temp dir. Confirmed the hard way: this
  // exact ordering bug had an earlier version of this test opening a
  // second connection to whatever real watchlist.duckdb a live dev server
  // had open.
  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { saveScheduledCheckpoint } = await import('../src/checkpointManager.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();

    // 12 runs, one per hour, oldest first -- more than MAX_CHECKPOINTS (10).
    const slots = [];
    for (let h = 9; h <= 20; h++) slots.push(`2026-09-09 ${String(h).padStart(2, '0')}:15:00`);
    assert.equal(slots.length, 12);

    const savedPaths = [];
    for (const tsIst of slots) {
      const savedPath = await saveScheduledCheckpoint(ctx.db, ctx.connectionId, tsIst);
      assert.ok(existsSync(savedPath), `checkpoint for ${tsIst} should exist right after being saved`);
      savedPaths.push(savedPath);
    }

    const checkpointDir = path.join(env.checkpointsDir, ctx.connectionId ?? 'default');
    const filesOnDisk = readdirSync(checkpointDir).filter((f) => f.endsWith('.duckdb')).sort();
    assert.equal(filesOnDisk.length, 10, 'only the newest 10 checkpoints should remain on disk');

    // The oldest 2 of the 12 (09:15, 10:15) must have been purged; the
    // newest 10 (11:15..20:15) must remain.
    assert.ok(!existsSync(savedPaths[0]), 'oldest checkpoint (09:15) should have been purged');
    assert.ok(!existsSync(savedPaths[1]), 'second-oldest checkpoint (10:15) should have been purged');
    for (let i = 2; i < 12; i++) {
      assert.ok(existsSync(savedPaths[i]), `checkpoint ${slots[i]} should still be on disk`);
    }

    // A 13th run purges exactly one more (11:15), keeping the count at 10 --
    // proves this is an ongoing rolling window, not a one-time cap.
    const thirteenth = await saveScheduledCheckpoint(ctx.db, ctx.connectionId, '2026-09-09 21:15:00');
    const filesAfter13th = readdirSync(checkpointDir).filter((f) => f.endsWith('.duckdb'));
    assert.equal(filesAfter13th.length, 10, 'still exactly 10 after a 13th run');
    assert.ok(!existsSync(savedPaths[2]), '11:15 (the next-oldest) should now be purged too');
    assert.ok(existsSync(thirteenth), 'the 13th checkpoint should be present');
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
