import { useEffect, useMemo, useState } from 'react';
import { api, type Settings } from '../../api';
import { SYMBOL_MIME } from '../../dragPayload';

type Side = 'long' | 'short';
type SlMode = 'price' | 'percent';

const RR_PRESETS = [1, 1.5, 2, 3, 4];
const MAX_SUGGESTIONS = 8;

function fmt(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '-' : n.toFixed(2);
}

/**
 * TradingView-style long/short position tool: pick a side, drag in an
 * entry price (same drag payload the numeric Calculator and table cells
 * already produce), set risk via a stop-loss price or a % of entry, and a
 * reward multiple -- target and stop-loss price fall out of that directly.
 * A quantity (units) multiplier turns the per-share risk/reward into an
 * Expected Profit and Potential Loss for the whole position. "Save to Trade
 * Log" persists the calculation (Dashboard > Trade Log tab), where
 * tradeLogScheduler.js tracks it through to completion.
 *
 * Ticker is a free-text field with a searchable autocomplete against
 * `universeFilter` -- the Dashboard's currently active super filter, passed
 * down from DashboardTab so the suggestion list always matches whatever
 * table is on screen. Dragging a price cell also fills the ticker with that
 * row's symbol (see dragPayload.ts) -- since the table itself is already
 * super-filtered, a drag is always consistent with the active universe.
 * Sits below the plain numeric Calculator on the Dashboard's right rail.
 */
