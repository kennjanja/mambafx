// Compatibility adapter: lets Bazu consume the shared pivot engine with the exact output shape
// of mtf/src/analysis/swingPoints.js#findSwingPoints (strict ties on both sides, sorted by index,
// highs before lows at the same index). Equivalence is asserted in tests/analysis/bazu-adapter.test.mjs.
import { detectPivots } from '../analysis/pivots.js';

export function findSwingPoints(candles, lookback = 2) {
  const { confirmed } = detectPivots(candles, lookback, true);
  return confirmed
    .map(p => ({ index: p.index, epoch: p.epoch, price: p.price, type: p.type }))
    .sort((a, b) => a.index - b.index || (a.type === 'high' ? -1 : 1));
}
