/**
 * ATR, Wilder-smoothed average true range. See docs/development_plan.md §2.
 * State: { atr, prevClose, primed, trBuffer: number[] }
 */

export function createState() {
  return { atr: null, prevClose: null, primed: false, trBuffer: [] };
}

/**
 * @param {object} state
 * @param {{ high: number, low: number, close: number }} bar
 * @param {{ period: number }} params
 * @returns {{ state: object, atr: number|null }}
 */
export function update(state, { high, low, close }, { period }) {
  const tr = state.prevClose === null
    ? high - low
    : Math.max(high - low, Math.abs(high - state.prevClose), Math.abs(low - state.prevClose));

  if (!state.primed) {
    const trBuffer = [...state.trBuffer, tr];
    if (trBuffer.length < period) {
      return { state: { ...state, trBuffer, prevClose: close }, atr: null };
    }
    const atr = trBuffer.reduce((a, b) => a + b, 0) / period;
    return { state: { atr, prevClose: close, primed: true, trBuffer: [] }, atr };
  }

  const atr = (state.atr * (period - 1) + tr) / period;
  return { state: { ...state, atr, prevClose: close }, atr };
}
