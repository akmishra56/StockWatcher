/**
 * GET/PUT /api/scheduler, POST /api/scheduler/run-now -- docs/component_design.md
 * §6, extended for market-hours/weekday-gated Yahoo Finance orchestration
 * (see scheduler.js and marketHours.js). v1 has no premarket run and no
 * scraper-run health log (both were NSE/Playwright-specific).
 */
import { isMarketOpenNow } from '../marketHours.js';
import { nowIst } from '../time.js';

export function registerSchedulerRoutes(app, ctx) {
  app.get('/api/scheduler', async () => {
    const { scheduler } = ctx;
    const row = await ctx.db.readSchedulerConfig();
    return {
      intervalMinutes: scheduler.intervalMinutes,
      enabled: scheduler.enabled,
      marketOpenTime: scheduler.marketOpenTime,
      marketCloseTime: scheduler.marketCloseTime,
      activeWeekdays: scheduler.activeWeekdays,
      holidays: scheduler.holidays,
      minRunGapSeconds: scheduler.minRunGapSeconds,
      nextRunAtIst: row.next_run_at_ist ?? null,
      lastRunAtIst: row.last_run_at_ist ?? null,
      nowIst: nowIst(),
      isMarketOpen: isMarketOpenNow(scheduler, nowIst()),
    };
  });

  app.put('/api/scheduler', async (req) => {
    const { scheduler } = ctx;
    const { intervalMinutes, enabled, marketOpenTime, marketCloseTime, activeWeekdays, holidays, minRunGapSeconds } = req.body ?? {};
    if (typeof intervalMinutes === 'number') await scheduler.setInterval(intervalMinutes);
    if (typeof enabled === 'boolean') await scheduler.setEnabled(enabled);
    if (marketOpenTime && marketCloseTime) await scheduler.setMarketHours(marketOpenTime, marketCloseTime);
    if (activeWeekdays) await scheduler.setActiveWeekdays(activeWeekdays);
    if (Array.isArray(holidays)) await scheduler.setHolidays(holidays);
    if (typeof minRunGapSeconds === 'number' && minRunGapSeconds >= 0) await scheduler.setMinRunGapSeconds(minRunGapSeconds);
    return { ok: true };
  });

  app.post('/api/scheduler/run-now', async (req, reply) => {
    const { scheduler } = ctx;
    if (!scheduler.enabled) {
      reply.code(409);
      return { error: 'Automation is toggled off' };
    }
    if (scheduler.isRunning()) {
      reply.code(409);
      return { error: 'A fetch+ingest cycle is already running' };
    }
    // Fires the cycle without awaiting it -- ~50 sequential Yahoo requests
    // easily runs past any reasonable HTTP timeout. The frontend just shows
    // the "Started" note; the next snapshot poll picks up the result.
    scheduler.runNow().catch((err) => req.log.error({ err }, 'scheduler.runNow failed'));
    return { ok: true, note: 'Started.' };
  });
}
