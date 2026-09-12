import { useState, type CSSProperties } from 'react';
import type { SnapshotRow } from '../../hooks/useLiveSnapshot';
import { CellDetail } from './CellDetail';
import { setDragPayload } from '../../dragPayload';

type Column = { key: string; label: string; numeric?: boolean; draggable?: boolean; clickable?: boolean; format?: 'int' };

const COLUMNS: Column[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'close', label: 'Close', numeric: true, draggable: true },
  { key: 'price_change', label: 'Chg', numeric: true, draggable: true },
  { key: 'price_change_pct', label: 'Chg %', numeric: true, draggable: true },
  { key: 'volume', label: 'Volume', numeric: true, draggable: true, format: 'int' },
  { key: 'delay_seconds', label: 'Delay', numeric: true },
  { key: 'rsi', label: 'RSI', numeric: true, draggable: true, clickable: true },
  { key: 'macd', label: 'MACD', numeric: true, draggable: true, clickable: true },
  { key: 'macd_signal', label: 'Signal', numeric: true, draggable: true, clickable: true },
  { key: 'macd_hist', label: 'Hist', numeric: true, draggable: true, clickable: true },
  { key: 'atr', label: 'ATR', numeric: true, draggable: true, clickable: true },
  { key: 'bb_ma', label: 'Bollinger', numeric: true, draggable: true, clickable: true },
  { key: 'ema10', label: 'EMA10', numeric: true, draggable: true, clickable: true },
  { key: 'ema30', label: 'EMA30', numeric: true, draggable: true, clickable: true },
  { key: 'supertrend_value', label: 'Supertrend', numeric: true, draggable: true, clickable: true },
];

function fmtNumber(v: unknown): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-';
  return v.toFixed(2);
}

function fmtInt(v: unknown): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-';
  return Math.round(v).toLocaleString('en-US');
}

// Kept in sync with AlertBanner's DELAY_FLAG_SECONDS -- both measure the
// same thing (actual ingest time vs. the scheduled slot) and should agree
// on what counts as "delayed" rather than just "later than the moment it
// was requested" (the equity leg always starts ~2 min after the slot by
// design; see scheduler.js's deliberate NSE-politeness gap).
const DELAY_FLAG_SECONDS = 300;

function delayLabel(seconds: unknown): { label: string; flagged: boolean } {
  if (typeof seconds !== 'number') return { label: '-', flagged: false };
  if (seconds < 60) return { label: '-', flagged: false };
  const minutes = Math.round(seconds / 60);
  return { label: `+${minutes}m`, flagged: seconds > DELAY_FLAG_SECONDS };
}

type SortDir = 'asc' | 'desc';

