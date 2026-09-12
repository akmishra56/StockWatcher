/**
 * Bollinger Bands. Not recursive -- a ring buffer of the last `period` closes.
 * See docs/development_plan.md §2. State: { closes: number[] }
 */

export function createState() {
  return { closes: [] };
}

/**
 * @param {object} state
 * @param {number} close
 * @param {{ period: number, k: number }} params
 * @returns {{ state: object, upper: number|null, lower: number|null, ma: number|null }}
 */
export function update(state, close, { period, k }) {
  const closes = [...state.closes, close].slice(-period);
  if (closes.length < period) {
    return { state: { closes }, upper: null, lower: null, ma: null };
  }

  const ma = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + (c - ma) ** 2, 0) / period;
  const sigma = Math.sqrt(variance);

  return { state: { closes }, upper: ma + k * sigma, lower: ma - k * sigma, ma };
}
