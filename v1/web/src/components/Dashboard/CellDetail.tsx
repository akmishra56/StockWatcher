import type { SnapshotRow } from '../../hooks/useLiveSnapshot';

const FIELD_LABELS: Record<string, string> = {
  rsi: 'RSI', macd: 'MACD', atr: 'ATR', ema10: 'EMA 10', ema30: 'EMA 30',
  supertrend_value: 'Supertrend', bb_ma: 'Bollinger Bands', close: 'Close', volume: 'Volume',
};

/** Formula/inputs behind a computed cell, built only from fields already in the snapshot row. */
function describe(field: string, row: SnapshotRow): { formula: string; inputs: [string, string][] } {
  switch (field) {
    case 'rsi':
      return {
        formula: 'RSI = 100 − 100 / (1 + avgGain⁄avgLoss)   (Wilder-smoothed, period 14)',
        inputs: [
          ['RSI', fmt(row.rsi)],
          ['Reads as', row.rsi != null && row.rsi < 30 ? 'Oversold' : row.rsi != null && row.rsi > 70 ? 'Overbought' : 'Neutral'],
        ],
      };
    case 'macd':
    case 'macd_signal':
    case 'macd_hist':
      return {
        formula: 'MACD = EMA(fast) − EMA(slow)   ·   Signal = EMA(MACD, 9)   ·   Hist = MACD − Signal',
        inputs: [
          ['MACD', fmt(row.macd)],
          ['Signal', fmt(row.macd_signal)],
          ['Histogram', fmt(row.macd_hist)],
        ],
      };
    case 'atr':
      return {
        formula: 'ATR = Wilder-smoothed average of True Range over 14 bars',
        inputs: [['ATR', fmt(row.atr)], ['High', fmt(row.high)], ['Low', fmt(row.low)]],
      };
    case 'ema10':
    case 'ema30':
      return {
        formula: 'EMA = close × k + EMA(prev) × (1 − k),  k = 2 / (period + 1)',
        inputs: [['EMA 10', fmt(row.ema10)], ['EMA 30', fmt(row.ema30)], ['Close', fmt(row.close)]],
      };
    case 'supertrend_value':
      return {
        formula: 'Supertrend band = HL/2 ± (multiplier × ATR); direction flips on a close crossing the opposite band',
        inputs: [['Value', fmt(row.supertrend_value)], ['Direction', String(row.supertrend_direction ?? '-')]],
      };
    case 'bb_upper':
    case 'bb_lower':
    case 'bb_ma':
      return {
        formula: 'Bands = SMA(20) ± k × stddev(20),  k = 2',
        inputs: [['Upper', fmt(row.bb_upper)], ['Middle (SMA)', fmt(row.bb_ma)], ['Lower', fmt(row.bb_lower)]],
      };
    default:
      return { formula: '', inputs: [[FIELD_LABELS[field] ?? field, fmt(row[field] as number)]] };
  }
}

function fmt(n: unknown): string {
  return typeof n === 'number' ? n.toFixed(2) : '-';
}

export function CellDetail({ symbol, field, row, onClose }: { symbol: string; field: string; row: SnapshotRow; onClose: () => void }) {
  const { formula, inputs } = describe(field, row);
  return (
    <div className="cell-detail-backdrop" onClick={onClose}>
      <div className="cell-detail" onClick={(e) => e.stopPropagation()}>
        <div className="cell-detail-header">
          <span className="symbolName">{symbol}</span>
          <span className="text-2">{FIELD_LABELS[field] ?? field}</span>
          <button className="chip-toggle" onClick={onClose}>
            ✕
          </button>
        </div>
        {formula && <div className="codeblock">{formula}</div>}
        <table className="cell-detail-inputs">
          <tbody>
            {inputs.map(([label, value]) => (
              <tr key={label}>
                <td className="text-2">{label}</td>
                <td className="inputVal">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
