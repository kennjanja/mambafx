// Descriptive audit of the evidence engine on real ticks (NO forward returns are used, so nothing here can tune weights to outcomes).
// Usage: node scripts/audit-evidence.mjs <ticks.csv> [--tf 60,300] [--step 20] [--window 300]
// Reports, per timeframe: group activity, share of total |net| contributed per group, pairwise correlation of group nets,
// how often one structure event is counted in two groups, and verdict/label statistics.
import fs from 'node:fs';
import { analyzeEvidence, EVIDENCE_DEFAULTS } from '../src/analysis/evidence.js';
import { analyze } from '../src/analysis/engine.js';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.error('usage: node scripts/audit-evidence.mjs <ticks.csv> [--tf 60,300] [--step 20] [--window 300]'); process.exit(2); }
const tfs = opt('tf', '60,300').split(',').map(Number), step = +opt('step', 20), win = +opt('window', 300);

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean), head = lines[0].split(',');
const ei = head.indexOf('timestamp_epoch'), pi = ['raw_price_formatted', 'price', 'quote'].map((k) => head.indexOf(k)).find((i) => i >= 0);
const ticks = []; let prev = -Infinity;
for (let i = 1; i < lines.length; i++) { const f = lines[i].split(','), t = +f[ei], p = +f[pi]; if (Number.isFinite(t) && Number.isFinite(p) && p > 0 && t > prev) { ticks.push([t, p]); prev = t; } }
const candlesOf = (g) => {
  const out = []; let c = null;
  for (const [t, p] of ticks) { const b = Math.floor(t / g) * g; if (!c || c.epoch !== b) { if (c) out.push(c); c = { epoch: b, open: p, high: p, low: p, close: p }; } c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; }
  return out.slice(1, -1);
};
const corr = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : null; };

const result = { weights: EVIDENCE_DEFAULTS.weights, denominator: Object.values(EVIDENCE_DEFAULTS.weights).reduce((s, v) => s + v, 0), source: file, ticks: ticks.length, timeframes: {} };
for (const g of tfs) {
  const all = candlesOf(g), names = Object.keys(EVIDENCE_DEFAULTS.weights).map((k) => (k === 'structureBias' ? 'structure' : k)); // weight key structureBias feeds group 'structure'
  const nets = Object.fromEntries(names.map((k) => [k, []])), act = Object.fromEntries(names.map((k) => [k, 0]));
  const verdicts = {}; let samples = 0, dbl = 0, dblWithSwing = 0, inconclusiveWithSupport = 0, inconclusive = 0, conflictedGroups = 0, capped = 0;
  for (let end = win; end <= all.length; end += step) {
    const slice = all.slice(end - win, end);
    const e = analyzeEvidence(slice);
    if (!e.sufficient) continue;
    samples++; verdicts[e.verdict] = (verdicts[e.verdict] || 0) + 1;
    const byG = Object.fromEntries(e.groups.map((x) => [x.group, x]));
    for (const k of names) { const x = byG[k]; nets[k].push(x ? x.net : 0); if (x && (x.bull || x.bear)) act[k]++; if (x && x.conflicted) conflictedGroups++; }
    const st = e.items.filter((i) => i.group === 'structure' && i.index != null), br = e.items.filter((i) => i.group === 'break');
    if (st.length) { dblWithSwing++; if (st.some((s) => br.some((b) => b.index === s.index && b.dir === s.dir))) dbl++; }
    if (e.verdict === 'inconclusive') { inconclusive++; if (e.supporting.length) inconclusiveWithSupport++; }
  }
  const tot = names.reduce((s, k) => s + nets[k].reduce((a, v) => a + Math.abs(v), 0), 0);
  const pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) { const r = corr(nets[names[i]], nets[names[j]]); if (r != null) pairs.push({ a: names[i], b: names[j], r: +r.toFixed(2) }); }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  result.timeframes[g] = {
    candles: all.length, samples, verdicts,
    groups: Object.fromEntries(names.map((k) => [k, { activeShare: +(act[k] / samples).toFixed(2), absNetShare: +(nets[k].reduce((a, v) => a + Math.abs(v), 0) / tot).toFixed(3) }])),
    topCorrelatedPairs: pairs.slice(0, 6),
    structureEventAlsoInBreakGroup: { whenStructureItemPresent: dblWithSwing, alsoInBreak: dbl },
    inconclusive, inconclusiveButSupportingListNonEmpty: inconclusiveWithSupport,
  };
}
console.log(JSON.stringify(result, null, 1));
