/** /ws -- registers new connections with the broadcaster and sends initial hydration. */
export function registerWsRoute(app, ctx) {
  app.get('/ws', { websocket: true }, async (socket) => {
    ctx.broadcaster.add(socket);
    const { db } = ctx;
    const superFilter = (await db.readSetting('super_filter')) ?? 'all';
    const rows = superFilter === 'all' ? await db.readLatestSnapshot() : await db.readDashboardSnapshot();
    socket.send(JSON.stringify({ type: 'snapshot:update', rows, initial: true }));
  });
}
