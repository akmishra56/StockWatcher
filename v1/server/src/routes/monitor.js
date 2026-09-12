/** GET /api/monitor-log -- ingestion cycle history incl. missing-symbol detail. */
export function registerMonitorRoutes(app, ctx) {
  app.get('/api/monitor-log', async (req) => {
    const limit = req.query?.limit ? Number(req.query.limit) : 20;
    return ctx.db.readMonitorLogWithMissing(limit);
  });
}
