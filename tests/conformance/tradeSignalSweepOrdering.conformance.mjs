import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { atrSeries } from '../../src/analysis/core.js';
import { detectPivots } from '../../src/analysis/pivots.js';
import { analyzeLiquidity } from '../../src/analysis/liquidity.js';

function candlesForOrdering() {
  const candles = Array.from({ length: 72 }, (_, i) =>
    ({ epoch: i * 60, open: 101, high: 102, low: 101, close: 101 }));
  for (const i of [50, 56]) candles[i].low = 100;
  candles[40].low = 97;
  candles[66].low = 99.9;
  candles[67] = { ...candles[67], open: 100, low: 100, close: 100 };
  candles[69].low = 99.95;
  return candles;
}

async function scratchEngine({ wrongOrder = false, reversePools = false } = {}) {
  const url = new URL('../../src/analysis/liquidity.js', import.meta.url);
  let source = await readFile(url, 'utf8');
  for (const name of ['core.js', 'pivots.js']) {
    source = source.replace(`'./${name}'`, `'${new URL(name, url).href}'`);
  }
  if (wrongOrder) {
    const poolStart = source.indexOf('    for (const pool of pools) {');
    const pivotStart = source.indexOf('    const confirmedNow = ', poolStart);
    const refsStart = source.indexOf('    for (const r of refAt.get(i) || []) {', pivotStart);
    assert.ok(poolStart >= 0 && pivotStart > poolStart && refsStart > pivotStart, 'scratch mutation anchors');
    source = source.slice(0, poolStart) + source.slice(pivotStart, refsStart)
      + source.slice(poolStart, pivotStart) + source.slice(refsStart);
  }
  if (reversePools) {
    assert.ok(source.includes('for (const pool of pools)') && source.includes('pools.filter(q =>'));
    source = source.replace('for (const pool of pools)', 'for (const pool of [...pools].reverse())')
      .replace('pools.filter(q =>', '[...pools].reverse().filter(q =>');
  }
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).analyzeLiquidity;
}

function checkOrdering(engine, reversePivots = false) {
  const candles = candlesForOrdering();
  const atr = atrSeries(candles, 14);
  const detected = detectPivots(candles, 3).confirmed;
  const pivot = detected.find((p) => p.type === 'low' && p.index === 66);
  assert.equal(pivot?.confirmedIndex, 69);
  assert.equal(pivot.price, 99.9);
  assert.ok(Number.isFinite(atr[69]));
  assert.ok(Math.abs(100 - pivot.price) <= 0.25 * atr[69], 'pivot is within the frozen clustering tolerance');
  const pivots = reversePivots ? [...detected].reverse() : detected;
  const result = engine(candles, { pivots: { confirmed: pivots }, atr, referenceLevels: [], captureSnapshots: true });
  const previous = result.poolSnapshots[68].pools.find((pool) => pool.side === 'sell' && pool.level === 100);
  assert.ok(previous && previous.status === 'active' && previous.pending === null);
  const swept = result.poolSnapshots[69].pools.find((pool) => pool.id === previous.id);
  assert.equal(swept.level, 100);
  assert.equal(swept.pending?.index, 69);
  assert.deepEqual(swept.pivotIndices, [50, 56]);
  const assigned = result.poolSnapshots[69].pools.find((pool) => pool.pivotIndices.includes(66));
  assert.ok(assigned && assigned.id !== swept.id);
  const event = result.events.find((e) => e.kind === 'sweep-confirmed' && e.poolId === swept.id && e.index === 69);
  assert.ok(event);
  assert.equal(event.level, 100);
  assert.equal(event.confirmedIndex, 70);
  return { previous, swept, assigned, eventId: event.id };
}

test('real candles evaluate a sweep before assigning the confirming pivot', async () => {
  const engine = process.env.MODEL_A_WRONG_ORDER === '1' ? await scratchEngine({ wrongOrder: true }) : analyzeLiquidity;
  checkOrdering(engine);
});

test('real-candle ordering result is invariant to reversed pivot and pool iteration', async () => {
  const normal = checkOrdering(analyzeLiquidity);
  const reversed = checkOrdering(await scratchEngine({ reversePools: true }), true);
  assert.deepEqual(reversed, normal);
});
