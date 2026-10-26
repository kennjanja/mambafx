import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, sanitize, atrSeries, detectPivots, detectDisplacement, detectStructure, analyzeLiquidity, referenceLevels, dayId, weekId } from '../../src/analysis/engine.js';

const T0 = 19676 * 86400; // UTC midnight
const mk = (i, o, h, l, c, step = 60) => ({ epoch: T0 + i * step, open: o, high: h, low: l, close: c });
// candle from a mid price with fixed half-range
const bar = (i, mid, hr = 1, step = 60) => mk(i, mid, mid + hr, mid - hr, mid, step);
function series(mids, hr = 1, step = 60) { return mids.map((m, i) => bar(i, m, hr, step)); }
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function walk(n, seed, vol = 1, step = 60) {
  const r = rng(seed); let p = 1000; const out = [];
  for (let i = 0; i < n; i++) {
    const o = p, c = o + (r() - 0.5) * 6 * vol;
    out.push(mk(i, o, Math.max(o, c) + r() * 2 * vol, Math.min(o, c) - r() * 2 * vol, c, step)); p = c;
  }
  return out;
}

test('sanitize drops invalid, unsorted and duplicate candles; handles non-arrays', () => {
  const good = bar(0, 10);
  const r = sanitize([good, null, { ...bar(1, 10), high: NaN }, { ...bar(2, 10), high: 5 }, bar(0, 10), bar(3, 10)]);
  assert.equal(r.candles.length, 2); assert.equal(r.dropped, 4);
  assert.deepEqual(sanitize(undefined), { candles: [], dropped: 0 });
});

test('insufficient history is safe', () => {
  for (const n of [0, 1, 2, 5]) {
    const r = analyze(walk(n, 1));
    assert.equal(r.swing.events.length, 0); assert.equal(r.liquidity.events.length, 0);
  }
});

test('ATR is null until warm and ignores the future', () => {
  const c = walk(40, 3); const a = atrSeries(c, 14);
  assert.equal(a[12], null); assert.ok(a[13] > 0);
  assert.deepEqual(atrSeries(c.slice(0, 25), 14), a.slice(0, 25));
});

test('pivots: confirmed only after the right window; labels HH/HL/LH/LL', () => {
  // highs peak at idx 3 (11) and 9 (15) and 14(13); lows trough at 6 (5) and 12 (7)
  const mids = [8, 9, 10, 11, 10, 7, 5, 8, 11, 14, 15, 11, 7, 10, 13, 10, 8];
  const c = series(mids, 0.2);
  const { confirmed, provisional } = detectPivots(c, 2);
  const hi = confirmed.filter(p => p.type === 'high'), lo = confirmed.filter(p => p.type === 'low');
  assert.deepEqual(hi.map(p => p.index), [3, 10, 14]);
  assert.deepEqual(hi.map(p => p.label), [null, 'HH', 'LH']);
  assert.deepEqual(lo.map(p => p.index), [6, 12]);
  assert.deepEqual(lo.map(p => p.label), [null, 'HL']);
  for (const p of confirmed) assert.equal(p.confirmedIndex, p.index + 2);
  assert.ok(provisional.every(p => p.status === 'provisional' && p.confirmedIndex === null && p.index > c.length - 4));
});

test('provisional pivot becomes confirmed (or vanishes) as bars arrive, confirmed ones never change', () => {
  const c = series([5, 6, 7, 9, 8, 7, 6, 7, 8], 0.2);
  const a = detectPivots(c.slice(0, 5), 2);   // peak at 3 needs 2 bars: bar 4 only => provisional
  assert.ok(a.provisional.some(p => p.type === 'high' && p.index === 3));
  assert.equal(a.confirmed.filter(p => p.type === 'high').length, 0);
  const b = detectPivots(c.slice(0, 6), 2);
  assert.ok(b.confirmed.some(p => p.type === 'high' && p.index === 3 && p.confirmedIndex === 5));
  const x = detectPivots(series([5, 6, 7, 9, 10, 12], 0.2), 2); // higher bar arrives -> candidate gone
  assert.ok(!x.provisional.some(p => p.type === 'high' && p.index === 3));
});