export function PositionCalculator({ universeFilter }: { universeFilter: Settings['superFilter'] }) {
  const [side, setSide] = useState<Side>('long');
  const [symbol, setSymbol] = useState<string>('');
  const [tickerFocused, setTickerFocused] = useState(false);
  const [symbolList, setSymbolList] = useState<string[]>([]);
  const [entry, setEntry] = useState<string>('');
  const [rr, setRr] = useState<string>('2');
  const [slMode, setSlMode] = useState<SlMode>('percent');
  const [slValue, setSlValue] = useState<string>('1');
  const [multiplier, setMultiplier] = useState<string>('1');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    api.getSymbols(universeFilter).then((r) => setSymbolList(r.symbols)).catch(() => setSymbolList([]));
  }, [universeFilter]);

  const suggestions = useMemo(() => {
    const q = symbol.trim().toUpperCase();
    if (!q) return [];
    const startsWith = symbolList.filter((s) => s.startsWith(q));
    const contains = symbolList.filter((s) => !s.startsWith(q) && s.includes(q));
    return [...startsWith, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [symbol, symbolList]);

  const entryNum = Number(entry);
  const rrNum = Number(rr);
  const slNum = Number(slValue);
  const multiplierNum = Number(multiplier);
  const valid =
    entry !== '' && Number.isFinite(entryNum) && entryNum > 0 &&
    Number.isFinite(rrNum) && rrNum > 0 &&
    slValue !== '' && Number.isFinite(slNum) && slNum > 0 &&
    multiplier !== '' && Number.isFinite(multiplierNum) && multiplierNum > 0;

  const result = useMemo(() => {
    if (!valid) return null;

    const stopLossPrice =
      slMode === 'price'
        ? slNum
        : side === 'long'
        ? entryNum * (1 - slNum / 100)
        : entryNum * (1 + slNum / 100);

    const risk = side === 'long' ? entryNum - stopLossPrice : stopLossPrice - entryNum;
    if (risk <= 0) return { invalidStop: true as const };

    const reward = risk * rrNum;
    const target = side === 'long' ? entryNum + reward : entryNum - reward;

    return {
      invalidStop: false as const,
      stopLossPrice,
      targetPrice: target,
      riskPerShare: risk,
      rewardPerShare: reward,
      riskPct: (risk / entryNum) * 100,
      rewardPct: (reward / entryNum) * 100,
      expectedProfit: reward * multiplierNum,
      potentialLoss: risk * multiplierNum,
    };
  }, [valid, side, entryNum, rrNum, slMode, slNum, multiplierNum]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const value = e.dataTransfer.getData('text/plain');
    if (value && !Number.isNaN(Number(value)) && Number(value) > 0) {
      setEntry(String(Number(value)));
    }
    const draggedSymbol = e.dataTransfer.getData(SYMBOL_MIME);
    if (draggedSymbol) setSymbol(draggedSymbol);
  }

  return (
    <div className="position-calc">
      <div className="position-calc-header">
        <span className="text-2" style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}>POSITION CALCULATOR</span>
      </div>

      <label className={`position-side-slider position-side-${side}`}>
        <input type="checkbox" checked={side === 'short'} onChange={(e) => setSide(e.target.checked ? 'short' : 'long')} />
        <span className="position-side-track">
          <span className="position-side-label position-side-label-long">LONG</span>
          <span className="position-side-label position-side-label-short">SHORT</span>
          <span className="position-side-knob" />
        </span>
      </label>

      <div className="position-field" style={{ position: 'relative' }}>
        <label>Ticker</label>
        <input
          placeholder="e.g. RELIANCE"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          onFocus={() => setTickerFocused(true)}
          onBlur={() => setTickerFocused(false)}
        />
        {tickerFocused && suggestions.length > 0 && (
          <ul className="ticker-suggestions">
            {suggestions.map((s) => (
              <li key={s} onMouseDown={(e) => { e.preventDefault(); setSymbol(s); setTickerFocused(false); }}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className={`position-field position-entry ${dragOver ? 'calc-display-dragover' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <label>Entry Price</label>
        <input
          type="number"
          placeholder="drag a price here, or type"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
        />
      </div>

      <div className="position-field">
        <label>Risk : Reward</label>
        <div className="rr-chips">
          {RR_PRESETS.map((p) => (
            <button key={p} className={`chip-toggle ${rr === String(p) ? 'chip-toggle-active' : ''}`} onClick={() => setRr(String(p))}>
              1:{p}
            </button>
          ))}
        </div>
        <input type="number" min="0" step="0.1" value={rr} onChange={(e) => setRr(e.target.value)} />
      </div>

      <div className="position-field">
        <div className="position-field-label-row">
          <label>Stop Loss</label>
          <div className="sl-mode-toggle">
            <button className={`chip-toggle ${slMode === 'percent' ? 'chip-toggle-active' : ''}`} onClick={() => setSlMode('percent')}>%</button>
            <button className={`chip-toggle ${slMode === 'price' ? 'chip-toggle-active' : ''}`} onClick={() => setSlMode('price')}>Price</button>
          </div>
        </div>
        <input
          type="number"
          min="0"
          step={slMode === 'percent' ? 0.1 : 0.05}
          value={slValue}
          onChange={(e) => setSlValue(e.target.value)}
        />
      </div>

      <div className="position-field">
        <label>Quantity (units)</label>
        <input
          type="number"
          min="1"
          step="1"
          value={multiplier}
          onChange={(e) => setMultiplier(e.target.value)}
        />
      </div>

      <div className="position-calc-output">
        {!valid ? (
          <div className="text-3" style={{ fontSize: 11 }}>Enter an entry price, R:R and stop loss.</div>
        ) : result?.invalidStop ? (
          <div className="text-3" style={{ fontSize: 11, color: 'var(--neg)' }}>
            Stop loss must be {side === 'long' ? 'below' : 'above'} entry for a {side} position.
          </div>
        ) : result ? (
          <>
            <div className="position-output-row">
              <span className="text-2">Target Price</span>
              <span className="cell-pos position-output-value">{fmt(result.targetPrice)}</span>
            </div>
            <div className="position-output-row">
              <span className="text-2">Stop Loss Price</span>
              <span className="cell-neg position-output-value">{fmt(result.stopLossPrice)}</span>
            </div>
            <div className="position-output-row">
              <span className="text-3" style={{ fontSize: 10.5 }}>Risk / share</span>
              <span className="text-2" style={{ fontSize: 10.5 }}>{fmt(result.riskPerShare)} ({fmt(result.riskPct)}%)</span>
            </div>
            <div className="position-output-row">
              <span className="text-3" style={{ fontSize: 10.5 }}>Reward / share</span>
              <span className="text-2" style={{ fontSize: 10.5 }}>{fmt(result.rewardPerShare)} ({fmt(result.rewardPct)}%)</span>
            </div>
            <div className="position-output-row" style={{ marginTop: 4 }}>
              <span className="text-2">Expected Profit</span>
              <span className="cell-pos position-output-value">{fmt(result.expectedProfit)}</span>
            </div>
            <div className="position-output-row">
              <span className="text-2">Potential Loss</span>
              <span className="cell-neg position-output-value">{fmt(result.potentialLoss)}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
