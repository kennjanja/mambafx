// Single entry point used by the Candle Charts page: runs the whole engine once per timeframe.
import { analyze } from './engine.js';
import { analyzeZones } from './zones.js';

export function analyzeAll(candles, opts = {}) {
  const base = analyze(candles, opts);
  const z = analyzeZones(base.candles, { ...opts, atr: base.atr, structure: base });
  return { ...base, zones: z.zones };
}
export { renderZones, renderStructure, renderLiquidity, visibleZones } from './render.js';
