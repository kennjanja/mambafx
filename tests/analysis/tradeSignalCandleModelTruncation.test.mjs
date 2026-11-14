import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence } from '../../src/analysis/evidence.js';
import { evaluateEntryModels } from '../../src/analysis/tradeSignalArchitecture.js';
import { eligibleFvgs } from '../../src/analysis/fvgQualification.js';
import { analyzeZones } from '../../src/analysis/zones.js';
import { analyze } from '../../src/analysis/engine.js';

const BASE_EPOCH = 1_700_000_000;
function seededWalk(seed, length = 180, granularity = 60) {
  let state = seed >>> 0;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  let price = 100;
  return Array.from({ length }, (_, index) => {
    const open = price;
    price += (random() - 0.5) * 2 + Math.sin(index / 11) * 0.8 + ((seed % 5) - 2) * 0.15;
    return { epoch: BASE_EPOCH + index * granularity, open, high: Math.max(open, price) + random() * 0.6,
      low: Math.min(open, price) - random() * 0.6, close: price };
  });
}
function fvgContinuationSequence() {
  const candles = Array.from({ length: 64 }, (_, i) => ({ epoch: BASE_EPOCH + i * 60, open: 100, high: 100.3, low: 99.7, close: 100 }));
  candles[30] = { ...candles[30], high: 101.5, close: 100.7 };
  candles[52] = { ...candles[52], open: 100, close: 104, high: 104.2, low: 99.8 };
  candles[53] = { ...candles[53], open: 104, close: 104.6, high: 104.9, low: 103.9 };
  candles[54] = { ...candles[54], open: 104.6, close: 105.8, high: 105.8, low: 104.4 };
  candles[55] = { ...candles[55], open: 105.8, close: 107.2, high: 107.3, low: 105.8 };
  candles[56] = { ...candles[56], open: 106.7, close: 107.9, high: 108.1, low: 106.7 };
  candles[57] = { ...candles[57], open: 106.7, close: 106.5, high: 106.8, low: 106.2 };
  candles[58] = { ...candles[58], open: 106.5, close: 106.55, high: 107.5, low: 106.2 };
  for (let i = 59; i < 64; i++) candles[i] = { ...candles[i], open: 107.3, close: 107.3 + (i % 2 ? 0.02 : -0.02), high: 107.55, low: 107.05 };
  candles[60] = { ...candles[60], open: 107.4, close: 107.2, high: 107.5, low: 107.0 };
  candles[61] = { ...candles[61], open: 107.1, close: 107.6, high: 107.8, low: 107.0 };
  return candles;
}
function inducementSequence() {
  const source = Array.from({ length: 65 }, (_, i) => ({ epoch: BASE_EPOCH + i * 60, open: 100, high: 100.3, low: 99.7, close: 100 }));
  source[10] = { ...source[10], low: 95 };
  source[30] = { ...source[30], high: 104, close: 101 };
  source[40] = { ...source[40], open: 101, close: 105, high: 105.3, low: 100.8 };
  for (let i = 43; i <= 46; i++) source[i] = { ...source[i], open: 103, close: 102.5, high: 103.5, low: 102 };
  source[47] = { ...source[47], open: 102.5, close: 102, high: 103, low: 101 };
  source[48] = { ...source[48], open: 102, close: 102.6, high: 103, low: 101.8 };
  source[49] = { ...source[49], open: 102.6, close: 102.8, high: 103.1, low: 102.1 };
  source[50] = { ...source[50], open: 102.8, close: 102.2, high: 103, low: 100.5 };
  source[51] = { ...source[51], open: 102.2, close: 106, high: 106.2, low: 101.9 };
  const offset = 12;
  const candles = Array.from({ length: source.length + offset }, (_, i) => ({ epoch: BASE_EPOCH + i * 60, open: 100, high: 100.3, low: 99.7, close: 100 }));
  source.forEach((bar, index) => { candles[index + offset] = { ...bar, epoch: BASE_EPOCH + (index + offset) * 60 }; });
  for (let i = 64 + offset; i < candles.length; i++) candles[i] = { ...candles[i], open: 106.2, close: 106.2, high: 106.5, low: 106.0 };
  return candles;
}
const MODEL_SEEDS = Object.freeze({ A: 90, B: 136, C: null, D: 67, F: null, G: 11, J: 224 });
const MODEL_IDS = Object.keys(MODEL_SEEDS);

