import { randomUUID } from 'node:crypto';
import { IndicatorEngine } from '../indicators/state.js';
import { nowIst } from '../time.js';
import { startRecalculateJob, getJob, isRecalculateRunning } from '../jobs/recalculate.js';

export const DEFAULT_COLOR_RULES = {
  rsiOversold: { threshold: 30, bg: '#c81e3f', text: '#ffffff', enabled: true },
  rsiOverbought: { threshold: 70, bg: '#f5a623', text: '#221703', enabled: true },
  priceChangeAlert: { threshold: 2.0, posBg: '#39ff88', negBg: '#ff3b5c', enabled: true },
  bollingerCross: { enabled: true },
  supertrendDirection: { enabled: true },
};

/** GET/PUT /api/settings -- see docs/component_design.md §6. */
export function registerSettingsRoutes(app, ctx) {
  app.get('/api/settings', async () => {
    const { db } = ctx;
    const indicators = (await db.readSetting('indicators')) ?? IndicatorEngine.DEFAULT_PARAMS;
    const colorRules = (await db.readSetting('colorRules')) ?? DEFAULT_COLOR_RULES;
    const superFilter = (await db.readSetting('super_filter')) ?? 'all';
    return { indicators, colorRules, superFilter };
  });

  app.put('/api/settings', async (req) => {
    const { db, indicatorEngine, refreshColorRules, refreshSuperFilter } = ctx;
    const { indicators, colorRules, superFilter } = req.body ?? {};
    const ts = nowIst();
    if (indicators) {
      // A caller may send only the indicator(s) it's changing (e.g. just
      // { rsi: { period: 21 } }) -- merge one level deep onto the current
      // params rather than replacing the whole object, or every other
      // indicator's params would silently vanish (see docs/issues.md).
      const merged = mergeIndicatorParams(indicatorEngine.params, indicators);
      await db.writeSetting('indicators', merged, ts);
      indicatorEngine.params = merged; // takes effect on the *next* cycle only -- no recompute here
    }
    if (colorRules) {
      await db.writeSetting('colorRules', colorRules, ts);
      await refreshColorRules?.(); // refreshes FilterEngine's synchronous colorRules cache
    }
    if (superFilter) {
      await db.writeSetting('super_filter', superFilter, ts);
      await refreshSuperFilter?.();
    }
    return { ok: true };
  });

  app.post('/api/settings/recalculate', async (req, reply) => {
    const { db, indicatorEngine } = ctx;
    // Without this, hitting Recalculate All again while one is already
    // running started a second concurrent job over the same tables --
    // wasteful, and if a parameter changed between the two calls, a race
    // (whichever job's write for a given row lands last wins, arbitrarily).
    if (isRecalculateRunning()) {
      reply.code(409);
      return { error: 'A recalculation is already running -- wait for it to finish, or check its progress via the returned jobId.' };
    }
    const jobId = randomUUID();
    startRecalculateJob(jobId, { db, indicatorEngine });
    return { jobId };
  });

  app.get('/api/settings/recalculate/:jobId', async (req, reply) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'unknown jobId' };
    }
    return job;
  });
}

function mergeIndicatorParams(current, patch) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = typeof value === 'object' && value !== null ? { ...current[key], ...value } : value;
  }
  return merged;
}
