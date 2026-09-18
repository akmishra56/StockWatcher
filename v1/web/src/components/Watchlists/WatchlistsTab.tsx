import { useEffect, useState } from 'react';
import { api, type Watchlist } from '../../api';
import type { SnapshotRow } from '../../hooks/useLiveSnapshot';
import { WatchlistPanel } from './WatchlistPanel';
import { IndicatorDetailCard } from './IndicatorDetailCard';

/**
 * Watchlists tab: left panel (same width as Dashboard's filter column) lists
 * named, collapsible groups of symbols; the right column shows the selected
 * symbol's indicator values. Adapted from
 * v2/web/src/components/Watchlists/WatchlistsTab.tsx -- v1 has no news feed
 * and no candlestick chart, so there's no top/bottom split: the right column
 * is just the indicator card, full height.
 */
export function WatchlistsTab({ rows, mergeRows }: { rows: SnapshotRow[]; mergeRows: (rows: SnapshotRow[]) => void }) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [rsiOversold, setRsiOversold] = useState(30);
  const [rsiOverbought, setRsiOverbought] = useState(70);

  function refresh() {
    api.getWatchlists().then(setWatchlists).catch(() => {});
  }

  useEffect(() => {
    refresh();
    api
      .getSettings()
      .then((s) => {
        setRsiOversold(s.colorRules?.rsiOversold?.threshold ?? 30);
        setRsiOverbought(s.colorRules?.rsiOverbought?.threshold ?? 70);
      })
      .catch(() => {});
    // `rows` (useLiveSnapshot) only ever grows from whatever the WS has
    // broadcast since it connected -- its initial snapshot is filtered to
    // the active super filter. Watchlist symbols are arbitrary, not scoped
    // to that filter at all, so this needs the true unfiltered universe --
    // superFilter=all -- not just a plain GET /api/snapshot (which would
    // still be filtered and could miss a watchlist symbol entirely).
    api.getSnapshot('all').then((r) => mergeRows(r.rows as SnapshotRow[])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRow = selectedSymbol ? rows.find((r) => r.symbol === selectedSymbol) : undefined;

  return (
    <div className="watchlists-tab">
      <div className="watchlists-body">
        <WatchlistPanel
          watchlists={watchlists}
          onRefresh={refresh}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={setSelectedSymbol}
        />
        <div className="watchlists-right watchlists-right-no-split">
          <IndicatorDetailCard symbol={selectedSymbol} row={selectedRow} rsiOversold={rsiOversold} rsiOverbought={rsiOverbought} />
        </div>
      </div>
    </div>
  );
}
