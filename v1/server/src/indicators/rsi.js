/**
 * RSI, Wilder-smoothed. See docs/development_plan.md §2.
 * State: { avgGain, avgLoss, primed, gains: number[], losses: number[], prevClose }
 * `gains`/`losses` only accumulate before `primed` (bootstrap window); dropped after.
 */

export function createState() {
  return { avgGain: null, avgLoss: null, primed: false, gains: [], losses: [], prevClose: null };
}

/**
 * @param {object} state
 * @param {number} close
 * @param {{ period: number }} params
 * @returns {{ state: object, rsi: number }}
 */
export function update(state, close, { period }) {
  if (state.prevClose === null) {
    return { state: { ...state, prevClose: close }, rsi: null };
  }

  const change = close - state.prevClose;
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);

  let next;
  if (!state.primed) {
    const gains = [...state.gains, gain];
    const losses = [...state.losses, loss];
    if (gains.length < period) {
      next = { ...state, gains, losses, prevClose: close };
      return { state: next, rsi: null };
    }
    const avgGain = gains.reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
    next = { avgGain, avgLoss, primed: true, gains: [], losses: [], prevClose: close };
  } else {
    const avgGain = (state.avgGain * (period - 1) + gain) / period;
    const avgLoss = (state.avgLoss * (period - 1) + loss) / period;
    next = { ...state, avgGain, avgLoss, prevClose: close };
  }

  const rsi = computeRsi(next.avgGain, next.avgLoss);
  return { state: next, rsi };
}

function computeRsi(avgGain, avgLoss) {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
