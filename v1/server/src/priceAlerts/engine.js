/**
 * Detects price-alert crossings once per ingest cycle (ingestPipeline.js
 * calls reevaluateAll after writing this cycle's snapshot_window rows, same
 * position FilterEngine.reevaluateAll runs from). Reuses the exact
 * edge-triggered crosses_above/crosses_below semantics filters/conditions.js
 * already implements for saved filters -- an alert is just a one-condition
 * filter comparing `close` against a fixed alert_price instead of another
 * field. Ported unchanged from v2/server/src/priceAlerts/engine.js.
 */
import { evaluateCondition } from '../filters/conditions.js';

export class PriceAlertEngine {
  /**
   * @param {import('../db/client.js').DbClient} db
   * @param {{ onEvents?: (events: object[]) => Promise<void> }} [deps]
   *   onEvents fires after this cycle's new events are persisted (e.g. the
   *   Telegram bridge, server.js) -- fire-and-forget from this engine's
   *   perspective: reevaluateAll awaits it (so a caller's own await sees the
   *   notification attempt complete) but a rejection is swallowed here, not
   *   propagated, so a bad bot token or a Telegram outage can never break an
   *   ingest cycle.
   */
  constructor(db, deps = {}) {
    this.db = db;
    this.onEvents = deps.onEvents;
  }

  /**
   * @param {object[]} snapshot  this cycle's rows (already includes indicator outputs)
   * @param {string} scheduledTsIst  the cycle's scheduled slot -- stored as slot_ts_ist
   * @param {string} [actualTsIst]  real wall-clock time the cycle ran -- stored as
   *   triggered_at_ist (what the 24h ticker window is measured from); falls
   *   back to scheduledTsIst when a caller has no separate actual time (e.g. tests)
   * @returns {Promise<{ events: object[] }>} newly-created events this cycle, for the WS broadcast
   */
  async reevaluateAll(snapshot, scheduledTsIst, actualTsIst) {
    const alerts = await this.db.readActivePriceAlerts();
    if (alerts.length === 0) return { events: [] };

    const triggeredAtIst = actualTsIst ?? scheduledTsIst;
    const [previousMap, activeEventMap] = await Promise.all([
      this.db.readPreviousSnapshotMap(),
      this.db.readActivePriceAlertEvents(triggeredAtIst),
    ]);
    const rowBySymbol = new Map(snapshot.map((r) => [r.symbol, r]));

    const events = [];
    for (const alert of alerts) {
      const row = rowBySymbol.get(alert.symbol);
      if (!row) continue; // symbol not in this cycle's bars

      const cond = { field: 'close', operator: alert.direction === 'above' ? 'crosses_above' : 'crosses_below', value: alert.alert_price };
      if (!evaluateCondition(row, cond, previousMap.get(alert.symbol))) continue;

      // Already has a live (< 24h old) event -- price oscillating around the
      // level re-qualifies every cycle, but it stays ONE activation, not one
      // event per tick.
      if (activeEventMap.has(alert.id)) continue;

      const event = {
        alertId: alert.id, symbol: alert.symbol, direction: alert.direction, alertPrice: alert.alert_price,
        priceAfterCrossed: row.close, slotTsIst: scheduledTsIst, triggeredAtIst,
      };
      const id = await this.db.insertPriceAlertEvent(event);
      events.push({ id, ...event });
    }
    if (events.length > 0 && this.onEvents) {
      await this.onEvents(events).catch(() => {});
    }
    return { events };
  }
}