function translate(candles, seed) {
  const shift = seed * 0.00001;
  return candles.map((bar) => ({ epoch: bar.epoch,
    open: bar.open + shift, high: bar.high + shift, low: bar.low + shift, close: bar.close + shift }));
}

function evaluateEvidence(evidence, candles, asOf = candles.length - 1, overrides = {}) {
  const bars = candles.slice(0, asOf + 1);
  const direction = evidence.verdict === 'bullish-lean' ? 1 : evidence.verdict === 'bearish-lean' ? -1 : 0;
  const locations = [{ dir: direction, top: Math.max(...bars.map((bar) => bar.high)), bottom: Math.min(...bars.map((bar) => bar.low)) }];
  const base = analyze(evidence.candles);
  const state = analyzeZones(base.candles, { atr: base.atr, structure: base });
  const result = evaluateEntryModels({ events: evidence.facts.modelEvents, biasDirection: direction,
    entryDirection: evidence.facts.swingBias, locations, marketContext: ['trend', 'range'], asOfIndex: asOf,
    fvgs: eligibleFvgs(state.zones, state.fvgCorrections, state.fvgPositions, asOf), ...overrides });
  return { evidence, direction, locations, result };
}
function derive(candles, asOf = candles.length - 1, overrides = {}) {
  const evidence = analyzeEvidence(candles.slice(0, asOf + 1), { granularity: 60 });
  return evaluateEvidence(evidence, candles, asOf, overrides);
}
function eventProjection(evidence, cut) {
  return evidence.facts.modelEvents.filter((event) => event.type !== 'trend-established' && event.confirmedIndex < cut).map((event) => ({
    type: event.type, dir: event.dir, index: event.index, confirmedIndex: event.confirmedIndex, level: event.level,
    classification: event.classification, context: event.context, rangeId: event.rangeId, state: event.state,
    sequenceEvents: event.sequenceEvents?.map((part) => ({ type: part.type, dir: part.dir, index: part.index,
      confirmedIndex: part.confirmedIndex, classification: part.classification, level: part.level })),
  }));
}
const counts = Object.fromEntries(MODEL_IDS.map((id) => [id, { seeds: 0, qualifiedSeeds: 0, positiveFixtures: 0,
  negativeFixtures: 0, cutPoints: 0, comparisons: 0, failures: 0 }]));

function positiveBase(id) {
  if (id === 'F') return inducementSequence();
  if (id === 'C') return fvgContinuationSequence();
  return seededWalk(MODEL_SEEDS[id]);
}
function rotatePattern(candles) {
  const prices = [...candles].reverse();
  return prices.map((bar, index) => ({ ...bar, epoch: BASE_EPOCH + index * 60 }));
}

