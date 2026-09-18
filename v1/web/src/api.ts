/** Thin fetch wrappers for every REST endpoint in server/src/routes/. */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

export type Settings = {
  indicators: Record<string, Record<string, number>>;
  colorRules: Record<string, any>;
  superFilter: 'nifty50';
};

export type HistorySuperFilter = 'nifty50';

export const api = {
  getSettings: () => fetch('/api/settings').then((r) => json<Settings>(r)),
  getSnapshot: (superFilter?: 'all') =>
    fetch(`/api/snapshot${superFilter ? `?superFilter=${superFilter}` : ''}`).then((r) =>
      json<{ rows: Record<string, unknown>[]; asOf: string; superFilter: string }>(r)
    ),
  putSettings: (patch: Partial<Settings>) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: true }>(r)),

  startRecalculate: () =>
    fetch('/api/settings/recalculate', { method: 'POST' }).then((r) => json<{ jobId: string }>(r)),
  getRecalculateJob: (jobId: string) =>
    fetch(`/api/settings/recalculate/${jobId}`).then((r) => json<{ status: string; processed: number; total: number; error?: string }>(r)),

  getFilters: () => fetch('/api/filters').then((r) => json<any[]>(r)),
  createFilter: (name: string, conditionTree: any) =>
    fetch('/api/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, conditionTree }),
    }).then((r) => json<any>(r)),
  updateFilter: (id: string, patch: { name?: string; conditionTree?: any; isActive?: boolean }) =>
    fetch(`/api/filters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<any>(r)),
  deleteFilter: (id: string) => fetch(`/api/filters/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  getFilterMatches: (id: string) => fetch(`/api/filters/${id}/matches`).then((r) => json<{ filterId: string; matches: string[] }>(r)),
  // Newest-first from the server (ORDER BY id DESC) -- the Membership Log
  // panel wants oldest-first (it appends live WS entries), so callers reverse.
  getLogs: (limit = 200) =>
    fetch(`/api/logs?limit=${limit}`).then((r) => json<{ id: number; filter_id: string; symbol: string; action: 'added' | 'removed'; ts_ist: string }[]>(r)),

  getMonitorLog: (limit = 20) =>
    fetch(`/api/monitor-log?limit=${limit}`).then((r) =>
      json<{ id: number; scheduled_ts_ist: string; row_count: number; expected_row_count: number; missing_symbol_count: number; status: string; missingSymbols: string[] }[]>(r)
    ),

  getScheduler: () =>
    fetch('/api/scheduler').then((r) =>
      json<{
        intervalMinutes: number; enabled: boolean;
        marketOpenTime: string; marketCloseTime: string;
        activeWeekdays: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', boolean>;
        holidays: string[]; minRunGapSeconds: number;
        nextRunAtIst: string | null; lastRunAtIst: string | null;
        nowIst: string; isMarketOpen: boolean;
      }>(r)
    ),
  putScheduler: (patch: {
    intervalMinutes?: number; enabled?: boolean; marketOpenTime?: string; marketCloseTime?: string;
    activeWeekdays?: Record<string, boolean>; holidays?: string[];
    minRunGapSeconds?: number;
  }) =>
    fetch('/api/scheduler', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: true }>(r)),
  runSchedulerNow: () => fetch('/api/scheduler/run-now', { method: 'POST' }).then((r) => r.json()),

  getClassificationStatus: () =>
    fetch('/api/classification').then((r) =>
      json<Record<'nifty50' | 'banknifty' | 'fno', { count: number; updatedAt: string | null }>>(r)
    ),
  uploadClassification: (indexType: 'nifty50' | 'banknifty' | 'fno' | 'emerge' | 'nifty500', file: File) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`/api/classification/${indexType}/upload`, { method: 'POST', body: form }).then((r) => json<any>(r));
  },

  getSymbols: (superFilter?: HistorySuperFilter) =>
    fetch(`/api/symbols${superFilter ? `?superFilter=${superFilter}` : ''}`).then((r) => json<{ symbols: string[] }>(r)),

  // ---- watchlists (Watchlists tab, left panel) ------------------------------
  getWatchlists: () => fetch('/api/watchlists').then((r) => json<Watchlist[]>(r)),
  createWatchlist: (name: string) =>
    fetch('/api/watchlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => json<Watchlist>(r)),
  renameWatchlist: (id: string, name: string) =>
    fetch(`/api/watchlists/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => json<{ ok: true }>(r)),
  deleteWatchlist: (id: string) => fetch(`/api/watchlists/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  addWatchlistSymbol: (id: string, symbol: string) =>
    fetch(`/api/watchlists/${id}/symbols`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    }).then((r) => json<{ ok: true }>(r)),
  removeWatchlistSymbol: (id: string, symbol: string) =>
    fetch(`/api/watchlists/${id}/symbols/${symbol}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  // ---- price alerts (Settings > Price Alerts, bottom ticker bar) -----------
  getPriceAlerts: () => fetch('/api/price-alerts').then((r) => json<PriceAlert[]>(r)),
  createPriceAlert: (data: { symbol: string; direction: PriceAlertDirection; alertPrice: number }) =>
    fetch('/api/price-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then((r) => json<PriceAlert>(r)),
  updatePriceAlert: (id: string, patch: Partial<{ direction: PriceAlertDirection; alertPrice: number; isActive: boolean }>) =>
    fetch(`/api/price-alerts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: true }>(r)),
  deletePriceAlert: (id: string) => fetch(`/api/price-alerts/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  getPriceAlertTicker: () => fetch('/api/price-alerts/ticker').then((r) => json<PriceAlertEvent[]>(r)),
  getPriceAlertLogs: (limit = 200) => fetch(`/api/price-alerts/logs?limit=${limit}`).then((r) => json<PriceAlertEvent[]>(r)),

  // ---- Telegram notifications (Settings > Price Alerts) --------------------
  getTelegramConfig: () => fetch('/api/telegram/config').then((r) => json<TelegramConfig>(r)),
  putTelegramConfig: (patch: Partial<{ enabled: boolean; botToken: string; chatId: string }>) =>
    fetch('/api/telegram/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: true }>(r)),
  // A failed send comes back as HTTP 400 -- json() throws in that case (see
  // its definition above), so a caller catches and reads err.message rather
  // than checking a returned `ok: false`.
  testTelegramNotification: () => fetch('/api/telegram/test', { method: 'POST' }).then((r) => json<{ ok: true }>(r)),
};

export type Watchlist = { id: string; name: string; created_at: string; symbols: string[] };

export type PriceAlertDirection = 'above' | 'below';

/** GET /api/telegram/config never returns the raw bot token -- only whether one is set. */
export type TelegramConfig = {
  enabled: boolean;
  chatId: string | null;
  hasToken: boolean;
  lastSentAtIst: string | null;
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
};

export type PriceAlert = {
  id: string;
  symbol: string;
  direction: PriceAlertDirection;
  alert_price: number;
  is_active: boolean;
  created_at: string | null;
  current_price: number | null;
  status: 'triggered' | 'watching';
};

/** One detected crossing -- returned by both /ticker (still within 24h) and /logs (rolled off it). */
export type PriceAlertEvent = {
  id: number;
  alert_id: string;
  symbol: string;
  direction: PriceAlertDirection;
  alert_price: number;
  price_after_crossed: number;
  slot_ts_ist: string;
  triggered_at_ist: string;
  current_price: number | null;
};
