/**
 * A single process-wide queue that every scheduled scrape/fetch trigger
 * runs through -- an interval scheduler's own ticks, its premarket run, and
 * manual Run Now / Backfill actions, across every data-source connection.
 * Without this, a manual trigger landing close to a scheduled tick (or a
 * connection switch mid-cycle) could launch two concurrent hits against the
 * same external source at once. Guarantees:
 *   1. mutual exclusion -- only one queued task's body executes at a time.
 *   2. at least `minGapMs` between the END of one task and the START of the
 *      next, even back-to-back callers, on top of the 2-minute
 *      indices->equity gap already enforced *within* a single NSE cycle.
 * Module-scope singleton (like ws/broadcaster.js) rather than per-Scheduler,
 * since rate-limiting is a property of the external source being hit, not
 * of any one connection's Scheduler instance.
 *
 * The gap is caller-supplied per call (Settings > Automation & Scheduler >
 * "Minimum gap between runs", persisted per data-source connection in
 * scheduler_config.min_run_gap_seconds) rather than a fixed constant here,
 * since NSE's Playwright scrape and a future broker API/webhook connection
 * warrant very different floors (NSE needs real spacing to avoid looking
 * like abuse; a broker REST call can safely run every ~1 minute).
 */
const DEFAULT_MIN_GAP_MS = Number(process.env.SW_SCRAPE_MIN_GAP_MS ?? 2 * 60 * 1000);

let queueTail = Promise.resolve();
let lastFinishedAt = 0;

export function enqueueScrape(taskFn, minGapMs = DEFAULT_MIN_GAP_MS) {
  const run = queueTail.then(async () => {
    const elapsed = Date.now() - lastFinishedAt;
    if (lastFinishedAt > 0 && elapsed < minGapMs) await sleep(minGapMs - elapsed);
    try {
      return await taskFn();
    } finally {
      lastFinishedAt = Date.now();
    }
  });
  // One failed task must never wedge every task queued after it.
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
