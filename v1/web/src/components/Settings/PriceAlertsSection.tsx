import { useEffect, useState } from 'react';
import { api, type PriceAlert, type PriceAlertDirection, type PriceAlertEvent, type TelegramConfig } from '../../api';

const EMPTY_FORM = { symbol: '', direction: 'above' as PriceAlertDirection, alertPrice: '' };
const EMPTY_TELEGRAM_FORM = { botToken: '', chatId: '' };

function statusBadge(status: PriceAlert['status']) {
  return status === 'triggered' ? (
    <span className="chip-sm" style={{ background: 'var(--gold)', color: '#221703' }}>TRIGGERED</span>
  ) : (
    <span className="chip-sm chip-sm-muted">WATCHING</span>
  );
}

/**
 * Settings > Price Alerts: configure a price level per symbol, see which
 * ones are currently triggered (showing in the bottom ticker bar) vs. still
 * watching, and browse the log of crossings that have rolled off the ticker
 * after their 24h window.
 */
export function PriceAlertsSection() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [logs, setLogs] = useState<PriceAlertEvent[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [telegram, setTelegram] = useState<TelegramConfig | null>(null);
  const [telegramForm, setTelegramForm] = useState(EMPTY_TELEGRAM_FORM);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [telegramBusy, setTelegramBusy] = useState(false);

  function refresh() {
    api.getPriceAlerts().then(setAlerts).catch(() => {});
    api.getPriceAlertLogs().then(setLogs).catch(() => {});
    api.getTelegramConfig().then(setTelegram).catch(() => {});
  }
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, []);

  async function toggleTelegramEnabled() {
    if (!telegram) return;
    await api.putTelegramConfig({ enabled: !telegram.enabled });
    refresh();
  }

  async function saveTelegramCredentials() {
    if (!telegramForm.botToken.trim() && !telegramForm.chatId.trim()) return;
    setTelegramBusy(true);
    setTelegramStatus(null);
    try {
      const patch: Partial<{ botToken: string; chatId: string }> = {};
      if (telegramForm.botToken.trim()) patch.botToken = telegramForm.botToken.trim();
      if (telegramForm.chatId.trim()) patch.chatId = telegramForm.chatId.trim();
      await api.putTelegramConfig(patch);
      setTelegramForm(EMPTY_TELEGRAM_FORM);
      setTelegramStatus('Saved.');
      refresh();
    } catch (err: any) {
      setTelegramStatus(err?.message ?? 'Failed to save');
    } finally {
      setTelegramBusy(false);
    }
  }

  async function sendTestNotification() {
    setTelegramBusy(true);
    setTelegramStatus('Sending…');
    try {
      await api.testTelegramNotification();
      setTelegramStatus('Test message sent -- check your Telegram chat.');
      refresh();
    } catch (err: any) {
      setTelegramStatus(err?.message ?? 'Test send failed');
      refresh();
    } finally {
      setTelegramBusy(false);
    }
  }

  async function addAlert() {
    const alertPrice = Number(form.alertPrice);
    if (!form.symbol.trim() || !(alertPrice > 0)) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.createPriceAlert({ symbol: form.symbol.trim().toUpperCase(), direction: form.direction, alertPrice });
      setForm(EMPTY_FORM);
      setStatus(`Added an alert for ${form.symbol.trim().toUpperCase()}.`);
      refresh();
    } catch (err: any) {
      setStatus(err?.message ?? 'Failed to add alert');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h3>Price Alerts</h3>
      <p className="text-2" style={{ fontSize: 12 }}>
        Set a price level for any tracked symbol. When the live price crosses it, the symbol flashes in the ticker
        bar at the bottom of every tab and stays in the rolling loop for 24 hours from the first crossing, then
        rolls off into the log below.
      </p>

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title">Telegram notifications</div>
        <p className="text-2" style={{ fontSize: 11.5, marginTop: 0 }}>
          Get a Telegram message the moment any alert above triggers, in addition to the ticker bar. Create a bot
          and a chat with @BotFather first -- ask if you need the steps.
        </p>
        {telegram && (
          <>
            <div className="param-group-fields">
              <label className="streaming-toggle">
                <input type="checkbox" checked={telegram.enabled} onChange={toggleTelegramEnabled} disabled={!telegram.hasToken || !telegram.chatId} />
                <span className="slider" />
                <span className="text-2" style={{ fontSize: 11 }}>Telegram alerts {telegram.enabled ? 'ON' : 'OFF'}</span>
              </label>
            </div>
            <div className="param-group-fields" style={{ marginTop: 8 }}>
              <label className="field">
                <span className="text-2" style={{ fontSize: 11 }}>Bot token {telegram.hasToken && <span className="text-3">(configured -- leave blank to keep)</span>}</span>
                <input
                  type="password"
                  value={telegramForm.botToken}
                  onChange={(e) => setTelegramForm({ ...telegramForm, botToken: e.target.value })}
                  placeholder={telegram.hasToken ? '••••••••' : '123456789:AAExample-BotToken'}
                  style={{ width: 260 }}
                />
              </label>
              <label className="field">
                <span className="text-2" style={{ fontSize: 11 }}>Chat ID</span>
                <input
                  value={telegramForm.chatId}
                  onChange={(e) => setTelegramForm({ ...telegramForm, chatId: e.target.value })}
                  placeholder={telegram.chatId ?? 'e.g. -1001234567890'}
                  style={{ width: 180 }}
                />
              </label>
              <button className="chip-toggle" disabled={telegramBusy || (!telegramForm.botToken.trim() && !telegramForm.chatId.trim())} onClick={saveTelegramCredentials}>
                Save
              </button>
              <button className="chip-toggle" disabled={telegramBusy || !telegram.hasToken || !telegram.chatId} onClick={sendTestNotification}>
                Send test
              </button>
            </div>
            {telegram.lastSentAtIst && (
              <p className="text-2" style={{ fontSize: 11, marginTop: 6 }}>
                Last send: {telegram.lastSentAtIst} --{' '}
                {telegram.lastStatus === 'ok' ? <span className="cell-pos">ok</span> : <span className="cell-neg" title={telegram.lastError ?? undefined}>failed: {telegram.lastError}</span>}
              </p>
            )}
            {telegramStatus && <p className="text-2" style={{ fontSize: 11, marginTop: 6 }}>{telegramStatus}</p>}
          </>
        )}
      </div>

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title">Configured alerts</div>
        <table style={{ width: '100%', marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Symbol</th>
              <th style={{ textAlign: 'left' }}>Direction</th>
              <th style={{ textAlign: 'right' }}>Alert price</th>
              <th style={{ textAlign: 'right' }}>Current price</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'left' }}>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td className="mono" style={{ fontWeight: 600 }}>{a.symbol}</td>
                <td className="text-2">{a.direction === 'above' ? 'Crosses above' : 'Crosses below'}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{a.alert_price.toFixed(2)}</td>
                <td className={`mono ${a.current_price != null && a.current_price >= a.alert_price ? 'cell-pos' : 'cell-neg'}`} style={{ textAlign: 'right' }}>
                  {a.current_price != null ? a.current_price.toFixed(2) : '-'}
                </td>
                <td>{statusBadge(a.status)}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={a.is_active}
                    onChange={async (e) => {
                      await api.updatePriceAlert(a.id, { isActive: e.target.checked });
                      refresh();
                    }}
                  />
                </td>
                <td>
                  <button
                    className="chip-toggle"
                    onClick={async () => {
                      await api.deletePriceAlert(a.id);
                      refresh();
                    }}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {alerts.length === 0 && (
              <tr>
                <td colSpan={7} className="text-3" style={{ padding: '10px 4px' }}>No price alerts configured yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title">Add a price alert</div>
        <div className="param-group-fields">
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Symbol</span>
            <input
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              placeholder="e.g. RELIANCE"
              style={{ width: 140 }}
            />
          </label>
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Direction</span>
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as PriceAlertDirection })}>
              <option value="above">Crosses above</option>
              <option value="below">Crosses below</option>
            </select>
          </label>
          <label className="field">
            <span className="text-2" style={{ fontSize: 11 }}>Alert price</span>
            <input
              type="number"
              min={0}
              step="0.05"
              value={form.alertPrice}
              onChange={(e) => setForm({ ...form, alertPrice: e.target.value })}
              placeholder="0.00"
              style={{ width: 120 }}
            />
          </label>
          <button className="chip-toggle" disabled={busy || !form.symbol.trim() || !(Number(form.alertPrice) > 0)} onClick={addAlert}>
            + Add alert
          </button>
        </div>
      </div>

      {status && <div className="text-2" style={{ fontSize: 11.5, marginTop: 10 }}>{status}</div>}

      <div className="param-group" style={{ marginTop: 16 }}>
        <div className="param-group-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span>Price alert logs</span>
          <span className="text-3" style={{ fontSize: 11, fontWeight: 400 }}>Entries leave the ticker bar 24h after first crossing and appear here</span>
        </div>
        <table style={{ width: '100%', marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Symbol</th>
              <th style={{ textAlign: 'right' }}>Price alert level</th>
              <th style={{ textAlign: 'right' }}>Price after crossed</th>
              <th style={{ textAlign: 'left' }}>Timestamp (slot)</th>
              <th style={{ textAlign: 'right' }}>Current price</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ fontWeight: 600 }}>{e.symbol}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{e.alert_price.toFixed(2)}</td>
                <td className={`mono ${e.direction === 'above' ? 'cell-pos' : 'cell-neg'}`} style={{ textAlign: 'right' }}>{e.price_after_crossed.toFixed(2)}</td>
                <td className="text-2 mono" style={{ fontSize: 11 }}>{e.slot_ts_ist}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{e.current_price != null ? e.current_price.toFixed(2) : '-'}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="text-3" style={{ padding: '10px 4px' }}>No expired alerts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
