import { useEffect, useState } from 'react';
import { api } from '../../api';

/**
 * Narrows the Dashboard table to only symbols CURRENTLY matching a chosen
 * saved filter -- distinct from FilterBar's "matching now" chips (which
 * just list matches in the sidebar without touching the main table) and
 * from clicking a chip/search result (which highlights one row without
 * hiding the rest). Combines with the Super Filter (both apply at once);
 * combines with row highlighting too (DashboardTab clears any active
 * highlight when the applied filter changes, since the highlighted row may
 * no longer be visible).
 */
export function ApplyFilterSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (filterId: string | null) => void;
}) {
  const [filters, setFilters] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    api.getFilters().then(setFilters).catch(() => {});
  }, []);

  return (
    <div className="apply-filter-wrap">
      <select
        className="apply-filter-select"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        title="Show only tickers currently matching a saved filter"
      >
        <option value="">Apply filter…</option>
        {filters.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      {value && (
        <button className="apply-filter-clear" onClick={() => onChange(null)} title="Remove applied filter">
          ✕
        </button>
      )}
    </div>
  );
}
