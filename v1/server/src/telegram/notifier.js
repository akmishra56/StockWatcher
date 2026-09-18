/**
 * Sends a price-alert notification to a Telegram chat via the Bot API's
 * sendMessage endpoint -- plain HTTPS POST, no SDK, no new dependency (Node
 * 20+ has global fetch). Config (bot token, chat id) lives in the standard
 * `settings` table under the 'telegram' key, same pattern FyersClient.js
 * uses for broker credentials -- this app has no encryption layer; it's
 * local and single-user, so that's consistent with every other secret
 * already stored that way, not a new risk this feature introduces.
 * Ported unchanged from v2/server/src/telegram/notifier.js.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * @param {{ botToken: string, chatId: string }} config
 * @param {string} text  HTML-formatted message body (parse_mode: 'HTML')
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function sendTelegramMessage(config, text) {
  if (!config?.botToken || !config?.chatId) {
    return { ok: false, error: 'Telegram is not configured (missing bot token or chat id)' };
  }
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      // Telegram's own error text (body.description) is far more actionable
      // than a bare status code -- e.g. "Unauthorized" (bad token) vs. "chat
      // not found" (bad chat id, or the bot was never added to it).
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message ?? 'network error' };
  }
}

/** One price-alert crossing -> the message text sent to Telegram. */
export function formatPriceAlertMessage(event) {
  const up = event.direction === 'above';
  const arrow = up ? '\u{1F53A}' : '\u{1F53B}'; // 🔺 / 🔻
  const verb = up ? 'crossed above' : 'crossed below';
  return (
    `${arrow} <b>${escapeHtml(event.symbol)}</b> ${verb} ₹${event.alertPrice.toFixed(2)}\n` +
    `Price now: ₹${event.priceAfterCrossed.toFixed(2)}\n` +
    `${escapeHtml(event.triggeredAtIst)} IST`
  );
}

// Telegram message length cap is 4096 chars; several symbols can enter
// several filters in the same ingest cycle, so this caps the digest rather
// than risking a send that Telegram itself rejects.
const MAX_DIGEST_ITEMS = 12;

/**
 * A cycle's newly-entering filter-membership rows -> one digest message,
 * same reasoning as the (v2-only) news digest: one ingest cycle can produce
 * several 'added' transitions at once (several symbols entering the same
 * filter, or several filters at once), and a message per row would spam the
 * chat / risk Telegram's rate limit. Mirrors the Membership Log panel's own
 * line format ("<symbol> added to <filter name>") so the Telegram message
 * reads the same as what's already on screen.
 * @param {{ symbol: string, filterName: string, ts_ist: string }[]} entries
 */
export function formatMembershipAlertMessage(entries) {
  const shown = entries.slice(0, MAX_DIGEST_ITEMS);
  const lines = shown.map((e) => `\u{1F7E2} <b>${escapeHtml(e.symbol)}</b> added to ${escapeHtml(e.filterName)}`);
  const overflow = entries.length - shown.length;
  if (overflow > 0) lines.push(`…and ${overflow} more`);
  return `${lines.join('\n')}\n${escapeHtml(entries[0].ts_ist)} IST`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
