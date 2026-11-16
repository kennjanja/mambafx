import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCandles, attachZoneContext, computeModifiedSr, periodEnd, periodStart, SR_GROUPS } from '../../src/analysis/modifiedSr.js';
import { analyzeAll } from '../../src/analysis/all.js';

const frames = SR_GROUPS.flatMap(g => g.frames);
const now = Date.UTC(2026, 10, 15) / 1000;
function candles(g, offset = 0, count = 20) {
  const kind = g === 2592000 ? 'month' : g === 604800 ? 'week' : g;
  const end = periodStart(now, kind);
  return Array.from({ length: count }, (_, i) => {
    const epoch = kind === 'month'
      ? Date.UTC(2026, 10 - count + i, 1) / 1000
      : end - (count - i) * g;
    return { epoch, open: 100, close: 100, high: i % 5 === 2 ? 110 + offset : 105, low: i % 5 === 2 ? 90 - offset : 95 };
  });
}
function data() { return Object.fromEntries(frames.map(g => [g, candles(g)])); }

test('all 15 frames create Sure support and resistance without duplicate group labels', () => {
  const result = computeModifiedSr(data(), now, 100);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.support.map(x => x.label), ['Sure TFSR']);
  assert.deepEqual(result.resistance.map(x => x.label), ['Sure TFSR']);
  assert.equal(result.support[0].price, 90);
  assert.equal(result.resistance[0].price, 110);
});

test('confirmed support and resistance confluences survive price crossing either level', () => {
  const input = data();
  const initial = computeModifiedSr(input, now, 100);
  for (const price of [80, 90, 110, 120]) {
    const crossed = computeModifiedSr(input, now, price);
    assert.deepEqual(crossed.support, initial.support);
    assert.deepEqual(crossed.resistance, initial.resistance);
  }
});

test('a missing frame blocks its group and Sure, but not other groups', () => {
  const input = data(); input[2700] = [];
  const result = computeModifiedSr(input, now, 100);
  assert.deepEqual(result.missing, [2700]);
  assert.deepEqual(result.support.map(x => x.label), ['Low TFSR', 'High TFSR', 'Ultra TFSR']);
  assert.deepEqual(result.resistance.map(x => x.label), ['Low TFSR', 'High TFSR', 'Ultra TFSR']);
});

