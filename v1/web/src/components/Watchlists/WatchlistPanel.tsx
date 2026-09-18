import { useState } from 'react';
import { api, type Watchlist } from '../../api';
import { SymbolPicker } from './SymbolPicker';

/**
 * Left column of the Watchlists tab: create/rename/delete watchlists, each
 * an expandable/collapsible group of symbols. Sized via the same
 * .dashboard-left class the Dashboard tab's filter column uses (see
 * WatchlistsTab.tsx) so the two columns are structurally the same width,
 * not just coincidentally matching numbers. Ported unchanged from
 * v2/web/src/components/Watchlists/WatchlistPanel.tsx.
 */
export function WatchlistPanel({
  watchlists,
  onRefresh,
  selectedSymbol,
  onSelectSymbol,
}: {
  watchlists: Watchlist[];
  onRefresh: () => void;
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createWatchlist() {
    const name = newName.trim();
    if (!name) return;
    const created = await api.createWatchlist(name);
    setNewName('');
    setExpanded((prev) => new Set(prev).add(created.id));
    onRefresh();
  }

  async function commitRename(id: string) {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    await api.renameWatchlist(id, name);
    onRefresh();
  }

  async function deleteWatchlist(id: string) {
    await api.deleteWatchlist(id);
    onRefresh();
  }

  async function addSymbol(watchlistId: string, symbol: string) {
    await api.addWatchlistSymbol(watchlistId, symbol);
    onRefresh();
  }

  async function removeSymbol(watchlistId: string, symbol: string) {
    await api.removeWatchlistSymbol(watchlistId, symbol);
    onRefresh();
  }

  return (
    <div className="dashboard-left watchlists-left">
      <div className="watchlists-new-row">
        <input
          className="watchlists-new-input"
          placeholder="New watchlist name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createWatchlist(); }}
        />
        <button className="chip-toggle" onClick={createWatchlist} disabled={!newName.trim()}>
          + Add
        </button>
      </div>

      {watchlists.length === 0 && <div className="text-3 watchlists-empty">No watchlists yet -- create one above.</div>}

      {watchlists.map((w) => {
        const isOpen = expanded.has(w.id);
        return (
          <div key={w.id} className="watchlist-group">
            <div className="watchlist-group-header">
              <button className="watchlist-group-caret" onClick={() => toggleExpanded(w.id)} title={isOpen ? 'Collapse' : 'Expand'}>
                {isOpen ? '▾' : '▸'}
              </button>
              {renamingId === w.id ? (
                <input
                  className="watchlists-rename-input"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(w.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(w.id); if (e.key === 'Escape') setRenamingId(null); }}
                />
              ) : (
                <span className="watchlist-group-name" onClick={() => toggleExpanded(w.id)}>
                  {w.name} <span className="text-3">({w.symbols.length})</span>
                </span>
              )}
              <button
                className="filter-tab-edit"
                title="Rename"
                onClick={() => { setRenamingId(w.id); setRenameValue(w.name); }}
              >
                ✎
              </button>
              <button className="filter-tab-delete" title="Delete watchlist" onClick={() => deleteWatchlist(w.id)}>
                ✕
              </button>
            </div>

            {isOpen && (
              <div className="watchlist-group-body">
                {w.symbols.map((symbol) => (
                  <div
                    key={symbol}
                    className={`watchlist-symbol-row ${symbol === selectedSymbol ? 'watchlist-symbol-row-active' : ''}`}
                    onClick={() => onSelectSymbol(symbol)}
                  >
                    <span className="sym">{symbol}</span>
                    <button
                      className="filter-tab-delete"
                      title="Remove from watchlist"
                      onClick={(e) => { e.stopPropagation(); removeSymbol(w.id, symbol); }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <SymbolPicker existing={w.symbols} onPick={(symbol) => addSymbol(w.id, symbol)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
