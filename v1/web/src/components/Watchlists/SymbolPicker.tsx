import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

const MAX_DROPDOWN_RESULTS = 12;

/**
 * Typeahead for adding a symbol to a watchlist, constrained to the tracked
 * universe (api.getSymbols(), no superFilter -- every symbol this app has
 * ever seen) so indicator values always exist for anything addable. Reuses
 * Dashboard/SearchBar's search-bar/search-dropdown CSS, adapted to "pick and
 * clear" instead of "search and highlight". Ported unchanged from
 * v2/web/src/components/Watchlists/SymbolPicker.tsx.
 */
export function SymbolPicker({ existing, onPick }: { existing: string[]; onPick: (symbol: string) => void }) {
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getSymbols().then((r) => setAllSymbols(r.symbols)).catch(() => {});
  }, []);

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, []);

  const existingSet = new Set(existing);
  const trimmed = query.trim().toUpperCase();
  const matches = trimmed
    ? allSymbols.filter((s) => !existingSet.has(s) && s.toUpperCase().includes(trimmed)).slice(0, MAX_DROPDOWN_RESULTS)
    : [];

  function pick(symbol: string) {
    onPick(symbol);
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="search-bar symbol-picker" ref={containerRef}>
      <div className="search-bar-input-wrap">
        <span className="search-bar-icon">+</span>
        <input
          className="search-bar-input"
          placeholder="Add symbol…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches.length >= 1) pick(matches[0]);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {open && trimmed && (
          <div className="search-dropdown">
            {matches.length > 0 ? (
              matches.map((s) => (
                <div key={s} className="search-dropdown-item" onClick={(e) => { e.stopPropagation(); pick(s); }}>
                  {s}
                </div>
              ))
            ) : (
              <div className="search-dropdown-empty">No matching symbols</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
