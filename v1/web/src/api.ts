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
  getSnapshot: () =>
    fetch('/api/snapshot').then((r) => json<{ rows: Record<string, unknown>[]; asOf: string; superFilter: string }>(r)),
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
};
