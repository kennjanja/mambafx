import { analyze } from './engine.js';
import { analyzeZones } from './zones.js';
import { analyzePatterns } from './patterns.js';

export function analyzeAll(candles, opts = {}) {
  const base = analyze(candles, opts);
  const z = analyzeZones(base.candles, { ...opts, atr: base.atr, structure: base });
  return { ...base, zones: z.zones };
}
export function analyzePat(candles, opts = {}) { return analyzePatterns(candles, opts); }
export { renderZones, renderStructure, renderLiquidity, visibleZones, renderCandlePatterns, renderChartPatterns, renderWyckoff, renderRegime } from './render.js';
