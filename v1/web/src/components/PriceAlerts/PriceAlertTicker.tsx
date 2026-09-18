import { useEffect, useRef, useState } from 'react';
import { api, type PriceAlertEvent } from '../../api';

const POLL_MS = 30000;
// How long a just-arrived crossing keeps its gold "NEW" flash styling before
// settling into the plain rolling style -- it stays in the ticker itself for
// a full 24h (Settings > Price Alerts), this is purely the flash duration.
const FLASH_MS = 60000;

/**
 * Fixed bottom ticker bar (mounted once in App.tsx, outside the tab
 * switch, so it persists across every tab): a horizontal, looping marquee
 * of symbols that have crossed their configured price-alert level in the
 * last 24h. Polls GET /api/price-alerts/ticker for the baseline state and
 * also reacts to the WS 'price-alert:triggered' broadcast (useLiveSnapshot)
 * so a fresh crossing appears instantly rather than waiting on the next poll.
 * Ported unchanged from v2/web/src/components/PriceAlerts/PriceAlertTicker.tsx.
 */
export function PriceAlertTicker({ liveEvents }: { liveEvents: PriceAlertEvent[] }) {
  const [entries, setEntries] = useState<PriceAlertEvent[]>([]);
  const [flashIds, setFlashIds] = useState<Set<number>>(new Set());
  const seenIds = useRef<Set<number>>(new Set());

  function markNew(ids: number[]) {
    const fresh = ids.filter((id) => !seenIds.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => seenIds.current.add(id));
    setFlashIds((prev) => new Set([...prev, ...fresh]));
    fresh.forEach((id) => {
      setTimeout(() => {
        setFlashIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, FLASH_MS);
    });
  }

  function refresh() {
    api
      .getPriceAlertTicker()
      .then((rows) => {
        setEntries(rows);
        markNew(rows.map((r) => r.id));
      })
      .catch(() => {});
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (liveEvents.length === 0) return;
    setEntries((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      for (const e of liveEvents) byId.set(e.id, e);
      return [...byId.values()].sort((a, b) => b.id - a.id);
    });
    markNew(liveEvents.map((e) => e.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEvents]);

  return (
    <div className="price-alert-ticker">
      <div className="price-alert-ticker-badge">
        <span className="price-alert-ticker-dot" />
        <span>PRICE ALERTS</span>
      </div>
      <div className="price-alert-ticker-track-outer">
        {entries.length === 0 ? (
          <div className="price-alert-ticker-empty text-3">No active price alerts</div>
        ) : (
          <div className={`price-alert-ticker-track ${entries.length < 4 ? 'price-alert-ticker-track-static' : ''}`}>
            {(entries.length < 4 ? entries : [...entries, ...entries]).map((e, i) => (
              <PriceAlertChip key={`${e.id}-${i}`} event={e} isNew={flashIds.has(e.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PriceAlertChip({ event, isNew }: { event: PriceAlertEvent; isNew: boolean }) {
  const up = event.direction === 'above';
  const price = event.current_price ?? event.price_after_crossed;
  return (
    <div className={`price-alert-chip ${isNew ? 'price-alert-chip-new' : ''}`}>
      {isNew && <span className="price-alert-chip-tag mono">NEW</span>}
      <span className="mono price-alert-chip-symbol">{event.symbol}</span>
      <span className={`mono price-alert-chip-price ${up ? 'cell-pos' : 'cell-neg'}`}>₹{price.toFixed(2)}</span>
      <span className="price-alert-chip-detail">
        {up ? '▲' : '▼'} crossed {up ? 'above' : 'below'} ₹{event.alert_price.toFixed(2)}
      </span>
    </div>
  );
}
