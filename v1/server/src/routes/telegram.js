/**
 * Settings > Price Alerts' Telegram notification config, plus a test-send.
 * The bot token is write-only from the frontend's perspective -- GET never
 * echoes it back (same precedent as GET /api/broker/status, which returns a
 * derived `authenticated` boolean rather than the stored secret), just a
 * `hasToken` boolean so the UI can show "configured" without the secret
 * ever round-tripping to the browser after the initial save.
 * Ported unchanged from v2/server/src/routes/telegram.js.
 */
import { nowIst } from '../time.js';
import { sendTelegramMessage } from '../telegram/notifier.js';

const DEFAULT_CONFIG = { enabled: false, botToken: null, chatId: null, lastSentAtIst: null, lastStatus: null, lastError: null };

export function registerTelegramRoutes(app, ctx) {
  app.get('/api/telegram/config', async () => {
    const config = (await ctx.db.readSetting('telegram')) ?? DEFAULT_CONFIG;
    const { botToken, ...rest } = config;
    return { ...rest, hasToken: Boolean(botToken) };
  });

  app.put('/api/telegram/config', async (req) => {
    const { db } = ctx;
    const current = (await db.readSetting('telegram')) ?? DEFAULT_CONFIG;
    const { enabled, botToken, chatId } = req.body ?? {};
    const next = {
      ...current,
      ...(enabled !== undefined ? { enabled } : {}),
      // Empty string clears a previously-saved token/chatId; undefined leaves it untouched.
      ...(botToken !== undefined ? { botToken: botToken || null } : {}),
      ...(chatId !== undefined ? { chatId: chatId || null } : {}),
    };
    await db.writeSetting('telegram', next, nowIst());
    return { ok: true };
  });

  app.post('/api/telegram/test', async (req, reply) => {
    const { db } = ctx;
    const config = (await db.readSetting('telegram')) ?? DEFAULT_CONFIG;
    const result = await sendTelegramMessage(config, '✅ StockWatcher: this is a test notification. Telegram alerts are working.');
    const ts = nowIst();
    await db.writeSetting('telegram', { ...config, lastSentAtIst: ts, lastStatus: result.ok ? 'ok' : 'failed', lastError: result.ok ? null : result.error }, ts);
    if (!result.ok) {
      reply.code(400);
      return { ok: false, error: result.error };
    }
    return { ok: true };
  });
}
