/**
 * CRUD for the Watchlists tab's left panel: named groups of symbols. Symbol
 * additions are constrained to the tracked universe (symbols table) so a
 * watchlist entry always has indicator values available.
 * Ported unchanged from v2/server/src/routes/watchlists.js.
 */
import { randomUUID } from 'node:crypto';
import { nowIst } from '../time.js';

export function registerWatchlistRoutes(app, ctx) {
  app.get('/api/watchlists', async () => {
    const { db } = ctx;
    const [watchlists, symbolRows] = await Promise.all([db.readWatchlists(), db.readAllWatchlistSymbols()]);
    const byWatchlist = new Map();
    for (const row of symbolRows) {
      if (!byWatchlist.has(row.watchlist_id)) byWatchlist.set(row.watchlist_id, []);
      byWatchlist.get(row.watchlist_id).push(row.symbol);
    }
    return watchlists.map((w) => ({ ...w, symbols: byWatchlist.get(w.id) ?? [] }));
  });

  app.post('/api/watchlists', async (req, reply) => {
    const { name } = req.body ?? {};
    if (!name || !name.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const id = randomUUID();
    await ctx.db.createWatchlist({ id, name: name.trim(), createdAt: nowIst() });
    return { id, name: name.trim(), symbols: [] };
  });

  app.put('/api/watchlists/:id', async (req, reply) => {
    const { name } = req.body ?? {};
    if (!name || !name.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    await ctx.db.renameWatchlist(req.params.id, name.trim());
    return { ok: true };
  });

  app.delete('/api/watchlists/:id', async (req) => {
    await ctx.db.deleteWatchlist(req.params.id);
    return { ok: true };
  });

  app.post('/api/watchlists/:id/symbols', async (req, reply) => {
    const { symbol } = req.body ?? {};
    if (!symbol) {
      reply.code(400);
      return { error: 'symbol is required' };
    }
    const known = await ctx.db.readAllSymbols();
    if (!known.includes(symbol)) {
      reply.code(400);
      return { error: `unknown symbol: ${symbol}` };
    }
    await ctx.db.addWatchlistSymbol(req.params.id, symbol, nowIst());
    return { ok: true };
  });

  app.delete('/api/watchlists/:id/symbols/:symbol', async (req) => {
    await ctx.db.removeWatchlistSymbol(req.params.id, req.params.symbol);
    return { ok: true };
  });
}