test('displacement: single and multi-candle, ATR measured before the candle', () => {
  const base = Array.from({ length: 20 }, (_, i) => mk(i, 100, 100.5, 99.5, i % 2 ? 100.2 : 99.8));
  const big = mk(20, 100, 106, 99.8, 105.5);
  const c = [...base, big];
  const d = detectDisplacement(c, atrSeries(c));
  const ev = d.find(e => e.index === 20);
  assert.equal(ev.dir, 1); assert.equal(ev.kind, 'single'); assert.ok(ev.strength >= 1.5);
  // three modest green candles with large net move => multi
  const c2 = [...base, mk(20, 100, 101.6, 99.9, 101.4), mk(21, 101.4, 103, 101.3, 102.9), mk(22, 102.9, 104.6, 102.8, 104.4)];
  const d2 = detectDisplacement(c2, atrSeries(c2), { displacementAtr: 2 });
  assert.ok(d2.some(e => e.kind === 'multi' && e.dir === 1 && e.startIndex === 20 && e.index === 22));
  assert.equal(detectDisplacement(base, atrSeries(base)).length, 0);
});

// uptrend -> BOS, then break below -> CHoCH
function structureFixture() {
  const mids = [10, 11, 12, 13, 12, 11, 12, 13, 14, 15, 16, 15, 14, 13, 12, 13, 12, 11, 10, 9, 8, 9, 10];
  return series(mids, 0.2);
}

test('BOS then CHoCH with correct levels, directions and confirmation', () => {
  const c = structureFixture();
  const atr = atrSeries(c, 3);
  const pv = detectPivots(c, 2).confirmed;
  const r = detectStructure(c, pv, detectDisplacement(c, atr, {}), { breakMode: 'close' });
  const types = r.events.map(e => `${e.type}${e.dir > 0 ? '+' : '-'}`);
  assert.ok(types[0] === 'BOS+', types.join());
  assert.ok(types.includes('CHoCH-'), types.join());
  for (const e of r.events) {
    assert.equal(e.confirmedIndex, e.index);
    assert.ok(e.pivotConfirmedIndex <= e.index, 'pivot known before break');
    assert.ok(e.pivotIndex < e.index);
  }
  const bos = r.events.find(e => e.type === 'BOS');
  assert.ok(c[bos.index].close > bos.level);
  assert.equal(r.events.filter(e => e.type === 'CHoCH').every(e => e.dir === -1 || e.dir === 1), true);
});

test('wick mode breaks on a wick; close mode needs a close', () => {
  const mids = [10, 11, 12, 11, 10, 10.5, 11];
  const c = series(mids, 0.2);
  c.push(mk(7, 11, 12.6, 10.9, 11.5)); // wick above pivot high 12.2 but close below
  c.push(mk(8, 11.5, 11.8, 11.2, 11.4));
  const pv = detectPivots(c, 2).confirmed;
  const wick = detectStructure(c, pv, [], { breakMode: 'wick' });
  const close = detectStructure(c, pv, [], { breakMode: 'close' });
  assert.equal(wick.events.length, 1); assert.equal(wick.events[0].index, 7);
  assert.equal(close.events.length, 0);
});

