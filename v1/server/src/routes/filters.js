import { randomUUID } from 'node:crypto';
import { nowIst } from '../time.js';
import { evaluateFilter, withDerivedFields } from '../filters/conditions.js';
import { appendMembershipLogFile } from '../logging/membershipLogFile.js';

/** GET/POST/PUT/DELETE /api/filters, GET /api/logs -- docs/component_design.md §6. */
export function registerFilterRoutes(app, ctx) {
  app.get('/api/filters', async () => {
    const rows = await ctx.db.all('SELECT * FROM filters ORDER BY created_at');
    return rows.map(rowToFilter);
  });

  app.post('/api/filters', async (req, reply) => {
    const { db } = ctx;
    const { name, conditionTree } = req.body ?? {};
    if (!name || !conditionTree) {
      reply.code(400);
      return { error: 'name and conditionTree are required' };
    }
    const id = randomUUID();
    const createdAt = nowIst();
    await db.run(
      'INSERT INTO filters (id, name, condition_json, is_active, created_at) VALUES (?, ?, ?, TRUE, ?)',
      id, name, JSON.stringify(conditionTree), createdAt
    );

    // A brand-new filter can instantly match symbols against the CURRENT
    // snapshot (the Dashboard's "matching now" list -- GET
    // /api/filters/:id/matches -- reflects that immediately), but
    // FilterEngine.reevaluateAll (filters/engine.js) only logs a transition
    // on the NEXT ingest cycle, diffed against lastKnownMatches -- which has
    // no entry yet for a filter that didn't exist at boot. Left alone, the
    // Membership Log would silently show nothing until the next scrape/
    // upload, even though the sidebar already shows real matches. reconcileMembershipLog
    // diffs against the (empty) baseline itself, so every current match logs as 'added'.
    await reconcileMembershipLog(ctx, id, conditionTree, createdAt);

    return { id, name, conditionTree, isActive: true, createdAt };
  });

  app.put('/api/filters/:id', async (req, reply) => {
    const { db } = ctx;
    const { name, conditionTree, isActive } = req.body ?? {};
    const existing = await db.all('SELECT * FROM filters WHERE id = ?', req.params.id);
    if (existing.length === 0) {
      reply.code(404);
      return { error: 'not found' };
    }
    await db.run(
      'UPDATE filters SET name = COALESCE(?, name), condition_json = COALESCE(?, condition_json), is_active = COALESCE(?, is_active) WHERE id = ?',
      name ?? null, conditionTree ? JSON.stringify(conditionTree) : null, isActive ?? null, req.params.id
    );

    // Editing conditions can instantly change what matches (e.g. removing a
    // condition widens the match set) -- same gap as creation above:
    // without this, the Membership Log stays silent about that change until
    // the next real ingest cycle (which may be hours away, or -- outside
    // market hours -- may not come today at all). Diffs against whatever
    // lastKnownMatches already held for this filter, so only the REAL
    // transition (symbols that newly match / no longer match under the
    // edited conditions) gets logged, not a wholesale re-add of everything.
    if (conditionTree) {
      await reconcileMembershipLog(ctx, req.params.id, conditionTree, nowIst());
    }

    const [row] = await db.all('SELECT * FROM filters WHERE id = ?', req.params.id);
    return rowToFilter(row);
  });

  app.delete('/api/filters/:id', async (req) => {
    await ctx.db.run('DELETE FROM filters WHERE id = ?', req.params.id);
    ctx.filterEngine?.lastKnownMatches.delete(req.params.id);
    return { ok: true };
  });

  app.get('/api/logs', async (req) => {
    const { filterId, limit } = req.query ?? {};
    return ctx.db.readMembershipLog(filterId, limit ? Number(limit) : 50);
  });

  // Live matching-symbol list for the FilterBar's saved-filter tabs --
  // evaluated on demand against the current snapshot rather than cached,
  // so it's always correct even between ingest cycles.
  app.get('/api/filters/:id/matches', async (req, reply) => {
    const { db, getColorRules } = ctx;
    const [row] = await db.all('SELECT * FROM filters WHERE id = ?', req.params.id);
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    const tree = JSON.parse(row.condition_json);
    const [snapshot, previousMap] = await Promise.all([db.readLatestSnapshot(), db.readPreviousSnapshotMap()]);
    const colorRules = getColorRules?.() ?? {};
    const matches = snapshot
      .map((r) => withDerivedFields(r, colorRules))
      .filter((r) => evaluateFilter(r, tree, previousMap.get(r.symbol)))
      .map((r) => r.symbol);
    return { filterId: row.id, matches };
  });

  // GET /api/monitor-log lives in routes/monitor.js.
}

function rowToFilter(row) {
  return {
    id: row.id, name: row.name, conditionTree: JSON.parse(row.condition_json),
    isActive: row.is_active, createdAt: row.created_at,
  };
}

/**
 * Evaluates conditionTree against the CURRENT snapshot, diffs the result
 * against FilterEngine.lastKnownMatches for this filter (empty for a
 * brand-new filter, so every match logs as 'added'; whatever the engine
 * already had for an edited filter, so only the real transition logs), and
 * writes/broadcasts/mirrors-to-disk exactly those transitions -- then
 * updates lastKnownMatches to the new baseline so the next real ingest
 * cycle's own diff (filters/engine.js) doesn't re-log the same symbols.
 * Shared by POST (new filter) and PUT (edited conditions) -- both are
 * "this filter's matches just changed outside of a normal ingest cycle."
 */
async function reconcileMembershipLog(ctx, filterId, conditionTree, tsIst) {
  const { db, filterEngine, broadcaster, getColorRules, logsDir } = ctx;
  const [snapshot, previousMap] = await Promise.all([db.readLatestSnapshot(), db.readPreviousSnapshotMap()]);
  const colorRules = getColorRules?.() ?? {};
  const newMatches = new Set(
    snapshot
      .map((r) => withDerivedFields(r, colorRules))
      .filter((r) => evaluateFilter(r, conditionTree, previousMap.get(r.symbol)))
      .map((r) => r.symbol)
  );
  const previousMatches = filterEngine?.lastKnownMatches.get(filterId) ?? new Set();

  const logRows = [];
  for (const symbol of newMatches) {
    if (!previousMatches.has(symbol)) logRows.push({ filterId, symbol, action: 'added', ts_ist: tsIst });
  }
  for (const symbol of previousMatches) {
    if (!newMatches.has(symbol)) logRows.push({ filterId, symbol, action: 'removed', ts_ist: tsIst });
  }

  if (logRows.length > 0) {
    await db.writeMembershipLog(logRows);
    appendMembershipLogFile(logsDir, logRows);
    // Same filterId -> filter_id translation as ingestPipeline.js's publish
    // -- the WS wire format is snake_case, these logRows are camelCase.
    broadcaster?.publish({
      type: 'log:new',
      entries: logRows.map((r) => ({ filter_id: r.filterId, symbol: r.symbol, action: r.action, ts_ist: r.ts_ist })),
    });
  }
  filterEngine?.lastKnownMatches.set(filterId, newMatches);
}
