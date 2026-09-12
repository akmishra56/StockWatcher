/**
 * Proves DbClient's read connection doesn't queue behind the write
 * connection -- the exact fix for the bottleneck docs/researchOutput.md's
 * 2026-09-09 load audit measured live (every read stalling ~220ms behind
 * an in-progress bulk write). Keeps the write queue busy with a long run of
 * real writes, fires a read concurrently, and asserts the read resolves
 * well before the writes finish -- if read and write ever share one
 * connection/queue again, this test goes from "fast" to "as slow as the
 * writes," not silently green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

test('a read resolves promptly while a long run of writes is still in flight', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-readwrite-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  try {
    await app.ready();
    const { db } = ctx;

    // Enough sequential writes to keep the write queue busy for a while --
    // not awaited yet, so it's still running when the read below fires.
    const writes = (async () => {
      for (let i = 0; i < 300; i++) {
        await db.ensureSymbols([`WRITETEST${i}`]);
      }
    })();

    const readStartedAt = Date.now();
    const rows = await db.readAllSymbols();
    const readElapsedMs = Date.now() - readStartedAt;

    assert.ok(Array.isArray(rows));
    // Generous bound (writes alone reliably take much longer than this on
    // this machine) -- the point is "the read didn't wait for the writes,"
    // not a tight latency assertion that could flake on a slow CI box.
    assert.ok(readElapsedMs < 300, `expected the read to resolve without waiting on the write queue, took ${readElapsedMs}ms`);

    await writes; // let the background writes finish before teardown
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
