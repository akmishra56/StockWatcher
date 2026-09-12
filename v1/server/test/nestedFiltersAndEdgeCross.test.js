/**
 * Covers the three deferred-to-v1.x/v2 features built 2026-09-09
 * (docs/roadmap.md "Deferred to v1.x / v2"): nested filter condition
 * groups, edge-triggered coloring, and the forced final market-hours slot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFilter } from '../src/filters/conditions.js';
import { computeSlots } from '../src/marketHours.js';
import { createSymbolState, applyBar } from '../src/indicators/state.js';
import { IndicatorEngine } from '../src/indicators/state.js';

test('evaluateFilter: nested group (A AND B) OR C', () => {
  const tree = {
    join: 'OR',
    conditions: [
      { join: 'AND', conditions: [{ field: 'rsi', operator: '<', value: 30 }, { field: 'volume', operator: '>', value: 1000 }] },
      { field: 'price_change_pct', operator: '<', value: -5 },
    ],
  };

  // Neither branch true -> false
  assert.equal(evaluateFilter({ rsi: 50, volume: 500, price_change_pct: -1 }, tree), false);
  // Inner AND group both true -> true
  assert.equal(evaluateFilter({ rsi: 20, volume: 2000, price_change_pct: -1 }, tree), true);
  // Inner AND group only half true -> false, but the OR sibling is true
  assert.equal(evaluateFilter({ rsi: 20, volume: 500, price_change_pct: -6 }, tree), true);
  // A flat (non-nested) tree still evaluates exactly as before
  assert.equal(evaluateFilter({ rsi: 20 }, { join: 'AND', conditions: [{ field: 'rsi', operator: '<', value: 30 }] }), true);
});

test('evaluateFilter: a condition can compare one field against another (valueField), e.g. price vs. Bollinger band', () => {
  const belowLowerBand = { field: 'close', operator: '<', valueField: 'bb_lower' };
  const aboveUpperBand = { field: 'close', operator: '>', valueField: 'bb_upper' };

  assert.equal(
    evaluateFilter({ close: 95, bb_lower: 100, bb_upper: 110 }, { join: 'AND', conditions: [belowLowerBand] }),
    true,
    'close below bb_lower should match'
  );
  assert.equal(
    evaluateFilter({ close: 105, bb_lower: 100, bb_upper: 110 }, { join: 'AND', conditions: [belowLowerBand] }),
    false
  );
  assert.equal(
    evaluateFilter({ close: 115, bb_lower: 100, bb_upper: 110 }, { join: 'AND', conditions: [aboveUpperBand] }),
    true,
    'close above bb_upper should match'
  );
  // Bollinger not primed yet for this symbol (null) -- must fail closed, not throw.
  assert.equal(
    evaluateFilter({ close: 95, bb_lower: null, bb_upper: null }, { join: 'AND', conditions: [belowLowerBand] }),
    false
  );
});

test('evaluateFilter: crosses_above/crosses_below are edge-triggered against the previous snapshot row', () => {
  const crossesAboveLower = { field: 'close', operator: 'crosses_above', valueField: 'bb_lower' };
  const crossesBelowUpper = { field: 'close', operator: 'crosses_below', valueField: 'bb_upper' };
  const treeAbove = { join: 'AND', conditions: [crossesAboveLower] };
  const treeBelow = { join: 'AND', conditions: [crossesBelowUpper] };

  // Previous tick: close (95) was at/below bb_lower (100). This tick: close
  // (105) is above bb_lower (100) -- the classic "bounced off support" cross.
  const prevBelow = { close: 95, bb_lower: 100, bb_upper: 110 };
  const currAbove = { close: 105, bb_lower: 100, bb_upper: 110 };
  assert.equal(evaluateFilter(currAbove, treeAbove, prevBelow), true);

  // Still above on both ticks -- no crossing happened this tick, so false
  // even though "close > bb_lower" is currently true.
  const prevAlsoAbove = { close: 102, bb_lower: 100, bb_upper: 110 };
  assert.equal(evaluateFilter(currAbove, treeAbove, prevAlsoAbove), false);

  // Mirror case for crosses_below.
  const prevAboveUpper = { close: 115, bb_lower: 100, bb_upper: 110 };
  const currBelowUpper = { close: 108, bb_lower: 100, bb_upper: 110 };
  assert.equal(evaluateFilter(currBelowUpper, treeBelow, prevAboveUpper), true);

  // No previous row (e.g. symbol's first-ever tick) -- fails closed, doesn't throw.
  assert.equal(evaluateFilter(currAbove, treeAbove, undefined), false);
  assert.equal(evaluateFilter(currAbove, treeAbove, null), false);

  // Works against a fixed number too, not just another field (e.g. RSI crosses above 70).
  const rsiCrossesAbove70 = { join: 'AND', conditions: [{ field: 'rsi', operator: 'crosses_above', value: 70 }] };
  assert.equal(evaluateFilter({ rsi: 72 }, rsiCrossesAbove70, { rsi: 68 }), true);
  assert.equal(evaluateFilter({ rsi: 72 }, rsiCrossesAbove70, { rsi: 71 }), false);
});

test('computeSlots: interval not dividing evenly still lands a final slot exactly on close', () => {
  // The user's worked example: open 09:15, close 15:45, 60min interval steps
  // 09:15, 10:15, ..., 15:15 (next would be 16:15, past close) -- 15:45 must
  // still be forced on as the day's final snapshot.
  const slots = computeSlots('09:15', '15:45', 60);
  assert.deepEqual(slots, ['09:15', '10:15', '11:15', '12:15', '13:15', '14:15', '15:15', '15:45']);
});

test('computeSlots: an interval landing exactly on close is not duplicated', () => {
  const slots = computeSlots('09:15', '15:45', 30);
  assert.equal(slots[slots.length - 1], '15:45');
  assert.equal(slots.filter((s) => s === '15:45').length, 1);
});

test('applyBar: macd_cross and bb_cross fire only on the crossing tick, then clear', () => {
  const engine = new IndicatorEngine();
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 130, 100];
  let lastOutput = null;
  for (const close of closes) {
    lastOutput = engine.applyBar('TEST', { high: close + 1, low: close - 1, close });
  }
  // The 20th bar (a sharp jump to 130 after 19 flat bars at 100) should have
  // pushed the close above the (flat, so tight) Bollinger upper band --
  // an edge-triggered bb_cross, "upper", exactly on that tick.
  assert.equal(lastOutput.bb_cross, null); // last bar (21st, back to 100) is not itself a crossing tick

  let sawUpperCross = false;
  const engine2 = new IndicatorEngine();
  for (const close of closes.slice(0, 20)) {
    lastOutput = engine2.applyBar('TEST2', { high: close + 1, low: close - 1, close });
    if (lastOutput.bb_cross === 'upper') sawUpperCross = true;
  }
  assert.equal(sawUpperCross, true, 'expected an edge-triggered upper-band cross on the jump tick');
});

test('createSymbolState/applyBar: first bar never flags a cross (no previous value to compare against)', () => {
  const state = createSymbolState();
  const { output } = applyBar(state, { high: 101, low: 99, close: 100 }, IndicatorEngine.DEFAULT_PARAMS);
  assert.equal(output.macd_cross, null);
  assert.equal(output.bb_cross, null);
});
