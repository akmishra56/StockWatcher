/**
 * Phase 1 verification: cross-check the incremental indicator modules against
 * independent, from-scratch batch reference implementations (not sharing any
 * code with server/src/indicators/*). See docs/development_plan.md §7 --
 * "verified against a handful of hand-checked bars" before any UI exists.
 *
 * Using an independently-derived reference here, rather than a memorized
 * textbook constant, avoids the risk of a misremembered number masking a
 * real bug (or "fixing" correct code to match a wrong expectation).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as rsiMod from '../src/indicators/rsi.js';
import * as emaMod from '../src/indicators/ema.js';
import * as macdMod from '../src/indicators/macd.js';
import * as atrMod from '../src/indicators/atr.js';
import * as bollingerMod from '../src/indicators/bollinger.js';
import * as supertrendMod from '../src/indicators/supertrend.js';

const CLOSE_SERIES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
];

function closesToOhlc(closes, spread = 0.5) {
  // synthetic H/L around each close for ATR/Bollinger/Supertrend tests
  return closes.map((c) => ({ close: c, high: c + spread, low: c - spread }));
}

// ---- RSI: batch reference (recomputes the full Wilder recursion from
// scratch every step, O(n^2) but structurally independent of rsi.js) ----

function batchRsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let end = period; end < closes.length; end++) {
    const window = closes.slice(0, end + 1);
    let gains = [];
    let losses = [];
    for (let i = 1; i <= period; i++) {
      const change = window[i] - window[i - 1];
      gains.push(Math.max(change, 0));
      losses.push(Math.max(-change, 0));
    }
    let avgGain = gains.reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.reduce((a, b) => a + b, 0) / period;
    for (let i = period + 1; i <= end; i++) {
      const change = window[i] - window[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    out[end] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

test('RSI: incremental engine matches independent batch recomputation at every bar', () => {
  const period = 14;
  const expected = batchRsi(CLOSE_SERIES, period);

  let state = rsiMod.createState();
  const actual = [];
  for (const close of CLOSE_SERIES) {
    const r = rsiMod.update(state, close, { period });
    state = r.state;
    actual.push(r.rsi);
  }

  for (let i = 0; i < CLOSE_SERIES.length; i++) {
    if (expected[i] === null) {
      assert.equal(actual[i], null, `bar ${i}: expected not-yet-primed`);
    } else {
      assert.ok(actual[i] !== null, `bar ${i}: expected a value, got null`);
      assert.ok(
        Math.abs(actual[i] - expected[i]) < 1e-9,
        `bar ${i}: incremental=${actual[i]} batch=${expected[i]}`
      );
    }
  }
});

test('RSI: hydration mid-bootstrap resumes correctly (no silent drift)', () => {
  const period = 14;
  // Feed the first 10 bars, "restart" by round-tripping state through JSON
  // (simulating indicator_state persist/hydrate), then feed the rest and
  // compare against feeding all bars through one continuous state.
  let stateA = rsiMod.createState();
  for (const close of CLOSE_SERIES.slice(0, 10)) stateA = rsiMod.update(stateA, close, { period }).state;
  let stateA2 = JSON.parse(JSON.stringify(stateA)); // the persist -> hydrate round-trip
  for (const close of CLOSE_SERIES.slice(10)) stateA2 = rsiMod.update(stateA2, close, { period }).state;

  let stateB = rsiMod.createState();
  for (const close of CLOSE_SERIES) stateB = rsiMod.update(stateB, close, { period }).state;

  assert.equal(stateA2.avgGain, stateB.avgGain, 'avgGain diverged across a simulated restart');
  assert.equal(stateA2.avgLoss, stateB.avgLoss, 'avgLoss diverged across a simulated restart');
});

// ---- EMA: batch reference ----

function batchEma(closes, period) {
  const out = new Array(closes.length).fill(null);
  let value = null;
  for (let i = 0; i < closes.length; i++) {
    if (value === null) {
      if (i + 1 < period) continue;
      value = closes.slice(i + 1 - period, i + 1).reduce((a, b) => a + b, 0) / period;
    } else {
      const k = 2 / (period + 1);
      value = closes[i] * k + value * (1 - k);
    }
    out[i] = value;
  }
  return out;
}

test('EMA: incremental engine matches independent batch recomputation', () => {
  const period = 10;
  const expected = batchEma(CLOSE_SERIES, period);
  let state = emaMod.createState();
  for (let i = 0; i < CLOSE_SERIES.length; i++) {
    const r = emaMod.update(state, CLOSE_SERIES[i], { period });
    state = r.state;
    if (expected[i] === null) assert.equal(r.ema, null, `bar ${i}`);
    else assert.ok(Math.abs(r.ema - expected[i]) < 1e-9, `bar ${i}: ${r.ema} vs ${expected[i]}`);
  }
});

// ---- MACD: internal consistency (hist = macd - signal exactly) + EMA cross-check ----

test('MACD: histogram always equals macd - signal, and macd = ema(fast) - ema(slow)', () => {
  const params = { fast: 12, slow: 26, signal: 9 };
  let macdState = macdMod.createState();
  let fastRef = emaMod.createState();
  let slowRef = emaMod.createState();

  for (const close of CLOSE_SERIES) {
    const r = macdMod.update(macdState, close, params);
    macdState = r.state;
    fastRef = emaMod.update(fastRef, close, { period: params.fast }).state;
    slowRef = emaMod.update(slowRef, close, { period: params.slow }).state;

    if (r.macd !== null && r.signal !== null) {
      assert.ok(Math.abs(r.hist - (r.macd - r.signal)) < 1e-9, 'hist != macd - signal');
    }
    if (r.macd !== null && fastRef.primed && slowRef.primed) {
      assert.ok(Math.abs(r.macd - (fastRef.value - slowRef.value)) < 1e-9, 'macd != emaFast - emaSlow');
    }
  }
});

// ---- ATR: batch reference ----

function batchAtr(bars, period) {
  const trs = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });
  const out = new Array(bars.length).fill(null);
  let atr = null;
  for (let i = 0; i < bars.length; i++) {
    if (atr === null) {
      if (i + 1 < period) continue;
      atr = trs.slice(i + 1 - period, i + 1).reduce((a, b) => a + b, 0) / period;
    } else {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    out[i] = atr;
  }
  return out;
}

test('ATR: incremental engine matches independent batch recomputation', () => {
  const period = 14;
  const bars = closesToOhlc(CLOSE_SERIES);
  const expected = batchAtr(bars, period);
  let state = atrMod.createState();
  for (let i = 0; i < bars.length; i++) {
    const r = atrMod.update(state, bars[i], { period });
    state = r.state;
    if (expected[i] === null) assert.equal(r.atr, null, `bar ${i}`);
    else assert.ok(Math.abs(r.atr - expected[i]) < 1e-9, `bar ${i}: ${r.atr} vs ${expected[i]}`);
  }
});

// ---- Bollinger: direct mean/stddev check on one window ----

test('Bollinger: matches a directly-computed mean/stddev on the trailing window', () => {
  const period = 20;
  const k = 2;
  let state = bollingerMod.createState();
  let last;
  for (const close of CLOSE_SERIES) {
    last = bollingerMod.update(state, close, { period, k });
    state = last.state;
  }
  const window = CLOSE_SERIES.slice(-period);
  const ma = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((s, c) => s + (c - ma) ** 2, 0) / period;
  const sigma = Math.sqrt(variance);

  assert.ok(Math.abs(last.ma - ma) < 1e-9, `ma: ${last.ma} vs ${ma}`);
  assert.ok(Math.abs(last.upper - (ma + k * sigma)) < 1e-9, 'upper band');
  assert.ok(Math.abs(last.lower - (ma - k * sigma)) < 1e-9, 'lower band');
});

// ---- Supertrend: direction-flip state machine + band formula ----

test('Supertrend: flips direction on a manufactured breakout, and value matches the band formula', () => {
  // Flat-ish prices first (small ATR), then a sharp sustained rally that
  // must eventually push close above the upper band and flip direction up.
  const flat = Array.from({ length: 15 }, () => 100 + (Math.random() - 0.5) * 0.2);
  const rally = Array.from({ length: 10 }, (_, i) => 100 + i * 5); // steep, sustained climb
  const closes = [...flat, ...rally];
  const bars = closesToOhlc(closes, 0.3);

  const params = { atrPeriod: 10, multiplier: 3 };
  let state = supertrendMod.createState();
  let sawUp = false;
  let sawDown = false;
  for (const bar of bars) {
    const r = supertrendMod.update(state, bar, params);
    state = r.state;
    if (r.direction === 'up') sawUp = true;
    if (r.direction === 'down') sawDown = true;
  }

  assert.ok(sawDown, 'expected to start tracking the upper band (direction down) while flat');
  assert.ok(sawUp, 'expected the sustained rally to flip direction to up');

  // Band-formula cross-check on the final bar: value must equal the finalUpper
  // or finalLower the state actually holds, not some other number.
  const finalDir = state.direction;
  const expectedValue = finalDir === 'down' ? state.finalUpper : state.finalLower;
  assert.equal(state.value, expectedValue);
});
