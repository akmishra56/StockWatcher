import type { SnapshotRow } from '../../hooks/useLiveSnapshot';

/**
 * Vertical key/value card for one selected symbol's current indicator
 * values -- the same fields shown in the Dashboard tab's SnapshotTable, laid
 * out as rows instead of table columns since this card only ever shows one
 * symbol at a time. A small self-contained duplicate of SnapshotTable's
 * field list/formatting/thresholds rather than an extraction shared with
 * it -- SnapshotTable's per-cell logic is tightly woven into its drag/click/
 * sort machinery, which doesn't apply here, and the indicator field set
 * changes rarely enough that keeping this in sync by hand is low-risk.
 * Ported from v2/web/src/components/Watchlists/IndicatorDetailCard.tsx --
 * v1 has no chart, so this fills the whole right column rather than 40% of
 * a chart+indicator split (see WatchlistsTab.tsx / app.css).
 */
const FIELDS: { key: keyof SnapshotRow | string; label: string; format?: 'int' | 'pct' }[] = [
  { key: 'close', label: 'Close' },
  { key: 'price_change', label: 'Change' },
  { key: 'price_change_pct', label: 'Change %', format: 'pct' },
  { key: 'volume', label: 'Volume', format: 'int' },
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
  { key: 'macd_signal', label: 'Signal' },
  { key: 'macd_hist', label: 'Hist' },
  { key: 'atr', label: 'ATR' },
  { key: 'bb_ma', label: 'Bollinger' },
  { key: 'ema10', label: 'EMA10' },
  { key: 'ema30', label: 'EMA30' },
  { key: 'supertrend_value', label: 'Supertrend' },
];

function fmtNumber(v: unknown): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-';
  return v.toFixed(2);
}
function fmtInt(v: unknown): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-';
  return Math.round(v).toLocaleString('en-US');
}

export function IndicatorDetailCard({
  symbol,
  row,
  rsiOversold,
  rsiOverbought,
}: {
  symbol: string | null;
  row: SnapshotRow | undefined;
  rsiOversold: number;
  rsiOverbought: number;
}) {
  if (!symbol) {
    return (
      <div className="watchlists-indicator-panel indicator-detail-card indicator-detail-empty text-3">
        Click a symbol in a watchlist to see its indicator values here.
      </div>
    );
  }
  if (!row) {
    return (
      <div className="watchlists-indicator-panel indicator-detail-card">
        <div className="indicator-detail-title sym">{symbol}</div>
        <div className="text-3">No live snapshot yet for this symbol.</div>
      </div>
    );
  }

  const supertrendUp = row.supertrend_direction === 'up';

  return (
    <div className="watchlists-indicator-panel indicator-detail-card">
      <div className="indicator-detail-title sym">{symbol}</div>
      {FIELDS.map((f) => {
        const v = row[f.key as string];
        let cls = '';
        let display = f.format === 'int' ? fmtInt(v) : fmtNumber(v);
        if (f.format === 'pct' && typeof v === 'number') display += '%';

        if (f.key === 'price_change' || f.key === 'price_change_pct') {
          cls = typeof v === 'number' ? (v > 0 ? 'cell-pos' : v < 0 ? 'cell-neg' : '') : '';
        } else if (f.key === 'rsi' && typeof v === 'number') {
          cls = v < rsiOversold ? 'cell-neg' : v > rsiOverbought ? 'cell-warn' : '';
        } else if (f.key === 'supertrend_value') {
          cls = supertrendUp ? 'cell-pos' : 'cell-neg';
          display += supertrendUp ? ' ▲' : ' ▼';
        }

        return (
          <div key={f.key as string} className="indicator-detail-row">
            <span className="indicator-detail-label text-2">{f.label}</span>
            <span className={`indicator-detail-value ${cls}`}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}