test('candle-rebuilt truncation is causal for every registered model', { timeout: 600_000 }, () => {
  const bases = Object.fromEntries(MODEL_IDS.map((id) => [id, positiveBase(id)]));
  const fullRuns = Object.fromEntries(MODEL_IDS.map((id) => [id, derive(bases[id])]));
  for (const id of MODEL_IDS) {
    const row = counts[id];
    assert.ok(fullRuns[id].result.candidates.some((candidate) => candidate.model_id === id), `${id} structured candle fixture must qualify from detector evidence`);
    row.positiveFixtures++;
    for (let seed = 1; seed <= 50; seed++) {
      const run = derive(translate(bases[id], seed));
      row.seeds++;
      if (run.result.candidates.some((candidate) => candidate.model_id === id)) row.qualifiedSeeds++;
      assert.ok(run.result.candidates.some((candidate) => candidate.model_id === id), `${id} deterministic seed ${seed} must produce actual candle-derived qualification`);
    }

    const candles = bases[id];
    const full = fullRuns[id].evidence;
    for (let cut = 60; cut < candles.length; cut++) {
      const prefix = derive(candles.slice(0, cut));
      const fullAsOf = evaluateEvidence(full, candles, cut - 1, { biasDirection: prefix.direction, entryDirection: prefix.evidence.facts.swingBias, locations: prefix.locations });
      assert.deepEqual(eventProjection(full, cut), eventProjection(prefix.evidence, cut), `${id} detector events at candle cut ${cut}`);
      assert.deepEqual(fullAsOf.result, prefix.result, `${id} later confirmation cannot qualify at cut ${cut}`);
      row.cutPoints++;
      row.comparisons += 2;
    }

    const source = fullRuns[id], dir = source.direction;
    const negativeCases = [
      ['missing-event-before-sequence-completes', () => {
        const firstQualified = Array.from({ length: candles.length - 59 }, (_, i) => i + 60)
          .find((length) => derive(candles.slice(0, length)).result.candidates.some((candidate) => candidate.model_id === id));
        assert.ok(firstQualified > 60, `${id} fixture must include an unqualified prefix`);
        return derive(candles.slice(0, firstQualified - 1));
      }],
      ['wrong-direction', () => derive(candles, candles.length - 1, { biasDirection: -dir })],
      ['invalid-context', () => id === 'A'
        ? (() => { const evidence = analyzeEvidence(candles, { granularity: 60 }); const changed = evidence.facts.modelEvents.map((event) => event.type === 'significant-sweep' ? { ...event, context: 'unsupported-context' } : event); const run = derive(candles); const result = evaluateEntryModels({ events: changed, biasDirection: run.direction, entryDirection: evidence.facts.swingBias, locations: run.locations, marketContext: 'unsupported-context', asOfIndex: candles.length - 1 }); return { result }; })()
        : derive(candles, candles.length - 1, { marketContext: 'unsupported-context' })],
      ['location-gate-failure', () => derive(candles, candles.length - 1, { locations: [] })],
      ['out-of-order-candle-sequence', () => derive(rotatePattern(candles))],
    ];
    for (const [name, runNegative] of negativeCases) {
      const negative = runNegative();
      assert.equal(negative.result.candidates.some((candidate) => candidate.model_id === id), false, `${id} negative fixture ${name}`);
      row.negativeFixtures++;
    }
  }
  assert.ok(fullRuns.F.result.candidates.some((candidate) => candidate.model_id === 'F' && candidate.confirmingEvents.length === 3));
  assert.equal(fullRuns.F.result.candidates.some((candidate) => candidate.model_id === 'A'), false, 'minor inducement continuation does not become Model A');
  assert.ok(fullRuns.A.result.candidates.some((candidate) => candidate.model_id === 'A' && candidate.classification === 'reversal'));
  assert.ok(fullRuns.B.result.candidates.some((candidate) => candidate.model_id === 'B'));
  assert.ok(fullRuns.G.result.candidates.some((candidate) => candidate.model_id === 'G'));
  for (const [id, row] of Object.entries(counts)) {
    assert.equal(row.seeds, 50, `${id}: 50 deterministic seeded candle variants`);
    assert.equal(row.qualifiedSeeds, 50, `${id}: nonzero actual candle-derived model qualifications`);
    assert.equal(row.positiveFixtures, 1);
    assert.equal(row.negativeFixtures, 5);
    assert.ok(row.cutPoints > 0);
    assert.ok(row.comparisons >= row.cutPoints * 2);
    assert.equal(row.failures, 0);
  }
  console.log('TRADE_SIGNAL_MODEL_TRUNCATION_COUNTS ' + JSON.stringify(counts));
});
