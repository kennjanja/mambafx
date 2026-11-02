import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/analysis/engine.js';
import { analyzeZones } from '../../src/analysis/zones.js';
import { analyzePatterns } from '../../src/analysis/patterns.js';
import { analyzeLevels } from '../../src/analysis/levels.js';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { detectInducements } from '../../src/analysis/inducement.js';
import { detectTradingRanges } from '../../src/analysis/tradeSignalArchitecture.js';

const rng = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };
function seededWalk(seed, n = 64) {
  const r = rng(seed); let p = 1000; const candles = [];
  for (let i = 0; i < n; i++) {
    const open = p; p += (r() - 0.5) * 8 + Math.sin(i / 7) * 2;
    candles.push({ epoch: 1_700_000_000 + i * 60, open, high: Math.max(open, p) + r() * 3, low: Math.min(open, p) - r() * 3, close: p });
  }
  return candles;
}
function structuredWave() {
  let p = 1000;
  return Array.from({ length: 100 }, (_, i) => {
    let open = p, close = 1000 + 12 * Math.sin(i * 0.47) + (i > 66 ? (i - 66) * 1.8 : 0);
    let high = Math.max(open, close) + 2 + (i % 7 === 0 ? 8 : 0), low = Math.min(open, close) - 2 - (i % 9 === 0 ? 7 : 0);
    if (i === 70) { open = p; close = p + 30; high = close + 3; low = open - 2; }
    if (i === 75) { open = p; close = p - 22; high = open + 2; low = close - 3; }
    p = close;
    return { epoch: 1_700_000_000 + i * 60, open, high, low, close };
  });
}
function inducementCandles(seed) {
  const close = [];
  for (let i = 0; i < 80; i++) {
    let c = 100 + Math.sin(i * 0.65) * 1.5;
    if (i === 10) c = 90; if (i === 30) c = 110; if (i === 31) c = 108; if (i === 32) c = 107;
    if (i === 33) c = 106; if (i === 34) c = 107; if (i === 35) c = 114; if (i === 36) c = 112;
    if (i === 37) c = 109; if (i === 38) c = 107; if (i === 39) c = 105; if (i === 40) c = 106;
    if (i === 41) c = 108; if (i === 42) c = 105; if (i === 43) c = 114; if (i > 43) c = 114 + Math.sin(i) * 1.5;
    close.push(c);
  }
  return close.map((c, i) => {
    const n = Math.sin((i + seed) * 3.17) * 0.0001;
    let open = i ? close[i - 1] + n : c + n, closeValue = c;
    let high = Math.max(open, closeValue) + 0.4, low = Math.min(open, closeValue) - 0.4;
    if (i === 10) low = 89; if (i === 42) low = 103.8;
    if (i === 46) { open = 104; closeValue = 104.5; high = 105; low = 103; }
    if (i === 47) { open = 104.5; closeValue = 108; high = 110.5; low = 103.9; }
    return { epoch: 1_700_000_000 + i * 60, open, high, low, close: closeValue };
  });
}
const MUTABLE = new Set(['status', 'history', 'failIndex', 'fill', 'testCount', 'firstMitigationIndex', 'lastTouchIndex', 'endIndex', 'breakIndex', 'score', 'reaction', 'reactionDue', 'updatedIndex', 'touches', 'flips', 'role', 'level', 'low', 'high', 'pivotIndices', 'ifvgId', 'breakerId', 'outside', 'stateHistory', 'state', 'invalidationReason', 'invalidatedAt', 'sweepIndex', 'sweepConfirmedAt', 'displacementIndex', 'displacementConfirmedAt']);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !MUTABLE.has(key)).map(([key, item]) => [key, stable(item)]));
}
function confirmedBefore(items, cut) {
  return items.filter((item) => Number.isInteger(item.confirmedIndex ?? item.index) && (item.confirmedIndex ?? item.index) < cut).map(stable);
}
function outputs(candles) {
  const core = analyze(candles), zones = analyzeZones(candles, { atr: core.atr, structure: core });
  const patterns = analyzePatterns(candles), levels = analyzeLevels(candles), evidence = analyzeEvidence(candles);
  const ranges = detectTradingRanges(candles, { atr: core.atr });
  return {
    'structure/BOS-CHoCH': [...core.internal.events, ...core.swing.events],
    'major-minor pivots': [...core.internal.pivots.confirmed, ...core.swing.pivots.confirmed],
    displacement: core.displacement,
    'OB-FVG zones': zones.zones,
    'liquidity-sweep events': core.liquidity.events,
    'inducement lifecycle': detectInducements(candles, { structure: core }),
    'range-SOS-LPS events': ranges.events,
    'pattern events': [...patterns.candle, ...patterns.chart, ...patterns.wyckoff],
    'level detectors': [...levels.sr, ...levels.supplyDemand, ...levels.trendlines],
  };
}
function compareInducements(prefix, full, cut, context) {
  const project = (events) => events.filter((event) => event.minorPivot.confirmedIndex < cut).map((event) => {
    const history = event.stateHistory.filter((item) => item.index < cut);
    return { id: event.id, direction: event.direction, level: event.level, bos: stable(event.bos), impulse: stable(event.impulse),
      minorPivot: stable(event.minorPivot), protectedPivot: stable(event.protectedPivot),
      stateAtCut: history.at(-1)?.state ?? null, history: stable(history) };
  });
  assert.deepEqual(project(prefix), project(full), context);
}
const labels = ['structure/BOS-CHoCH', 'major-minor pivots', 'displacement', 'OB-FVG zones', 'liquidity-sweep events',
  'range-SOS-LPS events', 'pattern events', 'level detectors'];
