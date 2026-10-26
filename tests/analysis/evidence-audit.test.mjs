import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence, EVIDENCE_DEFAULTS } from '../../src/analysis/evidence.js';

const K = (o, h, l, c, i) => ({ epoch: 1.7e9 + i * 60, open: o, high: h, low: l, close: c });
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n, drift = 0) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8 + drift; out.push(K(o, Math.max(o, p) + r() * 0.6, Math.min(o, p) - r() * 0.6, p, i)); }
  return out;
}
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

test('documented provisional weights are unchanged', () => {
  assert.deepEqual(EVIDENCE_DEFAULTS.weights, {
    structureBias: 2, break: 3, liquidity: 2, location: 1, zone: 2, candle: 1, level: 1, trend: 1.5, htf: 2,
  });
});

test('balance equals sum of group nets over the fixed weight total', () => {
  const total = Object.values(EVIDENCE_DEFAULTS.weights).reduce((a, b) => a + b, 0);
  assert.equal(total, 15.5);
  for (const s of SEEDS) {
    const e = analyzeEvidence(walk(s, 240, (s % 3 - 1) * 0.1));
    if (!e.sufficient) continue;
    const net = e.groups.reduce((a, g) => a + (g.bull - g.bear), 0);
    assert.ok(Math.abs(e.balance - net / total) < 1e-9, `seed ${s}`);
  }
});

test('supporting/conflicting are empty when inconclusive; bullish/bearish lists are neutral', () => {
  let inconclusive = 0, lean = 0;
  for (const s of SEEDS) {
    const e = analyzeEvidence(walk(s, 240, (s % 5 - 2) * 0.2));
    if (e.verdict === 'inconclusive') {
      inconclusive++;
      assert.equal(e.supporting.length, 0);
      assert.equal(e.conflicting.length, 0);
      assert.ok(e.bullishItems.every((i) => i.dir === 1));
      assert.ok(e.bearishItems.every((i) => i.dir === -1));
    } else if (e.verdict === 'bullish-lean') {
      lean++;
      assert.ok(e.supporting.every((i) => i.dir === 1));
      assert.ok(e.conflicting.every((i) => i.dir === -1));
    } else if (e.verdict === 'bearish-lean') {
      lean++;
      assert.ok(e.supporting.every((i) => i.dir === -1));
      assert.ok(e.conflicting.every((i) => i.dir === 1));
    }
  }
  assert.ok(inconclusive > 0, 'fixture set must exercise the inconclusive path');
  assert.ok(lean > 0, 'fixture set must exercise a lean path');
});

test('limitations state weights are provisional and VWAP/profile are proxies outside the balance', () => {
  const e = analyzeEvidence(walk(3, 240));
  assert.ok(e.limitations.some((l) => /PROVISIONAL/.test(l)));
  assert.ok(e.limitations.some((l) => /VWAP and volume-profile.*proxies.*not inputs/.test(l)));
  assert.ok(e.limitations.some((l) => /not independent/.test(l)));
});

test('characterisation: structure and break groups can carry the same recent swing event', () => {
  let both = 0;
  for (const s of SEEDS) {
    const e = analyzeEvidence(walk(s, 240, 0.1));
    if (!e.sufficient) continue;
    const st = e.items.filter((i) => i.group === 'structure' && /BOS|CHoCH/i.test(i.label));
    const br = e.items.filter((i) => i.group === 'break');
    if (st.length && br.length) both++;
  }
  // Documents (does not endorse) the overlap measured in docs/evidence-audit.md.
  assert.ok(both > 0, 'expected at least one fixture with both groups populated');
});
