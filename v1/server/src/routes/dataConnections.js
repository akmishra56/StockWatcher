const VALID_KINDS = new Set(['csv', 'broker']);
// The set of broker clients server.js's activateConnection knows how to
// build -- kept here too (not just in server.js) so this route can reject
// an unknown brokerType at creation time instead of failing silently at
// activation time.
const VALID_BROKER_TYPES = new Set(['fyers']);

/**
 * GET /api/data-connections, POST /api/data-connections, POST
 * /api/data-connections/:id/activate -- the Settings switcher for which
 * isolated database (registry.js) backs the dashboard right now, plus
 * adding a new connection (e.g. a broker bridge). Switching never touches
 * another connection's database file (docs/architecture.md §2b).
 */
export function registerDataConnectionRoutes(app, ctx, activateConnection) {
  app.get('/api/data-connections', async () => ({
    activeId: ctx.registry.getActiveId(),
    connections: ctx.registry.list(),
  }));

  app.post('/api/data-connections', async (req, reply) => {
    const { id, label, kind, brokerType } = req.body ?? {};
    if (!id || !label || !VALID_KINDS.has(kind)) {
      reply.code(400);
      return { error: `id, label, and kind (${[...VALID_KINDS].join('|')}) are required` };
    }
    if (kind === 'broker' && !VALID_BROKER_TYPES.has(brokerType)) {
      reply.code(400);
      return { error: `brokerType must be one of: ${[...VALID_BROKER_TYPES].join(', ')}` };
    }
    if (ctx.registry.get(id)) {
      reply.code(409);
      return { error: `Connection already exists: ${id}` };
    }
    const connection = ctx.registry.add({ id, label, kind, brokerType: kind === 'broker' ? brokerType : null });
    return { ok: true, connection };
  });

  app.post('/api/data-connections/:id/activate', async (req, reply) => {
    const { id } = req.params;
    const connection = ctx.registry.get(id);
    if (!connection) {
      reply.code(404);
      return { error: `Unknown connection: ${id}` };
    }
    if (connection.isPlaceholder) {
      reply.code(400);
      return { error: `${connection.label} is not yet available -- placeholder connection` };
    }
    if (id === ctx.connectionId) {
      return { ok: true, activeId: id, note: 'already active' };
    }
    ctx.registry.setActive(id);
    await activateConnection(id);
    return { ok: true, activeId: id };
  });
}