export function SnapshotTable({
  rows,
  rsiOversold,
  rsiOverbought,
  highlightedSymbol,
  highlightColor,
}: {
  rows: SnapshotRow[];
  rsiOversold: number;
  rsiOverbought: number;
  highlightedSymbol?: string | null;
  // null/undefined -> the default theme-aware search highlight (--highlight
  // token). A hex string -> a specific filter's own color (FilterBar's
  // "matching now" chips -- see colorForFilter in FilterBar.tsx), rendered
  // as a tinted background + left accent stripe instead, since an arbitrary
  // hue can't reuse the fixed light/dark --highlight tokens directly.
  highlightColor?: string | null;
}) {
  const [detail, setDetail] = useState<{ symbol: string; field: string; row: SnapshotRow } | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    }
  }

  const sortedRows = (() => {
    if (!sortKey) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aMissing = typeof av !== 'number' || Number.isNaN(av);
      const bMissing = typeof bv !== 'number' || Number.isNaN(bv);
      // Rows missing this value always sink to the bottom, regardless of direction.
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return ((av as number) - (bv as number)) * dir;
    });
  })();

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                style={{ textAlign: col.numeric ? 'right' : 'left', cursor: col.numeric ? 'pointer' : undefined }}
                className={col.numeric ? 'th-sortable' : undefined}
                onClick={col.numeric ? () => toggleSort(col.key) : undefined}
                title={col.numeric ? 'Click to sort' : undefined}
              >
                {col.label}
                {col.numeric && sortKey === col.key && <span className="th-sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const supertrendUp = row.supertrend_direction === 'up';
            const delay = delayLabel(row.delay_seconds);
            const isHighlighted = row.symbol === highlightedSymbol;
            return (
              <tr
                key={row.symbol}
                data-symbol={row.symbol}
                className={isHighlighted ? (highlightColor ? 'row-highlight-filter' : 'row-highlight') : undefined}
                style={isHighlighted && highlightColor ? ({ '--row-accent': highlightColor } as CSSProperties) : undefined}
              >
                {COLUMNS.map((col) => {
                  if (col.key === 'symbol') {
                    return (
                      <td key={col.key} className="sym">
                        {row.symbol}
                      </td>
                    );
                  }
                  if (col.key === 'delay_seconds') {
                    return (
                      <td key={col.key} className={delay.flagged ? 'cell-warn' : 'text-2'} style={{ textAlign: 'right' }}>
                        {delay.label}
                      </td>
                    );
                  }
                  if (col.key === 'bb_ma') {
                    const close = row.close as number | null | undefined;
                    const upper = row.bb_upper as number | null | undefined;
                    const lower = row.bb_lower as number | null | undefined;
                    const crossedUp = typeof close === 'number' && typeof upper === 'number' && close > upper;
                    const crossedDown = typeof close === 'number' && typeof lower === 'number' && close < lower;
                    // State-based color (persists the whole time close stays outside the
                    // band) vs. an edge-triggered flash (fires once, only on the tick
                    // bb_cross was actually set by the backend) -- see docs/roadmap.md.
                    const cls = crossedUp ? 'cell-warn' : crossedDown ? 'cell-neg' : '';
                    const flashCls = row.bb_cross === 'upper' ? 'cell-flash-bull' : row.bb_cross === 'lower' ? 'cell-flash-bear' : '';
                    return (
                      <td
                        key={col.key}
                        className={`${cls} ${flashCls}`.trim()}
                        style={{ textAlign: 'right', cursor: 'pointer' }}
                        draggable
                        onDragStart={(e) => setDragPayload(e, row.bb_ma, row.symbol)}
                        onClick={() => setDetail({ symbol: row.symbol, field: col.key, row })}
                        title={crossedUp ? 'Close above upper band' : crossedDown ? 'Close below lower band' : undefined}
                      >
                        {fmtNumber(row.bb_ma)} {crossedUp ? '⤴' : crossedDown ? '⤵' : ''}
                      </td>
                    );
                  }
                  if (col.key === 'macd_hist') {
                    const v = row.macd_hist as number | null | undefined;
                    const flashCls = row.macd_cross === 'bullish' ? 'cell-flash-bull' : row.macd_cross === 'bearish' ? 'cell-flash-bear' : '';
                    return (
                      <td
                        key={col.key}
                        className={flashCls}
                        style={{ textAlign: 'right', cursor: 'pointer' }}
                        draggable
                        onDragStart={(e) => setDragPayload(e, v, row.symbol)}
                        onClick={() => setDetail({ symbol: row.symbol, field: col.key, row })}
                        title={row.macd_cross ? `MACD crossed ${row.macd_cross === 'bullish' ? 'above' : 'below'} signal this tick` : undefined}
                      >
                        {fmtNumber(v)}
                      </td>
                    );
                  }
                  if (col.key === 'supertrend_value') {
                    return (
                      <td
                        key={col.key}
                        className={supertrendUp ? 'cell-pos' : 'cell-neg'}
                        style={{ textAlign: 'right', cursor: 'pointer' }}
                        draggable
                        onDragStart={(e) => setDragPayload(e, row[col.key], row.symbol)}
                        onClick={() => setDetail({ symbol: row.symbol, field: col.key, row })}
                      >
                        {fmtNumber(row[col.key])} {supertrendUp ? '▲' : '▼'}
                      </td>
                    );
                  }
                  if (col.key === 'rsi') {
                    const v = row.rsi as number | null | undefined;
                    const cls = v != null && v < rsiOversold ? 'cell-neg' : v != null && v > rsiOverbought ? 'cell-warn' : '';
                    return (
                      <td
                        key={col.key}
                        className={cls}
                        style={{ textAlign: 'right', cursor: 'pointer' }}
                        draggable
                        onDragStart={(e) => setDragPayload(e, v, row.symbol)}
                        onClick={() => setDetail({ symbol: row.symbol, field: col.key, row })}
                      >
                        {fmtNumber(v)}
                      </td>
                    );
                  }
                  if (col.key === 'price_change' || col.key === 'price_change_pct') {
                    const v = row[col.key] as number | null | undefined;
                    const cls = typeof v === 'number' ? (v > 0 ? 'cell-pos' : v < 0 ? 'cell-neg' : '') : '';
                    return (
                      <td
                        key={col.key}
                        className={cls}
                        style={{ textAlign: 'right', cursor: 'grab' }}
                        draggable={col.draggable}
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', String(v ?? ''))}
                      >
                        {fmtNumber(v)}
                        {col.key === 'price_change_pct' && typeof v === 'number' ? '%' : ''}
                      </td>
                    );
                  }
                  return (
                    <td
                      key={col.key}
                      style={{ textAlign: col.numeric ? 'right' : 'left', cursor: col.draggable ? 'grab' : undefined }}
                      draggable={col.draggable}
                      onDragStart={col.draggable ? (e) => e.dataTransfer.setData('text/plain', String(row[col.key] ?? '')) : undefined}
                      onClick={col.clickable ? () => setDetail({ symbol: row.symbol, field: col.key, row }) : undefined}
                    >
                      {col.numeric ? (col.format === 'int' ? fmtInt(row[col.key]) : fmtNumber(row[col.key])) : String(row[col.key] ?? '-')}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {detail && <CellDetail symbol={detail.symbol} field={detail.field} row={detail.row} onClose={() => setDetail(null)} />}
    </div>
  );
}
