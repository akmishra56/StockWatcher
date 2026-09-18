/** GET /api/snapshot -- see docs/component_design.md §6. */
export function registerSnapshotRoutes(app, ctx) {
  app.get('/api/snapshot', async (req, reply) => {
    const { db } = ctx;
    // ?superFilter=all lets a caller (the Watchlists tab) explicitly bypass
    // the persisted dashboard filter -- a watchlist symbol outside that
    // filter would otherwise have no indicator data available at all, since
    // the WS feed's initial snapshot is scoped the same way. Ported from
    // v2/server/src/routes/snapshot.js.
    const superFilter = req.query?.superFilter ?? (await db.readSetting('super_filter')) ?? 'all';
    const rows = superFilter === 'all' ? await db.readLatestSnapshot() : await db.readDashboardSnapshot();
    return { rows, asOf: new Date().toISOString(), superFilter, connectionId: ctx.connectionId };
  });
}
