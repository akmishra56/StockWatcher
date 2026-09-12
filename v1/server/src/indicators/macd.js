/**
 * MACD = EMA(fast) - EMA(slow); Signal = EMA(signal) of the MACD line; Hist = MACD - Signal.
 * See docs/development_plan.md §2. State composes three ema.js sub-states.
 */
import * as ema from './ema.js';

export function createState() {
  return { fast: ema.createState(), slow: ema.createState(), signal: ema.createState() };
}

/**
 * @param {object} state
 * @param {number} close
 * @param {{ fast: number, slow: number, signal: number }} params
 * @returns {{ state: object, macd: number|null, signal: number|null, hist: number|null }}
 */
export function update(state, close, { fast, slow, signal }) {
  const fastR = ema.update(state.fast, close, { period: fast });
  const slowR = ema.update(state.slow, close, { period: slow });

  if (fastR.ema === null || slowR.ema === null) {
    return { state: { ...state, fast: fastR.state, slow: slowR.state }, macd: null, signal: null, hist: null };
  }

  const macdLine = fastR.ema - slowR.ema;
  const signalR = ema.update(state.signal, macdLine, { period: signal });

  const hist = signalR.ema === null ? null : macdLine - signalR.ema;
  return {
    state: { fast: fastR.state, slow: slowR.state, signal: signalR.state },
    macd: macdLine,
    signal: signalR.ema,
    hist,
  };
}