test('a level is consumed by its first break (no repeated BOS on the same pivot)', () => {
  const c = structureFixture();
  const r = detectStructure(c, detectPivots(c, 2).confirmed, [], {});
  const keys = r.events.map(e => `${e.dir}:${e.pivotIndex}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('MSS = CHoCH qualified by displacement; plain CHoCH is not MSS', () => {
  const calm = (n0, n, mid0, dm) => Array.from({ length: n }, (_, k) => mk(n0 + k, mid0 + dm * k, mid0 + dm * k + 0.3, mid0 + dm * k - 0.3, mid0 + dm * k + (dm >= 0 ? 0.1 : -0.1)));
  let c = [...calm(0, 12, 100, 0.2)];
  c.push(...calm(12, 4, 102.4, 0.4));        // rise to a pivot high
  c.push(...calm(16, 5, 103.6, -0.4));       // pullback
  c.push(...calm(21, 6, 101.6, 0.5));        // rally that breaks the high (BOS)
  const last = c[c.length - 1];
  const dispBreak = [...c, mk(c.length, last.close, last.close + 0.1, last.close - 6, last.close - 5.5)];
  const atr = atrSeries(dispBreak, 5);
  const pv = detectPivots(dispBreak, 2).confirmed;
  const r = detectStructure(dispBreak, pv, detectDisplacement(dispBreak, atr), {});
  const ch = r.events.filter(e => e.type === 'CHoCH');
  assert.ok(ch.length >= 1);
  assert.ok(ch.some(e => e.mss === true && e.displacementIndex === dispBreak.length - 1), JSON.stringify(r.events));
  const r2 = detectStructure(dispBreak, pv, [], {});
  assert.ok(r2.events.filter(e => e.type === 'CHoCH').every(e => e.mss === false));
});

test('forming last candle yields provisional events', () => {
  const c = structureFixture();
  const pv = detectPivots(c, 2).confirmed;
  const closed = detectStructure(c, pv, [], {});
  const open = detectStructure(c, pv, [], { lastCandleClosed: false });
  const lastIdx = c.length - 1;
  assert.deepEqual(open.events.map(e => e.status), closed.events.map(e => e.index === lastIdx ? 'provisional' : 'confirmed'));
});

// --- liquidity
function eqHighs() {
  // two highs at ~110 / 110.05 separated, then a wick above and close back below
  const mids = [100, 104, 108, 110, 108, 104, 106, 108, 110, 108, 104, 102, 104];
  return series(mids, 0.1);
}

test('equal highs cluster with ATR tolerance; unequal highs do not', () => {
  const c = eqHighs();
  const near = analyzeLiquidity(c, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.5, referenceLevels: [] });
  const buy = near.pools.filter(p => p.side === 'buy');
  assert.equal(buy.length, 1); assert.equal(buy[0].touches, 2); assert.equal(buy[0].equal, true);
  const far = eqHighs(); far[8] = bar(8, 111, 0.1);
  const r = analyzeLiquidity(far, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.1, referenceLevels: [] });
  assert.equal(r.pools.filter(p => p.side === 'buy').length, 2);
});

test('sweep: candidate, then confirmed one bar later; reaction matures; not every wick is a sweep', () => {
  const c = eqHighs();
  c.push(mk(13, 104, 111.5, 103.9, 104.5)); // wick through 110.1, close inside
  c.push(mk(14, 104.5, 104.8, 102, 102.5)); // stays inside => confirms
  for (let i = 15; i < 22; i++) c.push(bar(i, 102 - (i - 15) * 0.5, 0.3));
  const r = analyzeLiquidity(c, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.5, referenceLevels: [] });
  const cand = r.events.find(e => e.kind === 'sweep-candidate');
  const conf = r.events.find(e => e.kind === 'sweep-confirmed');
  assert.equal(cand.index, 13); assert.equal(cand.confirmedIndex, 13);
  assert.equal(conf.index, 13); assert.equal(conf.confirmedIndex, 14);
  assert.ok(conf.confirmedIndex > conf.index, 'confirmation strictly later than the wick');
  assert.equal(conf.equal, true);
  assert.ok(conf.reaction && conf.reaction.atrMove > 0 && conf.reaction.matureIndex === 19);
  assert.equal(r.pools.find(p => p.side === 'buy').status, 'swept');
});

test('wick through then close beyond the level is a failed sweep and invalidates the pool', () => {
  const c = eqHighs();
  c.push(mk(13, 104, 111.5, 103.9, 104.5));
  c.push(mk(14, 104.5, 113, 104.4, 112.5)); // closes above => acceptance
  const r = analyzeLiquidity(c, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.5, referenceLevels: [] });
  assert.ok(r.events.some(e => e.kind === 'sweep-failed'));
  assert.ok(!r.events.some(e => e.kind === 'sweep-confirmed'));
  assert.equal(r.pools.find(p => p.side === 'buy').status, 'invalidated');
});

test('a plain close-through break is invalidation, never a sweep', () => {
  const c = eqHighs();
  c.push(mk(13, 104, 112, 103.9, 111.8));
  const r = analyzeLiquidity(c, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.5, referenceLevels: [] });
  assert.equal(r.events.length, 0);
  assert.equal(r.pools.find(p => p.side === 'buy').status, 'invalidated');
});

test('pools expire by age; reaction stays null when not yet matured', () => {
  const c = eqHighs();
  for (let i = 13; i < 40; i++) c.push(bar(i, 104, 0.2));
  const r = analyzeLiquidity(c, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.5, poolMaxAge: 10, referenceLevels: [] });
  assert.ok(r.pools.length > 0 && r.pools.every(p => p.status !== 'active'));
  assert.ok(r.pools.some(p => p.status === 'expired'));
  const d = eqHighs(); d.push(mk(13, 104, 111.5, 103.9, 104.5)); d.push(mk(14, 104.5, 104.8, 102, 102.5));
  const e = analyzeLiquidity(d, { pivotWindow: 2, atrPeriod: 3, eqTolAtr: 0.5, referenceLevels: [] });
  assert.equal(e.events.find(x => x.kind === 'sweep-confirmed').reaction, null);
});

test('period ids: week starts Monday UTC', () => {
  const mon = Date.UTC(2024, 0, 1) / 1000, sun = Date.UTC(2023, 11, 31) / 1000;
  assert.notEqual(weekId(mon), weekId(sun));
  assert.equal(weekId(mon), weekId(mon + 6 * 86400));
  assert.equal(dayId(mon), dayId(mon + 86399));
});

test('previous day/week levels use only completed periods and sweep like any pool', () => {
  const step = 3600, per = 24;
  const c = [];
  for (let i = 0; i < per * 2; i++) c.push(mk(i, 100, 101, 99, 100, step));
  c[5] = mk(5, 100, 110, 99, 100, step);   // day 0 high 110, low 99
  c[30] = mk(30, 100, 111, 99.5, 100, step); // day 1 wick above 110, close below => sweep of PDH
  c.push(mk(48, 100, 100.5, 99.5, 100, step));
  const refs = referenceLevels(c, ['day']);
  const pdh = refs.find(r => r.source === 'PDH' && r.startIndex === 24);
  assert.equal(pdh.level, 110); assert.equal(pdh.periodId, dayId(c[24].epoch));
  assert.equal(refs.some(r => r.startIndex === 0), false, 'no previous period for the first day');
  const r = analyzeLiquidity(c, { referenceLevels: refs, atrPeriod: 3 });
  const sw = r.events.find(e => e.kind === 'sweep-confirmed' && e.source === 'PDH');
  assert.equal(sw.index, 30); assert.equal(sw.confirmedIndex, 31);
  assert.equal(r.pools.find(p => p.source === 'PDH').status, 'swept');
  const weekly = referenceLevels(c, ['week']);
  assert.ok(weekly.every(x => x.source.startsWith('PW')));
});

test('partial first period is flagged', () => {
  const c = [];
  for (let i = 0; i < 40; i++) c.push(mk(i, 100, 101, 99, 100, 3600));
  const shifted = c.map(x => ({ ...x, epoch: x.epoch + 10 * 3600 }));
  const refs = referenceLevels(shifted, ['day']);
  const first = refs.filter(r => r.startIndex === 14);
  assert.equal(first.length, 2); assert.ok(first.every(r => r.partial === true));
  assert.ok(refs.filter(r => r.startIndex > 14).every(r => r.partial === false));
});

// --- no look-ahead / no repainting: results on a prefix equal the prefix of the full result
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'reaction' || k === 'reactionDue' ? undefined : v)));

for (const [name, data] of [['walk-a', walk(400, 11, 1)], ['walk-b', walk(400, 29, 3)], ['hourly', walk(500, 5, 2, 3600)]]) {
  test(`no look-ahead / repainting on ${name}`, () => {
    const full = analyze(data, { reactionBars: 5 });
    assert.ok(full.swing.events.length + full.internal.events.length > 0, 'fixture should produce structure events');
    for (const k of [60, 123, 200, 301, 399]) {
      const part = analyze(data.slice(0, k), { reactionBars: 5 });
      for (const scale of ['internal', 'swing']) {
        assert.deepEqual(part[scale].pivots.confirmed, full[scale].pivots.confirmed.filter(p => p.confirmedIndex < k), `${scale} pivots @${k}`);
        assert.deepEqual(part[scale].events, full[scale].events.filter(e => e.index < k), `${scale} events @${k}`);
      }
      assert.deepEqual(part.displacement, full.displacement.filter(d => d.index < k), `displacement @${k}`);
      assert.deepEqual(strip(part.liquidity.events), strip(full.liquidity.events.filter(e => e.confirmedIndex < k)), `liquidity events @${k}`);
      assert.deepEqual(part.atr, full.atr.slice(0, k));
      // reactions that are matured in the prefix agree with the full run
      for (const ev of part.liquidity.events.filter(e => e.reaction)) {
        const f = full.liquidity.events.find(x => x.kind === ev.kind && x.poolId === ev.poolId && x.index === ev.index);
        assert.deepEqual(f.reaction, ev.reaction);
      }
    }
  });
}

test('confirmed events are stable when more data arrives; provisional pivots may change', () => {
  const data = walk(300, 17, 2);
  let prev = analyze(data.slice(0, 100));
  for (let k = 101; k <= 300; k += 7) {
    const cur = analyze(data.slice(0, k));
    const old = prev.swing.events;
    assert.deepEqual(cur.swing.events.slice(0, old.length), old, `events rewritten at ${k}`);
    prev = cur;
  }
});

test('analysis is deterministic and does not mutate its input', () => {
  const data = walk(200, 41, 2);
  const copy = JSON.parse(JSON.stringify(data));
  const a = analyze(data), b = analyze(data);
  assert.deepEqual(a, b); assert.deepEqual(data, copy);
});
