import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFvgFormation, fvgCorrection, fvgContext, fvgSwingPosition } from '../../src/analysis/fvgQualification.js';
import { renderZones } from '../../src/analysis/render.js';

const candle = (open, high, low, close) => ({ open, high, low, close });

test('bullish and bearish gaps use their gap-facing wicks and outer bodies', () => {
  const bull = assessFvgFormation(candle(9, 10, 8.8, 9.8), candle(12, 12.5, 11, 11.2), 1);
  assert.ok(bull.qualified);
  assert.equal(bull.gapThirdRange, 1 / 1.5);
  const bear = assessFvgFormation(candle(-9, -8.8, -10, -9.8), candle(-12, -11, -12.5, -11.2), -1);
  assert.deepEqual(bear, bull);
});

test('a long gap-facing wick or dissimilar outer bodies fails quality, not gap existence', () => {
  const longWick = assessFvgFormation(candle(9, 10.5, 9, 9.8), candle(12, 12.5, 11, 11.2), 1);
  assert.ok(longWick);
  assert.equal(longWick.qualified, false);
  const different = assessFvgFormation(candle(9, 10, 8.8, 9.8), candle(12, 12.5, 11, 11.5), 1);
  assert.equal(different.qualified, false);
  assert.equal(assessFvgFormation(candle(9, 10, 8, 9.5), candle(9, 10, 8, 9.5), 1), null);
});

test('correction checks only the first three completed candles and records wick depth', () => {
  const bars = [candle(0, 1, 0, 1), candle(12, 13, 11, 12), candle(12, 13, 11, 12),
    candle(12, 13, 10.5, 12), candle(12, 13, 10, 12)];
  assert.equal(fvgCorrection(bars.slice(0, 3), 0, 1, 10, 10.5), null);
  assert.deepEqual(fvgCorrection(bars, 0, 1, 10, 10.5), { index: 3, depth: 0 });
  assert.equal(fvgCorrection([...bars.slice(0, 3), candle(12, 13, 11, 12), bars[4]], 0, 1, 10, 10.5), null);
  assert.equal(fvgCorrection([bars[0], candle(9, 9.5, 8, 9)], 0, 1, 10, 10.5), null);
  assert.equal(fvgCorrection(bars, 0, 1, 10, 10.5, 2), null);
});

test('context uses only confirmed events in the current leg and ten-bar window', () => {
  const pivots = [{ type: 'low', index: 8, confirmedIndex: 10 }];
  const sweeps = [{ kind: 'sweep-confirmed', side: 'sell', index: 12, confirmedIndex: 14 }];
  const breaks = [{ type: 'BOS', dir: 1, index: 15, confirmedIndex: 15 }];
  assert.equal(fvgContext(1, 15, pivots, breaks, sweeps).tier, 'premium');
  assert.equal(fvgContext(1, 13, pivots, breaks, sweeps).tier, 'basic');
  assert.equal(fvgContext(1, 15, pivots, breaks, []).tier, 'good');
  assert.equal(fvgContext(1, 25, pivots, breaks, sweeps).tier, 'good');
  assert.equal(fvgContext(1, 26, pivots, breaks, sweeps).tier, 'basic');
  assert.equal(fvgContext(1, 15, [], breaks, sweeps).tier, 'unknown');
});

test('swing position waits for the producing swing to confirm and mirrors by direction', () => {
  const bull = [{ type: 'low', index: 4, confirmedIndex: 6, price: 90 },
    { type: 'high', index: 10, confirmedIndex: 13, price: 110 }];
  assert.equal(fvgSwingPosition(1, 10, 95, bull, 12), null);
  assert.deepEqual(fvgSwingPosition(1, 10, 95, bull, 13),
    { low: 90, high: 110, position: 0.25, zone: 'discount', preferred: true, confirmedIndex: 13 });
  const bear = [{ type: 'high', index: 4, confirmedIndex: 6, price: 110 },
    { type: 'low', index: 10, confirmedIndex: 13, price: 90 }];
  assert.equal(fvgSwingPosition(-1, 10, 105, bear, 13).preferred, true);
  assert.equal(fvgSwingPosition(-1, 10, 95, bear, 13).preferred, false);
  assert.equal(fvgSwingPosition(-1, 10, 100, bear, 13).zone, 'equilibrium');
});

test('chart labels do not present incomplete-candle observations as confirmed', () => {
  const zone = { id: 1, kind: 'FVG', dir: 1, status: 'active', fill: 0, bottom: 1, top: 3, mid: 2,
    createdIndex: 1, confirmedIndex: 2, fvgQuality: { tier: 'premium', qualified: true } };
  const geometry = { start: 0, count: 10, lo: 0, hi: 4, padL: 0, chartRight: 100, xAt: (i) => i * 10, clampY: (p) => p * 10 };
  assert.match(renderZones([zone], geometry, { asOfIndex: 1 }), /forming/);
  const options = { asOfIndex: 2, fvgCorrections: [{ zoneId: 1, confirmedIndex: 3, deep: true }] };
  assert.match(renderZones([zone], geometry, options), /awaiting touch/);
  assert.doesNotMatch(renderZones([zone], geometry, options), / deep/);
  assert.match(renderZones([zone], geometry, { ...options, asOfIndex: 3 }), / deep/);
});
