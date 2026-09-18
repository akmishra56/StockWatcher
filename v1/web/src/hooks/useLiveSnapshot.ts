import { useEffect, useRef, useState } from 'react';
import { api, type PriceAlertEvent } from '../api';

export type SnapshotRow = {
  symbol: string;
  close: number;
  price_change: number;
  price_change_pct: number;
  volume: number;
  delay_seconds?: number;
  rsi: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  atr: number | null;
  ema10: number | null;
  ema30: number | null;
  supertrend_value: number | null;
  supertrend_direction: 'up' | 'down' | null;
  macd_cross?: 'bullish' | 'bearish' | null;
  bb_cross?: 'upper' | 'lower' | null;
  [key: string]: unknown;
};

export type LogEntry = { filter_id: string; symbol: string; action: 'added' | 'removed'; ts_ist: string };
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * Owns the WebSocket connection. See docs/state_diagrams.md §4 for the
 * connection lifecycle this implements (Connecting -> Open -> Syncing ->
 * Live, with backoff-driven Reconnecting on drop).
 */
export function useLiveSnapshot() {
  const [rows, setRows] = useState<Map<string, SnapshotRow>>(new Map());
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [missingSymbolAlert, setMissingSymbolAlert] = useState<{ count: number; symbols: string[]; ts_ist: string } | null>(null);
  const [priceAlertEvents, setPriceAlertEvents] = useState<PriceAlertEvent[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const backoffRef = useRef(1000);

  // The WS only ever pushes NEW membership transitions from the moment this
  // tab connects -- a transition that happened before that (an earlier tab
  // session, a server restart, or just having the tab closed at the time)
  // was otherwise invisible even though it's sitting in the DB (GET
  // /api/logs). One-time hydration on mount fixes that; a composite-key
  // dedupe guards the (normally impossible) race where a live log:new lands
  // before this fetch resolves.
  useEffect(() => {
    let cancelled = false;
    const keyOf = (e: LogEntry) => `${e.filter_id}|${e.symbol}|${e.action}|${e.ts_ist}`;
    api
      .getLogs(200)
      .then((rows) => {
        if (cancelled) return;
        setLogEntries((prev) => {
          const seen = new Set(prev.map(keyOf));
          const hydrated = [...rows].reverse().filter((r) => !seen.has(keyOf(r)));
          return [...hydrated, ...prev].slice(-200);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket;
    let cancelled = false;

    function connect() {
      setConnectionStatus((s) => (s === 'live' ? s : 'connecting'));
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);

      socket.onopen = () => {
        backoffRef.current = 1000;
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot:update') {
          setRows((prev) => {
            const next = new Map(msg.initial ? undefined : prev);
            for (const row of msg.rows) next.set(row.symbol, row);
            return next;
          });
          setConnectionStatus('live');
        } else if (msg.type === 'log:new') {
          setLogEntries((prev) => [...prev, ...msg.entries].slice(-200));
        } else if (msg.type === 'alert:missing-symbols') {
          setMissingSymbolAlert({ count: msg.count, symbols: msg.symbols, ts_ist: msg.ts_ist });
        } else if (msg.type === 'price-alert:triggered') {
          // PriceAlertTicker.tsx also polls GET /api/price-alerts/ticker on
          // an interval for the baseline state -- this is purely so a fresh
          // crossing shows its "NEW" flash instantly instead of waiting up
          // to that poll interval.
          setPriceAlertEvents((prev) => [...msg.events, ...prev].slice(0, 50));
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnectionStatus('reconnecting');
        const delay = Math.min(backoffRef.current, 15000);
        backoffRef.current *= 2;
        setTimeout(connect, delay);
      };

      socket.onerror = () => socket.close();
    }

    connect();
    return () => {
      cancelled = true;
      socket?.close();
    };
  }, []);

  // Lets a caller splice in rows fetched out-of-band (e.g. a fresh
  // GET /api/snapshot for a newly-selected super filter) without waiting on
  // the next broadcast cycle -- the WS feed only pushes a full snapshot once,
  // at connect time, then incremental per-cycle updates, so switching to a
  // filter whose symbols weren't already in `rows` would otherwise show
  // nothing until up to an hour later.
  function mergeRows(newRows: SnapshotRow[]) {
    setRows((prev) => {
      const next = new Map(prev);
      for (const row of newRows) next.set(row.symbol, row);
      return next;
    });
  }

  return {
    rows: [...rows.values()],
    logEntries,
    missingSymbolAlert,
    priceAlertEvents,
    connectionStatus,
    clearMissingSymbolAlert: () => setMissingSymbolAlert(null),
    mergeRows,
  };
}
