import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvents, wilson, collectEvents, summarize } from '../../src/analysis/validate.js';

function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(seed, n) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.5) * 2 + Math.sin(i / 11) * 0.8; out.push({ epoch: 1.7e9 + i * 60, open: o, high: Math.max(o, p) + r() * 0.6, low: Math.min(o, p) - r() * 0.6, close: p }); }
  return out;
}

test('wilson interval sanity', () => {
  const w = wilson(50, 100);
  assert.ok(w.lo < 0.5 && w.hi > 0.5 && w.lo > 0.39 && w.hi < 0.61);
  assert.equal(wilson(0, 0), null);
});
test('records carry the required fields; entry is after confirmation', () => {
  const r = validateEvents(walk(1, 1500), { instrument: 'X', timeframe: '1m' });
  assert.ok(r.records.length > 20);
  for (const x of r.records.slice(0, 200)) {
    assert.equal(x.instrument, 'X'); assert.equal(x.timeframe, '1m');
    assert.ok(Number.isFinite(x.eventTime) && Number.isFinite(x.confirmTime));
    assert.ok(x.confirmTime >= x.eventTime);
    assert.ok(['low', 'normal', 'high', 'unknown'].includes(x.regime));
    assert.ok(['train', 'test'].includes(x.sample));
  }
});
test('outcome of an event is independent of candles after its horizon', () => {
  const data = walk(2, 1200);
  const a = validateEvents(data, {}, { horizons: [1, 3, 5] }), tail = data.slice(0, 1000);
  const b = validateEvents(tail.concat(walk(77, 200).map((c, i) => ({ ...c, epoch: tail[999].epoch + (i + 1) * 60 }))), {}, { horizons: [1, 3, 5] });
  const key = (r) => `${r.kind}|${r.dir}|${r.confirmedIndex}`;
  const mb = new Map(b.records.map((r) => [key(r), r]));
  let compared = 0;
  for (const r of a.records) {
    if (r.confirmedIndex > 900) break;
    const o = mb.get(key(r)); if (!o) continue;
    assert.deepEqual(o.outcomes[3], r.outcomes[3]); compared++;
  }
  assert.ok(compared > 20);
});
test('only the later fraction is scored as test; matured flag respected', () => {
  const r = validateEvents(walk(3, 1000));
  const firstTest = r.records.find((x) => x.sample === 'test');
  assert.ok(firstTest.confirmedIndex >= r.splitIndex);
  assert.ok(r.records.filter((x) => x.sample === 'train').every((x) => x.confirmedIndex < r.splitIndex));
  const last = r.records[r.records.length - 1];
  if (!last.matured) assert.equal(last.outcomes[20], null);
});
test('small samples get no verdict', () => {
  const s = summarize([{ kind: 'k', regime: 'low', sample: 'test', matured: true, mfe: 1, mae: 1, outcomes: { 1: { hit: true } } }], { horizons: [1], minN: 30 });
  assert.equal(s[0].horizons[1].verdict, 'insufficient');
});
test('pure-noise data: no event type is persistently strong (false-positive control)', () => {
  let strong = 0, total = 0;
  for (const seed of [31, 32, 33, 34, 35]) {
    const r = rng(seed); let p = 100; const d = [];
    for (let i = 0; i < 3000; i++) { const o = p; p += (r() - 0.5) * 2; d.push({ epoch: 1.7e9 + i * 60, open: o, high: Math.max(o, p) + r() * 0.3, low: Math.min(o, p) - r() * 0.3, close: p }); }
    for (const row of validateEvents(d).summary.filter((x) => x.regime === 'all')) for (const h of [1, 3, 5, 10, 20]) {
      const v = row.horizons[h]; if (v.insufficient) continue; total++;
      if (v.verdict !== 'indistinguishable-from-50') strong++;
    }
  }
  // 95% intervals => roughly 5% false flags expected; allow generous slack but fail if most are flagged
  assert.ok(total > 50);
  assert.ok(strong / total < 0.25, `${strong}/${total} flagged on random walks`);
});
test('collectEvents is deterministic and sorted by confirmation', () => {
  const d = walk(5, 600), a = collectEvents(d).events, b = collectEvents(d).events;
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].confirmedIndex >= a[i - 1].confirmedIndex);
});

test('baseline and direction groups are reported; verdicts vs baseline obey minN', () => {
  const r = validateEvents(walk(9, 2500));
  assert.ok(r.baseline[1].test[5].n > 500);
  const b = r.baseline[1].test[5], s = r.baseline[-1].test[5];
  assert.ok(Math.abs(b.hits / b.n + s.hits / s.n - 1) < 0.02); // up + down + ties ~ 1
  const dirRows = r.summary.filter((x) => x.dir !== 0);
  assert.ok(dirRows.length > 0);
  for (const row of dirRows) for (const h of Object.values(row.horizons)) {
    if (h.insufficient) assert.equal(h.verdictVsBaseline, 'insufficient');
    else assert.ok(h.baseline && h.baseline.test > 0.3 && h.baseline.test < 0.7);
  }
});
test('zone retest events are emitted at the touch bar, never before the zone is confirmed', () => {
  const { events } = collectEvents(walk(11, 1200));
  const rt = events.filter((e) => e.kind.endsWith('-retest'));
  assert.ok(rt.length > 0);
  for (const e of rt) assert.equal(e.index, e.confirmedIndex);
});
