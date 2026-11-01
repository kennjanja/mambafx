import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeSignal, TRADE_SIGNAL_TFS, PROFILE_LIST, PROFILES, ALL_GRANULARITIES } from '../../src/analysis/tradeSignal.js';
import { analyzeEvidence } from '../../src/analysis/evidence.js';

// Synthetic data only: these tests check the composition rules, not market behaviour.
const K = (o, h, l, c, i, step) => ({ epoch: 1.7e9 + i * step, open: o, high: h, low: l, close: c });
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n, step, drift = 0) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8 + drift; out.push(K(o, Math.max(o, p) + r() * 0.6, Math.min(o, p) - r() * 0.6, p, i, step)); }
  return out;
}
const flat = (n, step) => Array.from({ length: n }, (_, i) => K(100, 100.5, 99.5, 100 + (i % 2 ? 0.05 : -0.05), i, step));
const set = (f) => ({ 300: f(300), 1800: f(1800), 3600: f(3600), 14400: f(14400) });

test('missing or short candle history is reported, never guessed', () => {
  const s = buildTradeSignal({ symbol: 'R_75', label: 'Volatility 75', candles: {} });
  assert.equal(s.status, 'insufficient');
  assert.equal(s.dir, 0);
  assert.match(s.headline, /waiting for candle history/);
});
test('a flat market yields no signal', () => {
  const s = buildTradeSignal({ symbol: 'R_10', candles: set((st) => flat(150, st)) });
  assert.equal(s.status, 'none');
  assert.match(s.reason, /30 min evidence is inconclusive/);
});
test('every outcome is internally consistent across many synthetic series', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const drift = ((seed % 5) - 2) * 0.15;
    const candles = { 300: walk(seed, 300, 300, drift), 1800: walk(seed + 100, 300, 1800, drift), 3600: walk(seed + 200, 300, 3600, drift), 14400: walk(seed + 300, 300, 14400, drift) };
    const s = buildTradeSignal({ symbol: 'X', candles });
    seen.add(s.status);
    const bias = analyzeEvidence(candles[1800], { htf: [{ tf: '1 hour', candles: candles[3600] }, { tf: '4 hour', candles: candles[14400] }] });
    assert.equal(s.dir === 1, bias.verdict === 'bullish-lean');
    assert.equal(s.dir === -1, bias.verdict === 'bearish-lean');
    if (s.status === 'signal') {
      assert.ok(s.dir !== 0);
      assert.equal(s.action, s.dir === 1 ? 'BUY' : 'SELL');
      assert.notEqual(s.entry.verdict, s.dir === 1 ? 'bearish-lean' : 'bullish-lean');
      if (s.target) assert.ok(s.dir === 1 ? s.target.price > s.price : s.target.price < s.price, 'target is on the trade side of price');
      assert.match(s.headline, new RegExp(`${s.dir === 1 ? 'BULLISH' : 'BEARISH'} lean on 30 min.*${s.action} on 5 min`));
    }
    if (s.status === 'wait') assert.match(s.reason, /against the 30 min/);
    assert.ok(!('probability' in s) && !('winRate' in s));
  }
  assert.ok(seen.size >= 1);
});
test('timeframes are the documented 30 min bias and 5 min entry', () => {
  assert.equal(TRADE_SIGNAL_TFS.bias.g, 1800);
  assert.equal(TRADE_SIGNAL_TFS.entry.g, 300);
});

test('profiles: every profile yields a consistent status; signals carry a trigger, hold and exit rule', () => {
  const counts = { signal: 0, watching: 0 };
  for (const prof of PROFILE_LIST) {
    for (let seed = 1; seed <= 40; seed++) {
      const drift = ((seed % 5) - 2) * 0.15, candles = {};
      ALL_GRANULARITIES.forEach((g, i) => { candles[g] = walk(seed * 7 + i, 300, g, drift); });
      const s = buildTradeSignal({ symbol: 'X', candles, profile: prof });
      assert.equal(s.profile, prof.id); assert.equal(s.holdSec, prof.holdSec);
      if (s.status === 'signal') {
        counts.signal++;
        assert.ok(s.trigger && s.trigger.kind === 'model');
        assert.ok(s.primaryModel && s.qualifyingModelIds.includes(s.primaryModel.model_id));
        assert.equal(s.reversal, null, 'a signal never opens with an opposing reversal already present');
        assert.match(s.headline, new RegExp(`hold ${prof.holdLabel}`));
        assert.match(s.headline, new RegExp(`on ${prof.tfs.entry.label}.*${s.primaryModel.name}`));
      }
      if (s.status === 'watching') { counts.watching++; assert.match(s.headline, /waiting for/); }
    }
  }
  assert.ok(counts.signal + counts.watching > 0);
  assert.deepEqual(ALL_GRANULARITIES, [180, 300, 900, 1800, 3600, 14400]);
  assert.equal(PROFILES.scalp.holdSec, 180);
});

test('closed-bar as-of outputs are invariant to truncation, forming candles, and future mutations', () => {
  const t = 240, asOf = 1_800_000_000, candles = {};
  for (const g of ALL_GRANULARITIES) {
    const start = asOf - (t + 1) * g;
    candles[g] = walk(g + 3, 300, g, 0.05).map((c, i) => ({ ...c, epoch: start + i * g }));
  }
  for (const profile of PROFILE_LIST) {
    const cutoff = candles[profile.tfs.entry.g][t].epoch + profile.tfs.entry.g;
    const prefix = Object.fromEntries(Object.entries(candles).map(([g, series]) => [g, series.slice(0, t + 1)]));
    const full = Object.fromEntries(Object.entries(candles).map(([g, series]) => [g, series]));
    const forming = Object.fromEntries(Object.entries(full).map(([g, series]) => [g, [...series, { ...series.at(-1), epoch: cutoff }]]));
    const before = buildTradeSignal({ symbol: 'X', candles: prefix, profile, nowSec: cutoff });
    const fromFull = buildTradeSignal({ symbol: 'X', candles: full, profile, nowSec: cutoff });
    const withForming = buildTradeSignal({ symbol: 'X', candles: forming, profile, nowSec: cutoff });
    assert.deepEqual(fromFull, before, `${profile.id}: future candles must not affect the as-of result`);
    assert.deepEqual(withForming, before, `${profile.id}: forming candles must be excluded`);
    const mutated = Object.fromEntries(Object.entries(full).map(([g, series]) => [g, series.map((c, i) => i <= t ? c : { ...c, open: c.open + 500, high: c.high + 500, low: c.low + 500, close: c.close + 500 })]));
    assert.deepEqual(buildTradeSignal({ symbol: 'X', candles: mutated, profile, nowSec: cutoff }), before);
  }
});


test('signal snapshots carry event and confirmation timestamps', () => {
  const candles = {};
  for (const [i, g] of ALL_GRANULARITIES.entries()) candles[g] = walk(i + 100, 240, g, 0.1).map((c) => ({ ...c, epoch: 1_700_000_000 + i * 10_000_000 + c.epoch - 1.7e9 }));
  const s = buildTradeSignal({ symbol: 'X', candles });
  if (s.status === 'signal') {
    assert.ok(Number.isFinite(s.confirmedAt));
    assert.ok(s.evidenceSnapshot.every((item) => 'occurredAt' in item && 'confirmedAt' in item));
  }
});
