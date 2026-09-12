/**
 * Rolling on-disk DB checkpoints, taken after every regular (non-premarket,
 * non-manual) 1-hour-interval scheduled cycle -- see scheduler.js's _tick().
 * Motivated directly by the 2026-09-09 WAL-corruption incident
 * (docs/issues.md): the main .duckdb file only reflects reality as of its
 * last CHECKPOINT, and everything since then lives solely in the WAL, at
 * risk from any ungraceful shutdown. This both shrinks that at-risk window
 * every scheduled cycle AND leaves a rolling set of restore points on disk.
 *
 * Deliberately scoped to the automatic interval tick only -- not premarket,
 * not "Run Now", not Backfill -- per explicit instruction ("every 1hr
 * scheduled run"), so a burst of manual runs can't churn through the
 * 10-checkpoint budget.
 */
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_CHECKPOINTS = 10;

function fileSafeTs(tsIst) {
  return tsIst.replace(/[: ]/g, '-');
}

/**
 * Checkpoints the live DB (shrinks its own WAL) then clones it into a new
 * timestamped file under data/checkpoints/<connectionId>/ via DuckDB's own
 * engine (db.cloneDatabaseTo -- NOT an OS-level file copy: on Windows,
 * DuckDB holds an exclusive handle on the live .duckdb file for as long as
 * the server runs, so a plain file copy against that path fails with EBUSY,
 * or worse, races DuckDB's own writes into a torn file), then purges
 * everything beyond the newest MAX_CHECKPOINTS.
 *
 * @param {import('./db/client.js').DbClient} db
 * @param {string} connectionId
 * @param {string} scheduledTsIst
 * @returns {Promise<string>} path to the saved checkpoint file
 */
export async function saveScheduledCheckpoint(db, connectionId, scheduledTsIst) {
  await db.checkpoint();

  const dir = path.join(config.checkpointsDir, connectionId ?? 'default');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dest = path.join(dir, `watchlist-${fileSafeTs(scheduledTsIst)}.duckdb`);
  await db.cloneDatabaseTo(dest);

  purgeOldCheckpoints(dir);
  return dest;
}

function purgeOldCheckpoints(dir) {
  // Filenames embed 'YYYY-MM-DD-HH-MM-SS', which sorts chronologically as a
  // plain string -- no need to trust filesystem mtimes (copy/backup tools
  // can rewrite those).
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.duckdb'))
    .sort()
    .reverse(); // newest first

  for (const stale of files.slice(MAX_CHECKPOINTS)) {
    unlinkSync(path.join(dir, stale));
  }
}
