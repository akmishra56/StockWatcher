/** GET /api/snapshot -- see docs/component_design.md §6. */
export function registerSnapshotRoutes(app, ctx) {
  app.get('/api/snapshot', async (req, reply) => {
    const { db } = ctx;
    const superFilter = (await db.readSetting('super_filter')) ?? 'all';
    const rows = superFilter === 'all' ? await db.readLatestSnapshot() : await db.readDashboardSnapshot();
    return { rows, asOf: new Date().toISOString(), superFilter, connectionId: ctx.connectionId };
  });
}
