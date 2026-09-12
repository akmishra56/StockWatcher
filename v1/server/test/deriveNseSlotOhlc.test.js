/**
 * NSE's live equity feed reports OPEN/HIGH/LOW as day-cumulative stats, not
 * a real per-interval candle (docs/issues.md, 2026-09-09) -- this covers the
 * derivation that turns those into an actual per-slot bar. See
 * src/ingest/deriveNseSlotOhlc.js for the full rationale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveNseSlotOhlc } from '../src/ingest/deriveNseSlotOhlc.js';

test('deriveNseSlotOhlc: first bar of the day (no previous state) falls back to the raw NSE values', () => {
  const result = deriveNseSlotOhlc({
    prevClose: null, rawOpen: 2830, rawHigh: 2850, rawLow: 2825, close: 2847.6,
    prevRawHigh: null, prevRawLow: null,
  });
  assert.deepEqual(result, { open: 2830, high: 2850, low: 2825, close: 2847.6 });
});

test('deriveNseSlotOhlc: open picks up from the previous slot\'s close, not the day\'s raw open', () => {
  const result = deriveNseSlotOhlc({
    prevClose: 2847.6, rawOpen: 2830, rawHigh: 2850, rawLow: 2825, close: 2860,
    prevRawHigh: 2850, prevRawLow: 2825,
  });
  assert.equal(result.open, 2847.6);
});

test('deriveNseSlotOhlc: day-high unchanged since last poll -> high derived from this slot\'s own open/close, not the stale day-high', () => {
  // Day-high was 2850 last poll and still 2850 now -- nothing proves that
  // high was touched again THIS slot, so high should just be max(open, close).
  const result = deriveNseSlotOhlc({
    prevClose: 2840, rawOpen: 2830, rawHigh: 2850, rawLow: 2825, close: 2845,
    prevRawHigh: 2850, prevRawLow: 2825,
  });
  assert.equal(result.high, 2845, 'max(open=2840, close=2845), NOT the stale day-high 2850');
});

test('deriveNseSlotOhlc: day-high just increased this poll -> that new high really was set this slot', () => {
  const result = deriveNseSlotOhlc({
    prevClose: 2840, rawOpen: 2830, rawHigh: 2858, rawLow: 2825, close: 2845,
    prevRawHigh: 2850, prevRawLow: 2825,
  });
  assert.equal(result.high, 2858, 'day-high moved 2850 -> 2858 this poll, so it belongs to this slot');
});

test('deriveNseSlotOhlc: day-low unchanged since last poll -> low derived from this slot\'s own open/close', () => {
  const result = deriveNseSlotOhlc({
    prevClose: 2840, rawOpen: 2830, rawHigh: 2850, rawLow: 2820, close: 2845,
    prevRawHigh: 2850, prevRawLow: 2820,
  });
  assert.equal(result.low, 2840, 'min(open=2840, close=2845), NOT the stale day-low 2820');
});

test('deriveNseSlotOhlc: day-low just decreased this poll -> that new low really was set this slot', () => {
  const result = deriveNseSlotOhlc({
    prevClose: 2840, rawOpen: 2830, rawHigh: 2850, rawLow: 2818, close: 2845,
    prevRawHigh: 2850, prevRawLow: 2820,
  });
  assert.equal(result.low, 2818, 'day-low moved 2820 -> 2818 this poll, so it belongs to this slot');
});

test('deriveNseSlotOhlc: high/low always at least cover open and close, even with no fresh day-extreme', () => {
  const result = deriveNseSlotOhlc({
    prevClose: 2840, rawOpen: 2830, rawHigh: 2850, rawLow: 2820, close: 2861,
    prevRawHigh: 2850, prevRawLow: 2820,
  });
  assert.equal(result.open, 2840);
  assert.equal(result.high, 2861, 'close (2861) exceeds the unchanged day-high (2850) -- high must still cover it');
  assert.equal(result.low, 2840, 'min(open, close) since neither day-extreme moved');
});
