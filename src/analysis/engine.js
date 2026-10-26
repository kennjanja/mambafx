import { DEFAULTS, sanitize, atrSeries } from './core.js';
import { analyzeStructure } from './structure.js';
import { analyzeLiquidity } from './liquidity.js';

export * from './core.js';
export { detectPivots, classifyPivots } from './pivots.js';
export { detectDisplacement } from './displacement.js';
export { detectStructure, analyzeStructure } from './structure.js';
export { analyzeLiquidity, referenceLevels } from './liquidity.js';

// One-call entry point. Returns the sanitised candles so every index in the result is valid against them.
export function analyze(input, opts = {}) {
  const { candles, dropped } = sanitize(input);
  const o = { ...DEFAULTS, ...opts };
  const atr = atrSeries(candles, o.atrPeriod);
  const structure = analyzeStructure(candles, { ...o, atr });
  const liquidity = analyzeLiquidity(candles, { ...o, atr, pivots: structure.internal.pivots });
  return { candles, dropped, atr, ...structure, liquidity, options: o };
}
