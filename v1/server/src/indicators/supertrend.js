/**
 * Supertrend. ATR-band trend-following line, flips direction when close
 * crosses the active band. See docs/development_plan.md §2 and
 * docs/state_diagrams.md §2 for the direction flip state machine.
 *
 * Runs its own ATR sub-state at an independently configurable period from
 * the standalone ATR column.
 */
import * as atr from './atr.js';

export function createState() {
  return {
    atr: atr.createState(),
    finalUpper: null,
    finalLower: null,
    direction: null, // 'up' | 'down' | null (uninitialized)
    value: null,
    prevClose: null,
  };
}

/**
 * @param {object} state
 * @param {{ high: number, low: number, close: number }} bar
 * @param {{ atrPeriod: number, multiplier: number }} params
 * @returns {{ state: object, value: number|null, direction: 'up'|'down'|null }}
 */
export function update(state, bar, { atrPeriod, multiplier }) {
  const { high, low, close } = bar;
  const atrR = atr.update(state.atr, bar, { period: atrPeriod });

  if (atrR.atr === null) {
    return { state: { ...state, atr: atrR.state, prevClose: close }, value: null, direction: null };
  }

  const mid = (high + low) / 2;
  const basicUpper = mid + multiplier * atrR.atr;
  const basicLower = mid - multiplier * atrR.atr;

  if (state.direction === null) {
    // First primed bar: seed both bands, default direction 'down' (tracking upper band)
    // per docs/state_diagrams.md §2.
    const next = {
      atr: atrR.state, finalUpper: basicUpper, finalLower: basicLower,
      direction: 'down', value: basicUpper, prevClose: close,
    };
    return { state: next, value: next.value, direction: next.direction };
  }

  const prevClose = state.prevClose;
  const finalUpper = (basicUpper < state.finalUpper || prevClose > state.finalUpper) ? basicUpper : state.finalUpper;
  const finalLower = (basicLower > state.finalLower || prevClose < state.finalLower) ? basicLower : state.finalLower;

  let direction = state.direction;
  if (direction === 'down' && close > finalUpper) direction = 'up';
  else if (direction === 'up' && close < finalLower) direction = 'down';

  const value = direction === 'down' ? finalUpper : finalLower;

  const next = { atr: atrR.state, finalUpper, finalLower, direction, value, prevClose: close };
  return { state: next, value, direction };
}