const counts = Object.fromEntries(labels.map((label) => [label, { seeds: 0, detectedSeeds: 0, structured: 0, cutPoints: 0, comparisons: 0 }]));
const inducementCount = { seeds: 50, detectedSeeds: 0, structured: 1, cutPoints: 0, comparisons: 0 };

function checkSeries(candles, context, isStructured = false, seed = null) {
  assert.equal(analyze(candles).dropped, 0, `${context} fixture must contain only valid OHLC candles`);
  const full = outputs(candles);
  for (const label of labels) {
    const row = counts[label];
    if (seed != null) row.seeds++;
    if (seed != null && full[label].length) row.detectedSeeds++;
    if (isStructured && full[label].length) row.structured++;
  }
  if (context.startsWith('inducement-seed=') && detectInducements(candles, { structure: analyze(candles) }).length) inducementCount.detectedSeeds++;
  const fullInducements = detectInducements(candles, { structure: analyze(candles) });
  for (let cut = 1; cut < candles.length; cut++) {
    const prefix = outputs(candles.slice(0, cut));
    for (const label of labels) {
      const comparable = (items) => label === 'pattern events'
        ? items.filter((item) => !Array.isArray(item.pivots) || Number.isInteger(item.breakIndex)) : items;
      assert.deepEqual(confirmedBefore(comparable(prefix[label]), cut), confirmedBefore(comparable(full[label]), cut), `${context} ${label} cut=${cut}`);
      counts[label].cutPoints++; counts[label].comparisons++;
    }
    compareInducements(detectInducements(candles.slice(0, cut)), fullInducements, cut, `${context} inducement cut=${cut}`);
    inducementCount.cutPoints++; inducementCount.comparisons++;
  }
}

test('component truncation matrix: 50 seeded series and structured detector fixtures', () => {
  for (let seed = 1; seed <= 50; seed++) checkSeries(seededWalk(seed), `seed=${seed}`, false, seed);
  checkSeries(structuredWave(), 'structured-wave', true);
  const neutralBreakout = analyzePatterns(seededWalk(11)).chart.find((pattern) => pattern.kind === 'channel' && Number.isInteger(pattern.breakIndex));
  assert.ok(neutralBreakout, 'seeded series must produce a neutral channel breakout');
  assert.equal(neutralBreakout.confirmedIndex, neutralBreakout.breakIndex, 'pattern confirmation timestamp equals breakout close');
  for (let seed = 1; seed <= 50; seed++) checkSeries(inducementCandles(seed), `inducement-seed=${seed}`);
  for (const [label, row] of Object.entries(counts)) {
    assert.equal(row.seeds, 50, `${label}: 50 deterministic seeds executed`);
    assert.ok(row.detectedSeeds > 0, `${label}: seeded fixtures must exercise a detection`);
    assert.ok(row.structured > 0, `${label}: structured fixture must produce its intended pattern`);
  }
  assert.ok(inducementCount.detectedSeeds > 0, 'inducement seeds must produce detector outputs');
  assert.ok(inducementCount.comparisons > 0);
  console.log('COMPONENT_TRUNCATION_COUNTS ' + JSON.stringify({ ...counts, 'inducement lifecycle': inducementCount }));
});
