import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { atrSeries } from '../../src/analysis/core.js';
import { detectPivots } from '../../src/analysis/pivots.js';
import { analyzeLiquidity } from '../../src/analysis/liquidity.js';
import { modelASpringEvent } from '../../src/analysis/tradeSignalModelA.js';

async function lowFirstEngine() {
  const url = new URL('../../src/analysis/liquidity.js', import.meta.url);
  let source = await readFile(url, 'utf8');
  for (const name of ['core.js', 'pivots.js']) source = source.replace(`'./${name}'`, `'${new URL(name, url).href}'`);
  const highFirst = "(a.type === b.type ? 0 : a.type === 'high' ? -1 : 1)";
  assert.equal(source.split(highFirst).length - 1, 2, 'both pivot-order comparators must be mutated');
  source = source.replaceAll(highFirst, "(a.type === b.type ? 0 : a.type === 'high' ? 1 : -1)");
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).analyzeLiquidity;
}

function replay(candles, highFirst, engine = analyzeLiquidity) {
  const confirmed = [...detectPivots(candles, 3).confirmed].sort((a, b) =>
    a.confirmedIndex - b.confirmedIndex || a.index - b.index ||
    (a.type === b.type ? 0 : (a.type === 'high' ? -1 : 1) * (highFirst ? 1 : -1)));
  const liquidity = engine(candles, { pivots: { confirmed }, atr: atrSeries(candles, 14),
    referenceLevels: [], captureSnapshots: true });
  const poolKey = (pool) => `${pool.side}:${pool.pivotIndices[0]}`;
  const keys = new Map(liquidity.pools.map((pool) => [pool.id, poolKey(pool)]));
  const snapshots = liquidity.poolSnapshots.map((snapshot) => ({
    index: snapshot.index,
    pools: snapshot.pools.map(({ id, ...pool }) => ({ ...pool, key: keys.get(id) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    relativeIds: ['buy', 'sell'].map((side) => snapshot.pools.filter((pool) => pool.side === side)
      .sort((a, b) => a.id - b.id).map((pool) => keys.get(pool.id))),
  }));
  const sweeps = liquidity.events.map(({ id, poolId, ...event }) =>
    ({ ...event, key: keys.get(poolId), hasId: typeof id === 'string' }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const patterns = [];
  for (let index = 20; index + 1 < candles.length; index++) {
    for (const kind of ['spring', 'upthrust']) {
      const event = modelASpringEvent({ candles, candidateIndex: index, kind, liquidity, asOfIndex: candles.length - 1 });
      if (!event) continue;
      patterns.push({ kind, index, level: event.level, poolAttributed: event.poolAttributed,
        pool: keys.get(event.poolId) ?? null, matchCount: event.matchCount,
        attributionAmbiguous: event.attributionAmbiguous, poolSnapshotState: event.poolSnapshotState,
        constituentIndices: event.constituentIndices, sweepEvidence: event.poolSweepEventId !== null,
        candidates: event.attributionCandidates.map((candidate) =>
          ({ ...candidate, poolId: keys.get(candidate.poolId) })).sort((a, b) => a.poolId.localeCompare(b.poolId)),
        diagnostics: event.diagnostics });
    }
  }
  return { liquidity, snapshots, sweeps, patterns };
}

function equalDistanceFixture() {
  const candles = Array.from({ length: 50 }, (_, index) =>
    ({ epoch: index * 60, open: 100.5, high: 100.8, low: 96, close: 100.5 }));
  candles[33] = { ...candles[33], high: 101, low: 95 };
  candles[37] = { ...candles[37], high: 103, close: 101 };
  candles[42] = { ...candles[42], high: 102, low: 94.5, close: 101 };
  return candles;
}

test('real outside candles preserve side-relative IDs and earliest-ID equal-distance winner', async () => {
  const candles = equalDistanceFixture();
  const high = replay(candles, true), low = replay(candles, false, await lowFirstEngine());
  assert.deepEqual(high.snapshots, low.snapshots);
  assert.deepEqual(high.sweeps, low.sweeps);
  assert.deepEqual(high.patterns, low.patterns);
  const before = high.liquidity.poolSnapshots[44].pools.filter((pool) => pool.side === 'buy');
  assert.deepEqual(before.map((pool) => pool.level), [101, 103]);
  assert.ok(Math.abs(102 - 101) <= atrSeries(candles, 14)[45] * 0.25);
  const winner = high.liquidity.poolSnapshots[45].pools.find((pool) => pool.pivotIndices.includes(42) && pool.side === 'buy');
  assert.deepEqual(winner.pivotIndices, [33, 42]);
  assert.equal(winner.id, Math.min(...before.map((pool) => pool.id)));
});

test('real t-star outside pivot processing preserves same-side state when high/low order is reversed', async () => {
  const candles = Array.from({ length: 20 }, (_, index) =>
    ({ epoch: index * 60, open: 101, high: 102, low: 101, close: 101 }));
  candles[3].low = 99;
  candles[10] = { ...candles[10], high: 105, low: 100 };
  candles[13] = { ...candles[13], high: 104, low: 100.5 };
  const high = replay(candles, true), low = replay(candles, false, await lowFirstEngine());
  assert.notDeepEqual(high.liquidity.poolSnapshots[13].pools.map((pool) => [pool.id, pool.side]),
    low.liquidity.poolSnapshots[13].pools.map((pool) => [pool.id, pool.side]));
  assert.deepEqual(high.snapshots, low.snapshots);
  assert.deepEqual(high.sweeps, low.sweeps);
  assert.deepEqual(high.patterns, low.patterns);
});

test('invalid injected pivot states exercise the t-star nearest-pool ID tie-break only', () => {
  const candles = Array.from({ length: 15 }, (_, index) =>
    ({ epoch: index * 60, open: 100.5, high: 100.8, low: 96, close: 100.5 }));
  const pivots = { confirmed: [
    { type: 'high', index: 3, price: 101, confirmedIndex: 6 },
    { type: 'high', index: 7, price: 103, confirmedIndex: 10 },
    { type: 'high', index: 10, price: 102, confirmedIndex: 13 },
    { type: 'low', index: 10, price: 95, confirmedIndex: 13 },
  ] };
  const atr = candles.map((_, index) => index < 13 ? null : 6);
  const result = analyzeLiquidity(candles, { pivots, atr, referenceLevels: [], captureSnapshots: true });
  assert.deepEqual(result.poolSnapshots[12].pools, []);
  const buy = result.poolSnapshots[13].pools.filter((pool) => pool.side === 'buy');
  assert.deepEqual(buy.map((pool) => pool.pivotIndices), [[3, 10], [7]]);
  assert.equal(buy[0].id, Math.min(...buy.map((pool) => pool.id)));
});

test('seeded real-candle replays are invariant to same-bar high/low pivot iteration', async () => {
  const alternate = await lowFirstEngine();
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed;
    const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    let price = 100;
    const candles = Array.from({ length: 85 }, (_, index) => {
      const open = price, close = open + Math.round((random() - 0.5) * 8) / 10;
      const high = Math.max(open, close) + Math.round(random() * 15 + 1) / 10;
      const low = Math.min(open, close) - Math.round(random() * 15 + 1) / 10;
      price = close;
      return { epoch: index * 60, open, high, low, close };
    });
    const high = replay(candles, true), low = replay(candles, false, alternate);
    assert.deepEqual(high.snapshots, low.snapshots, `pool snapshots, seed ${seed}`);
    assert.deepEqual(high.sweeps, low.sweeps, `sweeps, seed ${seed}`);
    assert.deepEqual(high.patterns, low.patterns, `attribution, seed ${seed}`);
  }
});