test('a group needs all frames and the entire spread must fit its smallest-frame ATR tolerance', () => {
  const input = data();
  input[300] = candles(300, 10);
  const result = computeModifiedSr(input, now, 100);
  assert.ok(!result.support.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
  assert.ok(!result.resistance.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
  assert.ok(result.support.some(x => x.label === 'Medium TFSR'));
});

test('a chain of individually close pivots cannot bridge a wider spread', () => {
  const input = data();
  input[180] = candles(180, 2);
  input[300] = candles(300, 4);
  const result = computeModifiedSr(input, now, 100);
  assert.ok(!result.support.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
});

test('closed monthly swings can contribute with less than 14 months of history', () => {
  const input = data(); input[2592000] = candles(2592000, 0, 8);
  const result = computeModifiedSr(input, now, 100);
  assert.ok(result.support.some(x => x.label === 'Sure TFSR'));
});

test('forming candles cannot create a confirmed swing', () => {
  const input = data();
  input[30] = candles(30, 0, 4);
  input[30].push({ epoch: periodStart(now, 30), open: 100, close: 100, high: 105, low: 95 });
  const result = computeModifiedSr(input, now, 100);
  assert.ok(result.missing.includes(30));
  assert.ok(!result.support.some(x => x.label === 'Low TFSR' || x.label === 'Sure TFSR'));
});

test('UTC week and month boundaries include leap days', () => {
  const date = Date.UTC(2024, 1, 29, 12) / 1000;
  assert.equal(periodStart(date, 'week'), Date.UTC(2024, 1, 26) / 1000);
  assert.equal(periodEnd(date, 'week'), Date.UTC(2024, 2, 4) / 1000);
  assert.equal(periodStart(date, 'month'), Date.UTC(2024, 1, 1) / 1000);
  assert.equal(periodEnd(date, 'month'), Date.UTC(2024, 2, 1) / 1000);
});

test('aggregation drops incomplete and gapped closed buckets, but retains complete and current buckets', () => {
  const source = Array.from({ length: 10 }, (_, i) => ({ epoch: i * 900, open: i, high: i + 1, low: i, close: i + 1 }));
  const result = aggregateCandles(source.filter(c => c.epoch !== 3600), 900, 2700, 8100, { includeForming: true });
  assert.deepEqual(result.map(c => c.epoch), [0, 5400, 8100]);
  assert.deepEqual(result[0], { epoch: 0, open: 0, high: 3, low: 0, close: 3 });
  assert.deepEqual(aggregateCandles(source.slice(1, 3), 900, 2700, 2700), []);
});

test('historical aggregation ignores future and forming source candles', () => {
  const source = Array.from({ length: 10 }, (_, i) => ({ epoch: i * 900, open: i, high: i + 1, low: i, close: i + 1 }));
  for (const at of [2700, 3600, 4500, 5400, 6300]) {
    const closed = source.filter(c => c.epoch + 900 <= at);
    assert.deepEqual(aggregateCandles(source, 900, 2700, at), aggregateCandles(closed, 900, 2700, at));
  }
  const live = aggregateCandles(source, 900, 2700, 3600, { includeForming: true });
  assert.equal(live.at(-1).close, 5);
  assert.ok(live.every(c => c.epoch <= 3600));
});

test('confluence retains pivot origins and closed-candle confirmation timestamps', () => {
  const result = computeModifiedSr(data(), now, 100);
  for (const line of [...result.support, ...result.resistance]) {
    assert.equal(line.evidence.length, 15);
    assert.equal(line.evidenceConfirmedAt, Math.max(...line.evidence.map(e => e.confirmedAt)));
    assert.equal(line.low, Math.min(...line.evidence.map(e => e.price)));
    assert.equal(line.high, Math.max(...line.evidence.map(e => e.price)));
    assert.equal(line.rank.timeframeCoverage, 15);
    assert.deepEqual(line.evidence.map(e => e.timeframe), frames);
    for (const e of line.evidence) {
      assert.ok(e.confirmedAt > e.pivotEpoch);
      assert.ok(e.confirmedAt <= now);
      assert.equal(e.type, line.price < 100 ? 'low' : 'high');
    }
  }
});

test('zone context retains direction, lifecycle and closed-candle provenance without changing confluence', () => {
  const result = computeModifiedSr(data(), now, 100);
  const input = {
    candles: [{ epoch: 0 }, { epoch: 30 }, { epoch: 60 }],
    zones: [
      { kind: 'OB', dir: 1, status: 'mitigated', bottom: 89, top: 91, createdIndex: 0, confirmedIndex: 1, fill: 0.5, testCount: 1 },
      { kind: 'FVG', dir: -1, status: 'active', bottom: 89, top: 91, createdIndex: 0, confirmedIndex: 1 },
      { kind: 'FVG', dir: 1, status: 'invalidated', bottom: 89, top: 91, createdIndex: 0, confirmedIndex: 1 },
      { kind: 'OB', dir: 1, status: 'candidate', bottom: 89, top: 91, createdIndex: 0, confirmedIndex: null },
      { kind: 'FVG', dir: 1, status: 'active', bottom: 120, top: 121, createdIndex: 0, confirmedIndex: 1 },
    ],
  };
  const enriched = attachZoneContext(result, { 30: input });
  assert.equal(enriched.support[0].context.length, 1);
  assert.deepEqual(enriched.support[0].context[0], {
    id: '30:OB:0:1:89:91', family: 'order-block', timeframe: 30, kind: 'OB', status: 'mitigated',
    dir: 1, bottom: 89, top: 91, originEpoch: 0, confirmedAt: 60, fill: 0.5, testCount: 1,
  });
  assert.deepEqual(enriched.resistance[0].context, []);
  assert.equal(enriched.support[0].price, result.support[0].price);
  assert.equal(enriched.support[0].label, result.support[0].label);
  assert.equal(enriched.support[0].rank.independentFamilyCount, undefined);
  assert.equal(result.support[0].context, undefined);
});

test('context integrates shared analysis families without converting liquidity targets into S/R evidence', () => {
  const candles = Array.from({ length: 4 }, (_, i) => ({ epoch: i * 60, low: 99, high: 101, close: 100 }));
  const result = { support: [{ id: 's', price: 100, low: 100, high: 100, tolerance: 1, evidenceConfirmedAt: 120, evidence: [{ timeframe: 60 }] }], resistance: [] };
  const bundle = {
    engine: {
      candles,
      zones: [
        { id: 1, kind: 'OB', dir: 1, status: 'active', bottom: 99, top: 101, createdIndex: 0, confirmedIndex: 1 },
        { id: 2, kind: 'OB', dir: 1, status: 'active', bottom: 99, top: 101, createdIndex: 0, confirmedIndex: 1 },
      ],
      liquidity: {
        pools: [{ source: 'pivot', side: 'sell', level: 100, status: 'active', formedIndex: 1, equal: true, touches: 2 }],
        events: [{ kind: 'sweep-confirmed', side: 'sell', level: 100, index: 1, confirmedIndex: 2 }],
      },
      swing: { events: [{ type: 'CHoCH', dir: 1, level: 100, index: 2, pivotIndex: 1, confirmedIndex: 2 }] },
    },
    levels: {
      candles,
      supplyDemand: [{ id: 'sd', kind: 'DEMAND', dir: 1, status: 'active', bottom: 99, top: 101, createdIndex: 0, confirmedIndex: 1 }],
      trendlines: [{ id: 'tl', kind: 'support-line', status: 'active', confirmedIndex: 1, p1: { index: 0, price: 100 }, slope: 0, touches: 3 }],
    },
    patterns: {
      candles,
      chart: [{ id: 'double-bottom', kind: 'double-bottom', status: 'confirmed', dir: 1, confirmedIndex: 2, pivots: [{ type: 'low', index: 0, price: 100 }] }],
      candle: [{ kind: 'pin-bar', dir: 1, index: 2, confirmedIndex: 2 }],
    },
  };
  const once = attachZoneContext(result, { 60: bundle });
  const twice = attachZoneContext(result, { 60: bundle });
  assert.deepEqual(once, twice);
  assert.deepEqual(once.support[0].context.map(e => e.family).sort(), [
    'candle-rejection', 'chart-pattern', 'liquidity-reference', 'liquidity-response',
    'market-structure', 'order-block', 'supply-demand', 'trendline',
  ]);
  assert.equal(new Set(once.support[0].context.map(e => e.id)).size, once.support[0].context.length);
  assert.equal(once.support[0].rank.latestEvidenceAt, 180);
  assert.equal(once.support[0].rank.independentFamilyCount, undefined);
});

test('role-flipped pivot zones and ICT/proxy references remain context, not independent S/R levels', () => {
  const candles = Array.from({ length: 3 }, (_, i) => ({ epoch: i * 60, low: 99, high: 101, close: 100 }));
  const result = { support: [{ price: 100, low: 100, high: 100, tolerance: 0.25, evidenceConfirmedAt: 60, evidence: [{ timeframe: 60 }] }], resistance: [] };
  const bundle = {
    engine: { candles, zones: [], liquidity: { pools: [], events: [] } },
    levels: {
      candles,
      sr: [{ id: 'sr-1', role: 'support', status: 'active', low: 99.8, high: 100.2, createdIndex: 0, confirmedIndex: 1, updatedIndex: 2, touches: 3, flips: 1, history: [{ status: 'flip-to-support', index: 2 }] }],
      supplyDemand: [], trendlines: [],
      premiumDiscount: { q25: 98, eq: 100, q75: 102, confirmedIndex: 1 },
      fib: { levels: [{ ratio: 0.5, price: 100 }], ote: { low: 99, high: 101, price: 100 }, confirmedIndex: 2 },
      opens: [{}, {}, { dayOpen: 99, weekOpen: 100, pivots: { pp: 100.2 } }],
      profile: { poc: 100, val: 99, vah: 101 },
      emas: { 20: [null, null, 100] },
    },
    patterns: { candles, chart: [], candle: [] },
  };
  const enriched = attachZoneContext(result, { 60: bundle }).support[0];
  const sr = enriched.context.find(e => e.family === 'horizontal-sr');
  assert.equal(sr.flips, 1);
  assert.equal(sr.history[0].status, 'flip-to-support');
  assert.equal(sr.updatedAt, 180);
  assert.ok(enriched.context.some(e => e.kind === 'equilibrium'));
  assert.ok(enriched.context.some(e => e.kind === 'OTE reference'));
  assert.ok(enriched.context.some(e => e.kind === 'previous-period pp'));
  assert.ok(enriched.context.some(e => e.kind === 'time-at-price POC proxy' && e.proxy));
  assert.equal(enriched.rank.timeframeCoverage, 1);
});

test('descriptive recency ranking ignores non-directional reference context', () => {
  const candles = Array.from({ length: 4 }, (_, i) => ({ epoch: i * 60, low: 99, high: 101, close: 100 }));
  const result = { support: [{ price: 100, low: 100, high: 100, tolerance: 0.25, evidenceConfirmedAt: 60, evidence: [{ timeframe: 60 }] }], resistance: [] };
  const bundle = {
    engine: { candles, zones: [], liquidity: { pools: [], events: [] } },
    levels: {
      candles, supplyDemand: [], trendlines: [],
      premiumDiscount: { q25: 98, eq: 100, q75: 102, confirmedIndex: 2 },
      fib: { levels: [{ ratio: 0.5, price: 100 }], confirmedIndex: 3 },
      opens: [{}, {}, {}, { dayOpen: 100 }],
      profile: { poc: 100, val: 99, vah: 101 },
      emas: { 20: [null, null, null, 100] },
    },
    patterns: { candles, chart: [], candle: [] },
  };
  const enriched = attachZoneContext(result, { 60: bundle }).support[0];
  assert.ok(enriched.context.length > 0);
  assert.equal(enriched.rank.latestEvidenceAt, 60);
});

test('zone context uses actual shared FVG analysis and updates its lifecycle', () => {
  const mk = (i, o, h, l, c) => ({ epoch: i * 60, open: o, high: h, low: l, close: c });
  const base = [
    ...Array.from({ length: 20 }, (_, i) => mk(i, 100, 100.5, 99.5, 100)),
    mk(20, 100, 100.5, 99.6, 100.3), mk(21, 100.3, 103, 100.2, 102.8),
    mk(22, 102.8, 103.5, 101.5, 103.2),
  ];
  const result = { support: [{ price: 101, tolerance: 0.1, evidence: [{ timeframe: 60 }] }], resistance: [] };
  const attach = c => attachZoneContext(result, { 60: analyzeAll(c) }).support[0].context.find(z => z.kind === 'FVG');
  assert.equal(attach(base).status, 'active');
  assert.equal(attach(base).confirmedAt, 23 * 60);
  assert.equal(attach([...base, mk(23, 103.2, 103.3, 101, 101.8)]).status, 'partial');
  assert.equal(attach([...base, mk(23, 100.8, 100.9, 99.8, 100)]), undefined);
});

test('as-of confluence matches data truncated to closed candles across timeframes', () => {
  const input = data();
  for (const at of [now - 180, now - 60, now, now + 60]) {
    const truncated = Object.fromEntries(frames.map(g => {
      const kind = g === 2592000 ? 'month' : g === 604800 ? 'week' : g;
      return [g, input[g].filter(c => periodEnd(c.epoch, kind) <= at)];
    }));
    assert.deepEqual(computeModifiedSr(input, at, 100), computeModifiedSr(truncated, at, 100));
  }
});
