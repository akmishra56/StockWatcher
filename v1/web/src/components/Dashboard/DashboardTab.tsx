import { useEffect, useRef, useState } from 'react';
import type { LogEntry, SnapshotRow } from '../../hooks/useLiveSnapshot';
import { api } from '../../api';
import { SnapshotTable } from './SnapshotTable';
import { Calculator } from './Calculator';
import { PositionCalculator } from './PositionCalculator';
import { MonitorLogPanel } from './MonitorLogPanel';
import { DelayBanner, MissingSymbolToast } from './AlertBanner';
import { FilterBar } from './FilterBar';
import { SearchBar } from './SearchBar';
import { ApplyFilterSelect } from './ApplyFilterSelect';

export function DashboardTab({
  rows,
  mergeRows,
  logEntries,
  missingSymbolAlert,
  clearMissingSymbolAlert,
}: {
  rows: SnapshotRow[];
  mergeRows: (rows: SnapshotRow[]) => void;
  logEntries: LogEntry[];
  missingSymbolAlert: { count: number; symbols: string[]; ts_ist: string } | null;
  clearMissingSymbolAlert: () => void;
}) {
  const [rsiOversold, setRsiOversold] = useState(30);
  const [rsiOverbought, setRsiOverbought] = useState(70);
  // A single shared "highlighted row" slot -- either the search box or a
  // FilterBar "matching now" chip owns it at any one time; picking a new
  // ticker from either source replaces whatever the other had set. null
  // color means the default theme-aware search highlight; a hex string
  // means a specific filter's own color (SnapshotTable's highlightColor).
  const [highlight, setHighlight] = useState<{ symbol: string; color: string | null } | null>(null);
  const [filterClickNotice, setFilterClickNotice] = useState<string | null>(null);
  const [searchResetToken, setSearchResetToken] = useState(0);
  // "Apply filter" (ApplyFilterSelect, top bar) actually narrows which rows
  // the table shows -- distinct from FilterBar's "matching now" chips
  // (sidebar list only) and from clicking a chip/search result (highlights
  // one row, doesn't hide the rest).
  const [appliedFilterId, setAppliedFilterId] = useState<string | null>(null);
  const [appliedFilterMatches, setAppliedFilterMatches] = useState<Set<string> | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setRsiOversold(s.colorRules?.rsiOversold?.threshold ?? 30);
        setRsiOverbought(s.colorRules?.rsiOverbought?.threshold ?? 70);
      })
      .catch(() => {});
  }, []);

  // Live-polled (5s), same pattern as FilterBar's own "matching now" list --
  // so the applied filter's row set stays current as new snapshots arrive.
  useEffect(() => {
    if (!appliedFilterId) {
      setAppliedFilterMatches(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api.getFilterMatches(appliedFilterId).then((r) => { if (!cancelled) setAppliedFilterMatches(new Set(r.matches)); }).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [appliedFilterId]);

  function changeAppliedFilter(filterId: string | null) {
    setAppliedFilterId(filterId);
    setHighlight(null); // the highlighted row may not be visible under the new filter
  }

  const filteredRows = appliedFilterMatches ? rows.filter((r) => appliedFilterMatches.has(r.symbol)) : rows;

  // Clicking anywhere outside the table clears the highlight -- guarded by
  // stopPropagation on the two actions that SET a highlight (SearchBar's
  // dropdown item, FilterBar's match chip) so setting one never
  // flash-clears itself via this same listener.
  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (highlight && tableWrapRef.current && !tableWrapRef.current.contains(e.target as Node)) {
        setHighlight(null);
      }
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, [highlight]);

  function handleSearchSelect(symbol: string | null, status: 'found' | 'not-in-filter' | 'idle') {
    setFilterClickNotice(null);
    setHighlight(status === 'found' && symbol ? { symbol, color: null } : null);
  }

  function handleFilterMatchClick(symbol: string, color: string) {
    if (!filteredRows.some((r) => r.symbol === symbol)) {
      setFilterClickNotice(`${symbol} is not in the current filter`);
      return;
    }
    setFilterClickNotice(null);
    setHighlight({ symbol, color });
    setSearchResetToken((t) => t + 1); // clears SearchBar's own query/message -- this chip now owns the highlight
    requestAnimationFrame(() => {
      document.querySelector(`tr[data-symbol="${CSS.escape(symbol)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  return (
    <div className="dashboard-tab">
      <div className="dashboard-topbar">
        <div className="dashboard-topbar-right-group">
          <ApplyFilterSelect value={appliedFilterId} onChange={changeAppliedFilter} />
          <SearchBar rows={filteredRows} onSelect={handleSearchSelect} resetSignal={searchResetToken} />
        </div>
      </div>
      <DelayBanner rows={filteredRows} />
      <div className="dashboard-body">
        <div className="dashboard-left">
          <FilterBar onMatchClick={handleFilterMatchClick} />
          {filterClickNotice && <div className="filter-click-notice">{filterClickNotice}</div>}
        </div>
        <div className="dashboard-main" ref={tableWrapRef}>
          <SnapshotTable
            rows={filteredRows}
            rsiOversold={rsiOversold}
            rsiOverbought={rsiOverbought}
            highlightedSymbol={highlight?.symbol ?? null}
            highlightColor={highlight?.color ?? null}
          />
          <MonitorLogPanel entries={logEntries} />
        </div>
        <div className="dashboard-side">
          <Calculator />
          <PositionCalculator universeFilter="nifty50" />
        </div>
      </div>
      <MissingSymbolToast alert={missingSymbolAlert} onDismiss={clearMissingSymbolAlert} />
    </div>
  );
}
