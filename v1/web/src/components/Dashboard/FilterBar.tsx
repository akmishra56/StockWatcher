import { useEffect, useState } from 'react';
import { api } from '../../api';
import { colorForFilter } from '../../filterColor';

type Filter = { id: string; name: string; conditionTree: Group; isActive: boolean };
type Leaf = { field: string; operator: string; value?: number | string | boolean; valueField?: string };
type Group = { join: 'AND' | 'OR'; conditions: Node[] };
type Node = Leaf | Group;

function isGroup(node: Node): node is Group {
  return Array.isArray((node as Group).conditions);
}

// The left-hand side of a condition -- every field a row carries, including
// the semantic booleans (isOversold/direction) that only make sense with
// 'is', not a numeric comparison.
const FIELD_OPTIONS = [
  { value: 'price_change_pct', label: 'Change %' },
  { value: 'close', label: 'Close' },
  { value: 'volume', label: 'Volume' },
  { value: 'rsi', label: 'RSI' },
  { value: 'rsi.isOversold', label: 'RSI Oversold' },
  { value: 'rsi.isOverbought', label: 'RSI Overbought' },
  { value: 'macd_hist', label: 'MACD Histogram' },
  { value: 'atr', label: 'ATR' },
  { value: 'ema10', label: 'EMA10' },
  { value: 'ema30', label: 'EMA30' },
  { value: 'bb_upper', label: 'Bollinger Upper' },
  { value: 'bb_ma', label: 'Bollinger Middle (MA)' },
  { value: 'bb_lower', label: 'Bollinger Lower' },
  { value: 'supertrend_value', label: 'Supertrend Value' },
  { value: 'supertrend.direction', label: 'Supertrend Direction' },
];
// Right-hand side when comparing against another field (e.g. Close vs.
// Bollinger Lower) -- numeric fields only, since a value comparison
// (>, >=, <, <=) against a boolean/direction field is never meaningful.
const NUMERIC_FIELD_OPTIONS = FIELD_OPTIONS.filter((f) => !f.value.includes('.'));
// crosses_above/crosses_below are edge-triggered: true only on the tick
// where the relationship between the two sides flips (previous tick's
// values disagreed, this tick's agree) -- e.g. Close 'crosses above'
// Bollinger Lower means the previous snapshot had Close <= Bollinger Lower
// and the latest snapshot has Close > Bollinger Lower. Evaluated server-side
// against snapshot_window's previous row (server/src/filters/conditions.js).
const OPERATORS: { value: string; label: string }[] = [
  { value: '>', label: '>' },
  { value: '>=', label: '>=' },
  { value: '<', label: '<' },
  { value: '<=', label: '<=' },
  { value: '==', label: '==' },
  { value: '!=', label: '!=' },
  { value: 'is', label: 'is' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
];

const emptyLeaf = (): Leaf => ({ field: 'price_change_pct', operator: '>', value: 0 });
const emptyGroup = (): Group => ({ join: 'AND', conditions: [emptyLeaf()] });

/**
 * A tree node is a leaf condition or a nested group -- same recursive shape
 * the backend evaluates (server/src/filters/conditions.js), so a saved
 * filter here round-trips through the API with no translation. Nesting
 * lets a user build e.g. "(RSI Oversold AND Volume > X) OR Change% < -5"
 * (docs/roadmap.md "Nested filter condition groups", built 2026-09-09).
 */
function GroupEditor({
  group,
  onChange,
  onRemove,
  depth,
}: {
  group: Group;
  onChange: (g: Group) => void;
  onRemove?: () => void;
  depth: number;
}) {
  function updateChild(i: number, next: Node) {
    onChange({ ...group, conditions: group.conditions.map((c, idx) => (idx === i ? next : c)) });
  }
  function removeChild(i: number) {
    onChange({ ...group, conditions: group.conditions.filter((_, idx) => idx !== i) });
  }
  function addLeaf() {
    onChange({ ...group, conditions: [...group.conditions, emptyLeaf()] });
  }
  function addGroup() {
    onChange({ ...group, conditions: [...group.conditions, emptyGroup()] });
  }

  return (
    <div className="filter-group" style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <div className="filter-group-header">
        <button className="chip-toggle chip-toggle-active" onClick={() => onChange({ ...group, join: group.join === 'AND' ? 'OR' : 'AND' })}>
          {group.join}
        </button>
        {depth > 0 && (
          <span className="text-3" style={{ fontSize: 10.5 }}>group</span>
        )}
        {onRemove && (
          <button className="chip-toggle" onClick={onRemove}>✕ group</button>
        )}
      </div>

      {group.conditions.map((node, i) =>
        isGroup(node) ? (
          <GroupEditor key={i} group={node} onChange={(g) => updateChild(i, g)} onRemove={() => removeChild(i)} depth={depth + 1} />
        ) : (
          <div className="condition-row" key={i}>
            <select value={node.field} onChange={(e) => updateChild(i, { ...node, field: e.target.value })}>
              {FIELD_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <select value={node.operator} onChange={(e) => updateChild(i, { ...node, operator: e.target.value })}>
              {OPERATORS.map((op) => (
                <option key={op.value} value={op.value}>{op.label}</option>
              ))}
            </select>
            <select
              title="Compare against a fixed number, or another field on the same row (e.g. Close vs. Bollinger Lower)"
              value={node.valueField ? 'field' : 'number'}
              onChange={(e) =>
                updateChild(
                  i,
                  e.target.value === 'field'
                    ? { ...node, valueField: NUMERIC_FIELD_OPTIONS[0].value, value: undefined }
                    : { ...node, valueField: undefined, value: 0 }
                )
              }
            >
              <option value="number">Number</option>
              <option value="field">Field</option>
            </select>
            {node.valueField ? (
              <select value={node.valueField} onChange={(e) => updateChild(i, { ...node, valueField: e.target.value })}>
                {NUMERIC_FIELD_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            ) : (
              <input
                style={{ width: 70 }}
                value={String(node.value ?? '')}
                onChange={(e) => updateChild(i, { ...node, value: isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value) })}
              />
            )}
            {(group.conditions.length > 1 || depth > 0) && (
              <button className="chip-toggle" onClick={() => removeChild(i)}>−</button>
            )}
          </div>
        )
      )}

      <div className="filter-builder-actions">
        <button className="chip-toggle" onClick={addLeaf}>+ condition</button>
        <button className="chip-toggle" onClick={addGroup}>+ group</button>
      </div>
    </div>
  );
}

export function FilterBar({ onMatchClick }: { onMatchClick?: (symbol: string, color: string) => void }) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [matches, setMatches] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [name, setName] = useState('');
  const [tree, setTree] = useState<Group>(emptyGroup());
  // Set while the builder is editing an EXISTING filter's conditions rather
  // than creating a new one -- same GroupEditor UI, "Save changes" instead
  // of "Save as tab", and PUT instead of POST on save.
  const [editingId, setEditingId] = useState<string | null>(null);

  function refreshFilters() {
    api.getFilters().then((fs) => {
      setFilters(fs);
      if (!activeId && fs.length > 0) setActiveId(fs[0].id);
    });
  }
  useEffect(refreshFilters, []);

  useEffect(() => {
    if (!activeId) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const load = () => api.getFilterMatches(activeId).then((r) => { if (!cancelled) setMatches(r.matches); }).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeId]);

  async function saveFilter() {
    if (!name.trim()) return;
    if (editingId) {
      await api.updateFilter(editingId, { name: name.trim(), conditionTree: tree });
      setActiveId(editingId);
    } else {
      const created = await api.createFilter(name.trim(), tree);
      setActiveId(created.id);
    }
    setName('');
    setTree(emptyGroup());
    setEditingId(null);
    setBuilding(false);
    refreshFilters();
  }

  async function deleteFilter(id: string) {
    await api.deleteFilter(id);
    if (activeId === id) setActiveId(null);
    if (editingId === id) cancelBuilding();
    refreshFilters();
  }

  function startEditing(f: Filter) {
    setEditingId(f.id);
    setName(f.name);
    // Deep clone -- f.conditionTree is the SAME object reference held in the
    // `filters` list state; editing it in place (even via GroupEditor's
    // normally-immutable updateChild) must never risk mutating what's still
    // displayed as that filter's saved tree until Save is actually clicked.
    setTree(JSON.parse(JSON.stringify(f.conditionTree)));
    setBuilding(true);
  }

  function cancelBuilding() {
    setBuilding(false);
    setName('');
    setTree(emptyGroup());
    setEditingId(null);
  }

  return (
    <div className="filter-bar">
      <div className="filter-bar-header">
        <span className="text-2" style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}>FILTERS</span>
        <button className="chip-toggle" onClick={() => (building ? cancelBuilding() : setBuilding(true))}>{building ? '✕' : '+ New'}</button>
      </div>

      <div className="filter-tabs">
        {filters.map((f) => (
          <div
            key={f.id}
            className={`filter-tab ${activeId === f.id ? 'filter-tab-active' : ''}`}
            style={{ borderLeft: `3px solid ${colorForFilter(f.id)}` }}
            onClick={() => setActiveId(f.id)}
          >
            <span>{f.name}</span>
            <button className="filter-tab-edit" title="Edit conditions" onClick={(e) => { e.stopPropagation(); startEditing(f); }}>✎</button>
            <button className="filter-tab-delete" onClick={(e) => { e.stopPropagation(); deleteFilter(f.id); }}>✕</button>
          </div>
        ))}
        {filters.length === 0 && !building && <div className="text-3" style={{ fontSize: 11.5 }}>No saved filters yet.</div>}
      </div>

      {building && (
        <div className="filter-builder">
          {editingId && <div className="text-3" style={{ fontSize: 10.5 }}>Editing conditions</div>}
          <input placeholder="Filter name" value={name} onChange={(e) => setName(e.target.value)} />
          <GroupEditor group={tree} onChange={setTree} depth={0} />
          <div className="filter-builder-footer">
            <button className="chip-toggle chip-toggle-active" onClick={saveFilter}>{editingId ? 'Save changes' : 'Save as tab'}</button>
            <button className="chip-toggle" onClick={cancelBuilding}>Cancel</button>
          </div>
        </div>
      )}

      {activeId && (
        <div className="filter-matches">
          <div className="text-2" style={{ fontSize: 10.5, marginBottom: 6 }}>MATCHING NOW ({matches.length})</div>
          <div className="filter-matches-list">
            {matches.map((s) => (
              <span
                key={s}
                className="chip-sm chip-sm-clickable"
                style={{ borderColor: colorForFilter(activeId), color: colorForFilter(activeId) }}
                title={`Highlight ${s} in the table`}
                onClick={(e) => {
                  e.stopPropagation();
                  onMatchClick?.(s, colorForFilter(activeId));
                }}
              >
                {s}
              </span>
            ))}
            {matches.length === 0 && <span className="text-3" style={{ fontSize: 11 }}>No matches this cycle</span>}
          </div>
        </div>
      )}
    </div>
  );
}
