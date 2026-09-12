/**
 * Standard EMA, seeded with SMA(period) on the first value.
 * See docs/development_plan.md §2. Reused by ema10/ema30 and internally by macd.js.
 * State: { value, primed, seedBuffer: number[] }
 */

export function createState() {
  return { value: null, primed: false, seedBuffer: [] };
}

/**
 * @param {object} state
 * @param {number} close
 * @param {{ period: number }} params
 * @returns {{ state: object, ema: number|null }}
 */
export function update(state, close, { period }) {
  if (!state.primed) {
    const seedBuffer = [...state.seedBuffer, close];
    if (seedBuffer.length < period) {
      return { state: { ...state, seedBuffer }, ema: null };
    }
    const value = seedBuffer.reduce((a, b) => a + b, 0) / period;
    return { state: { value, primed: true, seedBuffer: [] }, ema: value };
  }

  const k = 2 / (period + 1);
  const value = close * k + state.value * (1 - k);
  return { state: { ...state, value }, ema: value };
}
