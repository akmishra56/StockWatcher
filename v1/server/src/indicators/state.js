/**
 * Per-symbol indicator state store + the O(1) hydration path.
 * See docs/development_plan.md §3, docs/component_design.md §2.
 */
import * as bollinger from './bollinger.js';
import * as rsi from './rsi.js';
import * as macd from './macd.js';
import * as atr from './atr.js';
import * as ema from './ema.js';
import * as supertrend from './supertrend.js';

export function createSymbolState() {
  return {
    bollinger: bollinger.createState(),
    rsi: rsi.createState(),
    macd: macd.createState(),
    atr: atr.createState(),
    ema10: ema.createState(),
    ema30: ema.createState(),
    supertrend: supertrend.createState(),
    prev: null, // { close, macdHist, bbUpper, bbLower } from the previous bar -- edge-cross detection only
  };
}

/**
 * Edge-triggered coloring (docs/roadmap.md "Deferred to v1.x/v2", built
 * 2026-09-09): unlike the state-based Bollinger/RSI coloring elsewhere in
 * this app (a pure function of the CURRENT value), these flags are true only
 * on the exact tick a threshold is crossed, by comparing this bar's output
 * against the previous bar's. They naturally self-clear next cycle since a
 * fresh snapshot row is written every tick.
 */
function computeMacdCross(prevHist, newHist) {
  if (prevHist == null || newHist == null) return null;
  if (prevHist <= 0 && newHist > 0) return 'bullish';
  if (prevHist >= 0 && newHist < 0) return 'bearish';
  return null;
}

function computeBbCross(prev, close, upper, lower) {
  if (!prev || close == null) return null;
  if (upper != null && close > upper) {
    const prevAboveUpper = prev.close != null && prev.bbUpper != null && prev.close > prev.bbUpper;
    if (!prevAboveUpper) return 'upper';
  }
  if (lower != null && close < lower) {
    const prevBelowLower = prev.close != null && prev.bbLower != null && prev.close < prev.bbLower;
    if (!prevBelowLower) return 'lower';
  }
  return null;
}

/**
 * Applies one new bar to a symbol's full indicator state and returns the
 * updated state plus the computed output row. Pure function -- no I/O.
 *
 * @param {object} symState  from createSymbolState() or hydrated from DB
 * @param {{ high: number, low: number, close: number }} bar
 * @param {object} params    indicator parameters, see IndicatorEngine.DEFAULT_PARAMS
 */
export function applyBar(symState, bar, params) {
  const bb = bollinger.update(symState.bollinger, bar.close, params.bollinger);
  const rsiR = rsi.update(symState.rsi, bar.close, params.rsi);
  const macdR = macd.update(symState.macd, bar.close, params.macd);
  const atrR = atr.update(symState.atr, bar, params.atr);
  const ema10R = ema.update(symState.ema10, bar.close, { period: params.ema.short });
  const ema30R = ema.update(symState.ema30, bar.close, { period: params.ema.long });
  const stR = supertrend.update(symState.supertrend, bar, params.supertrend);

  const macdCross = computeMacdCross(symState.prev?.macdHist, macdR.hist);
  const bbCross = computeBbCross(symState.prev, bar.close, bb.upper, bb.lower);

  const nextState = {
    bollinger: bb.state, rsi: rsiR.state, macd: macdR.state, atr: atrR.state,
    ema10: ema10R.state, ema30: ema30R.state, supertrend: stR.state,
    prev: { close: bar.close, macdHist: macdR.hist, bbUpper: bb.upper, bbLower: bb.lower },
  };

  const output = {
    bb_upper: bb.upper, bb_lower: bb.lower, bb_ma: bb.ma,
    rsi: rsiR.rsi,
    macd: macdR.macd, macd_signal: macdR.signal, macd_hist: macdR.hist,
    atr: atrR.atr,
    ema10: ema10R.ema, ema30: ema30R.ema,
    supertrend_value: stR.value, supertrend_direction: stR.direction,
    macd_cross: macdCross, bb_cross: bbCross,
  };

  return { state: nextState, output };
}

/**
 * In-memory Map<symbol, symState>, plus the hydrate/persist boundary
 * against DbClient. This is the object ingestPipeline.js drives.
 */
export class IndicatorEngine {
  static DEFAULT_PARAMS = {
    bollinger: { period: 20, k: 2 },
    rsi: { period: 14 },
    macd: { fast: 12, slow: 26, signal: 9 },
    atr: { period: 14 },
    ema: { short: 10, long: 30 },
    supertrend: { atrPeriod: 10, multiplier: 3 },
  };

  constructor(params = IndicatorEngine.DEFAULT_PARAMS) {
    this.params = params;
    /** @type {Map<string, object>} */
    this.states = new Map();
  }

  /** Called once at boot, before the watcher starts. See docs/activity_flows.md §4. */
  async hydrateFromDb(db) {
    const hydrated = await db.hydrateIndicatorState();
    for (const [symbol, state] of hydrated) this.states.set(symbol, state);
  }

  getOrCreate(symbol) {
    let state = this.states.get(symbol);
    if (!state) {
      state = createSymbolState();
      this.states.set(symbol, state);
    }
    return state;
  }

  /** @returns the computed output row for this symbol/bar */
  applyBar(symbol, bar) {
    const symState = this.getOrCreate(symbol);
    const { state, output } = applyBar(symState, bar, this.params);
    this.states.set(symbol, state);
    return output;
  }

  async persistState(db, symbol, nowIst) {
    await db.writeIndicatorState(symbol, this.states.get(symbol), nowIst);
  }
}
