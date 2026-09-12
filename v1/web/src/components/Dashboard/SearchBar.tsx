import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { SnapshotRow } from '../../hooks/useLiveSnapshot';

const MAX_DROPDOWN_RESULTS = 12;

/**
 * Ticker search over the full Nifty All universe (api.getSymbols() with no
 * superFilter -- every symbol this app has ever seen, per server/src/routes/symbols.js),
 * independent of whichever super filter currently narrows the table. Picking
 * a match highlights its row if the table currently shows it; if the symbol
 * is real but excluded by the active super filter (e.g. found in Nifty 500
 * while the table is scoped to Nifty 50), that's reported rather than
 * silently showing nothing.
 *
 * Highlighting a row is a single shared slot with FilterBar's "matching
 * now" chips (see DashboardTab.tsx) -- picking a ticker from one source
 * clears the other's UI state. `resetSignal` is bumped by the parent
 * whenever a FilterBar chip click takes ownership of that slot, and this
 * component clears its own query/message in response.
 */
export function SearchBar({
  rows,
  onSelect,
  resetSignal,
}: {
  rows: SnapshotRow[];
  onSelect: (symbol: string | null, status: 'found' | 'not-in-filter' | 'idle') => void;
  resetSignal?: number;
}) {
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getSymbols().then((r) => setAllSymbols(r.symbols)).catch(() => {});
  }, []);

  useEffect(() => {
    if (resetSignal === undefined) return;
    setQuery('');
    setMessage(null);
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, []);

  const trimmed = query.trim().toUpperCase();
  const matches = trimmed ? allSymbols.filter((s) => s.toUpperCase().includes(trimmed)).slice(0, MAX_DROPDOWN_RESULTS) : [];

  function selectSymbol(symbol: string) {
    setQuery(symbol);
    setOpen(false);
    const inFilter = rows.some((r) => r.symbol === symbol);
    if (inFilter) {
      setMessage(null);
      onSelect(symbol, 'found');
      requestAnimationFrame(() => {
        document.querySelector(`tr[data-symbol="${CSS.escape(symbol)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } else {
      setMessage(`${symbol} is not in the current filter`);
      onSelect(null, 'not-in-filter');
    }
  }

  function handleChange(value: string) {
    setQuery(value);
    setOpen(true);
    setMessage(null);
    if (!value.trim()) onSelect(null, 'idle');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && matches.length >= 1) {
      selectSymbol(matches[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function clear() {
    setQuery('');
    setOpen(false);
    setMessage(null);
    onSelect(null, 'idle');
  }

  return (
    <div className="search-bar" ref={containerRef}>
      <div className="search-bar-input-wrap">
        <span className="search-bar-icon">⚲</span>
        <input
          className="search-bar-input"
          placeholder="Search ticker…"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button className="search-bar-clear" onClick={clear} title="Clear search">
            ✕
          </button>
        )}
        {open && trimmed && (
          <div className="search-dropdown">
            {matches.length > 0 ? (
              matches.map((s) => (
                <div
                  key={s}
                  className="search-dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectSymbol(s);
                  }}
                >
                  {s}
                </div>
              ))
            ) : (
              <div className="search-dropdown-empty">No search results found</div>
            )}
          </div>
        )}
      </div>
      {message && <span className="search-bar-message">{message}</span>}
    </div>
  );
}
