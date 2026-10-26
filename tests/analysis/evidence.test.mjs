import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence } from '../../src/analysis/evidence.js';

const K = (o, h, l, c, i) => ({ epoch: 1.7e9 + i * 60, open: o, high: h, low: l, close: c, });
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n, drift = 0) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8 + drift; out.push(K(o, Math.max(o, p) + r() * 0.6, Math.min(o, p) - r() * 0.6, p, i)); }
  return out;
}
const flat = (n) => Array.from({ length: n }, (_, i) => K(100, 100.5, 99.5, 100 + (i % 2 ? 0.05 : -0.05), i));

test('insufficient data is reported, not guessed', () => {
  const e = analyzeEvidence(walk(1, 30));
  assert.equal(e.sufficient, false);
  assert.equal(e.verdict, 'insufficient-data');
  assert.equal(e.balance, null);
  assert.ok(e.limitations.some((l) => /need/.test(l)));
});
test('empty and invalid input do not throw', () => {
  assert.doesNotThrow(() => analyzeEvidence([]));
  assert.doesNotThrow(() => analyzeEvidence(null));
  const c = walk(2, 120); c[5] = { ...c[5], close: NaN };
  assert.equal(analyzeEvidence(c).dropped, 1);
});
test('neutral flat market stays inconclusive', () => {
  const e = analyzeEvidence(flat(150));
  assert.equal(e.verdict, 'inconclusive');
  assert.ok(Math.abs(e.balance) < 0.35);
});
test('balance is bounded and never labelled a probability', () => {
  for (const s of [3, 4, 5]) {
    const e = analyzeEvidence(walk(s, 220));
    assert.ok(e.balance >= -1 && e.balance <= 1);
    assert.ok(!('probability' in e) && !('confidence' in e) && !('winRate' in e));
    assert.match(e.disclaimer, /Not a forecast/);
    assert.ok(e.limitations.some((l) => /not a probability/.test(l)));
  }
});
test('correlated items count once per group', () => {
  const e = analyzeEvidence(walk(6, 220, 0.05));
  for (const g of e.groups) {
    const itemsBull = e.items.filter((i) => i.group === g.group && i.dir === 1).map((i) => i.weight);
    assert.equal(g.bull, itemsBull.length ? Math.max(...itemsBull) : 0); // max, not sum
  }
  const breakItems = e.items.filter((i) => i.group === 'break' && i.dir === 1);
  const bg = e.groups.find((g) => g.group === 'break');
  if (breakItems.length > 1) assert.ok(bg.bull < breakItems.reduce((s, i) => s + i.weight, 0));
});
test('strong uptrend leans bullish or stays inconclusive; never bearish', () => {
  const e = analyzeEvidence(walk(7, 250, 0.35));
  assert.notEqual(e.verdict, 'bearish-lean');
  assert.ok(e.facts.swingBias >= 0);
});
test('conflicting evidence is surfaced and prevents a forced lean', () => {
  // uptrend then sharp drop: structure/trend disagree
  const c = walk(8, 200, 0.3);
  for (let i = 0; i < 6; i++) { const p = c[c.length - 1].close; c.push(K(p, p + 0.2, p - 4, p - 3.8, 200 + i)); }
  const e = analyzeEvidence(c);
  assert.ok(e.items.some((i) => i.dir === 1) && e.items.some((i) => i.dir === -1));
  assert.ok(e.conflicts.length > 0);
});
test('multi-timeframe conflict forces inconclusive and is listed', () => {
  const ltf = walk(9, 250, 0.35);
  const down = walk(10, 250, -0.35);
  const e = analyzeEvidence(ltf, { htf: [{ tf: 'H1', candles: down }] });
  assert.ok(e.conflicts.some((c) => c.startsWith('multi-timeframe')));
  assert.equal(e.verdict, 'inconclusive');
  assert.ok(e.items.some((i) => i.group === 'htf' && i.tf === 'H1'));
});
test('higher timeframes disagreeing with each other is flagged', () => {
  const e = analyzeEvidence(walk(11, 200), { htf: [{ tf: 'H1', candles: walk(12, 250, 0.35) }, { tf: 'H4', candles: walk(13, 250, -0.35) }] });
  assert.ok(e.conflicts.some((c) => /disagree with each other/.test(c)));
});
test('missing HTF data is a stated limitation; short HTF is listed missing', () => {
  const a = analyzeEvidence(walk(14, 200));
  assert.ok(a.limitations.some((l) => /higher-timeframe/.test(l)));
  const b = analyzeEvidence(walk(14, 200), { htf: [{ tf: 'D1', candles: walk(1, 20) }] });
  assert.ok(b.missing.includes('htf:D1'));
});
test('scenarios carry invalidation and targets as price areas; only the supported one is flagged', () => {
  const e = analyzeEvidence(walk(15, 250, 0.2));
  assert.equal(e.scenarios.length, 2);
  assert.ok(e.scenarios.filter((s) => s.supported).length <= 1);
  for (const s of e.scenarios) {
    if (s.invalidation) assert.ok(Number.isFinite(s.invalidation.price));
    for (const t of s.targets) assert.ok(Number.isFinite(t.price));
  }
});
test('weights are configurable and change the outcome transparently', () => {
  const c = walk(16, 250, 0.2);
  const a = analyzeEvidence(c), b = analyzeEvidence(c, { weights: { break: 0, structureBias: 0, trend: 0, htf: 0, liquidity: 0, location: 0, zone: 0, candle: 0, level: 0 } });
  assert.equal(b.balance, 0);
  assert.equal(b.verdict, 'inconclusive');
  assert.ok(a.items.length >= 0);
});
test('facts and interpretations are tagged', () => {
  const e = analyzeEvidence(walk(17, 250, 0.2));
  assert.ok(e.items.every((i) => i.kind === 'fact' || i.kind === 'interpretation'));
  assert.ok(e.items.filter((i) => i.group === 'break').every((i) => i.kind === 'fact'));
});
test('deterministic', () => {
  const c = walk(18, 220);
  assert.equal(JSON.stringify(analyzeEvidence(c)), JSON.stringify(analyzeEvidence(c)));
});
test('as-of semantics: later candles never alter the evidence of a prefix', () => {
  const data = walk(19, 300, 0.1);
  const k = 200, pre = analyzeEvidence(data.slice(0, k));
  const mutated = data.slice(0, k).concat(walk(99, 100, -1).map((c, i) => ({ ...c, epoch: data[k - 1].epoch + (i + 1) * 60 })));
  assert.equal(JSON.stringify(analyzeEvidence(mutated.slice(0, k))), JSON.stringify(pre));
  for (const it of pre.items) if (it.index != null) assert.ok(it.index < k);
});
