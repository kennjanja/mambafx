import { analyze } from './engine.js';
import { analyzeZones } from './zones.js?v=fvg2';
import { analyzePatterns } from './patterns.js';
import { analyzeLevels } from './levels.js';
export { analyzeEvidence } from './evidence.js?v=integrity1';
export { buildTradeSignal, TRADE_SIGNAL_TFS } from './tradeSignal.js?v=integrity1';

export function analyzeAll(candles, opts = {}) {
  const base = analyze(candles, opts);
  const z = analyzeZones(base.candles, { ...opts, atr: base.atr, structure: base });
  return { ...base, zones: z.zones, fvgCorrections: z.fvgCorrections, fvgPositions: z.fvgPositions };
}
export function analyzeLv(candles, opts = {}) { return analyzeLevels(candles, opts); }
export function analyzePat(candles, opts = {}) { return analyzePatterns(candles, opts); }
export { renderZones, renderStructure, renderLiquidity, visibleZones, renderCandlePatterns, renderChartPatterns, renderWyckoff, renderRegime, renderLevels } from './render.js?v=fvg2';
