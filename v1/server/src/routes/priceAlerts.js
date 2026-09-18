/**
 * Settings > Price Alerts CRUD, plus the two read-only feeds the bottom
 * ticker bar and the Settings log table poll: GET /ticker (events still in
 * their 24h window) and GET /logs (events that have rolled off it). Crossing
 * detection itself lives in priceAlerts/engine.js, run once per ingest
 * cycle -- this file only manages the alert configs and serves the results.
 * Ported unchanged from v2/server/src/routes/priceAlerts.js.
 */
import { randomUUID } from 'node:crypto';
import { nowIst } from '../time.js';

const DIRECTIONS = new Set(['above', 'below']);

export function registerPriceAlertRoutes(app, ctx) {
  app.get('/api/price-alerts', async () => {
    const { db } = ctx;
    const [alerts, activeEvents, latestPrices] = await Promise.all([
      db.readPriceAlerts(),
      db.readActivePriceAlertEvents(nowIst()),
      db.readLatestSnapshotMap(),
    ]);
    return alerts.map((a) => ({
      ...a,
      current_price: latestPrices.get(a.symbol)?.close ?? null,
      status: activeEvents.has(a.id) ? 'triggered' : 'watching',
    }));
  });

  app.post('/api/price-alerts', async (req, reply) => {
    const { symbol, direction, alertPrice } = req.body ?? {};
    if (!symbol || !DIRECTIONS.has(direction) || typeof alertPrice !== 'number' || !(alertPrice > 0)) {
      reply.code(400);
      return { error: 'symbol, direction ("above"|"below"), and a positive alertPrice are required' };
    }
    const known = await ctx.db.readAllSymbols();
    if (!known.includes(symbol)) {
      reply.code(400);
      return { error: `unknown symbol: ${symbol}` };
    }
    const id = randomUUID();
    await ctx.db.createPriceAlert({ id, symbol, direction, alertPrice, createdAt: nowIst() });
    return { id, symbol, direction, alert_price: alertPrice, is_active: true, created_at: nowIst() };
  });

  app.put('/api/price-alerts/:id', async (req, reply) => {
    const { direction, alertPrice, isActive } = req.body ?? {};
    if (direction !== undefined && !DIRECTIONS.has(direction)) {
      reply.code(400);
      return { error: 'direction must be "above" or "below"' };
    }
    if (alertPrice !== undefined && !(typeof alertPrice === 'number' && alertPrice > 0)) {
      reply.code(400);
      return { error: 'alertPrice must be a positive number' };
    }
    await ctx.db.updatePriceAlert(req.params.id, { direction, alertPrice, isActive });
    return { ok: true };
  });

  app.delete('/api/price-alerts/:id', async (req) => {
    await ctx.db.deletePriceAlert(req.params.id);
    return { ok: true };
  });

  /** Bottom ticker bar: events still inside their 24h window, newest first. */
  app.get('/api/price-alerts/ticker', async () => {
    return ctx.db.readActivePriceAlertTicker(nowIst());
  });

  /** Settings > Price Alerts log: events that have rolled off the ticker. */
  app.get('/api/price-alerts/logs', async (req) => {
    const limit = req.query?.limit ? Number(req.query.limit) : 200;
    return ctx.db.readPriceAlertLog(nowIst(), limit);
  });
}
