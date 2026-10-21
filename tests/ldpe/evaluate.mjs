// Out-of-sample evaluation of the LDPE pipeline on SIMULATED series.
// Not a live-market result and not evidence of skill on Deriv data.
// Run: node tests/ldpe/evaluate.mjs [ticks]
import { Ldpe, LN10 } from "../../src/ldpe/engine.js";

const N = Number(process.argv[2]) || 12000;
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function gen(kind, seed) {
  const r = rng(seed), out = [], last = new Array(10).fill(-100);
  for (let i = 0; i < N; i++) {
    let d = Math.floor(r() * 10);
    if (kind === "planted-gap") { const s = last.findIndex(l => i - l >= 12); if (s >= 0 && r() < 0.5) d = s; }
    if (kind === "shift" && i >= N / 2) d = r() < 0.4 ? 7 : d;
    last[d] = i; out.push(d);
  }
  return out;
}

function evaluate(kind, seed, h = 1) {
  const e = new Ldpe({ horizon: h, minTicks: 100 });
  e.historyMax = 1e7;
  const digits = [], counts = new Array(10).fill(0), snap = new Map(), breaks = [];
  let prevBreak = 0;
  for (let i = 0; i < N; i++) {
    const d = gen.cache[kind + seed][i];
    const res = e.ingest("S", { epoch: 1000 + i, quote: "100.0" + d, decimals: 2 });
    digits.push(d); counts[d]++;
    const f = res && res.forecast;
    if (f) snap.set(f.id, { counts: counts.slice(), n: i + 1 });
    const b = e.breakStatus("S");
    if (b.count > prevBreak) { breaks.push(i); prevBreak = b.count; }
  }
  const fs = e.state("S").forecasts.filter(f => f.status === "scored" && f.realized != null);
  const ll = (v, d) => -Math.log(Math.max(v[d], 1e-12));
  const br = (v, d) => v.reduce((a, p, k) => a + (p - (k === d ? 1 : 0)) ** 2, 0);
  const rows = fs.map(f => {
    const s = snap.get(f.id), emp = s ? s.counts.map(c => (c + 1) / (s.n + 10)) : new Array(10).fill(0.1);
    const v = f.vectors.final, d = f.realized;
    return { id: f.id, seq: f.targetSeq, d, v, llM: ll(v, d), llU: LN10, llE: ll(emp, d), bM: br(v, d), bU: br(new Array(10).fill(0.1), d), bE: br(emp, d), hit: f.predictedDigit === d, p: v[f.predictedDigit] };
  });
  const agg = rs => {
    const n = rs.length || 1, m = k => rs.reduce((a, r) => a + r[k], 0) / n;
    return { n: rs.length, logLoss: m("llM"), logLossUniform: m("llU"), logLossEmpirical: m("llE"), brier: m("bM"), brierUniform: m("bU"), brierEmpirical: m("bE"), top1: m("hit") };
  };
  const bins = Array.from({ length: 5 }, (_, i) => ({ lo: 0.1 + i * 0.05, rs: [] }));
  for (const r of rows) { const b = Math.min(4, Math.max(0, Math.floor((r.p - 0.1) / 0.05))); bins[b].rs.push(r); }
  const calib = bins.filter(b => b.rs.length).map(b => ({ range: `${b.lo.toFixed(2)}-${(b.lo + 0.05).toFixed(2)}`, n: b.rs.length, meanPredicted: b.rs.reduce((a, r) => a + r.p, 0) / b.rs.length, observedHit: b.rs.filter(r => r.hit).length / b.rs.length }));
  const q = Math.floor(rows.length / 4);
  const windows = [0, 1, 2, 3].map(i => agg(rows.slice(i * q, i === 3 ? rows.length : (i + 1) * q)));
  let brk = null;
  if (breaks.length) { const at = breaks[0] + 1; brk = { alertsAtTick: breaks, before: agg(rows.filter(r => r.seq <= at)), after: agg(rows.filter(r => r.seq > at)) }; }
  return { kind, seed, horizon: h, ticks: N, overall: agg(rows), windows, calibration: calib, breaks: brk, calibrationStatus: e.calibrationStatus("S", h) };
}

gen.cache = {};
const runs = [["null", 1], ["null", 2], ["planted-gap", 3], ["shift", 4]];
for (const [k, s] of runs) gen.cache[k + s] = gen(k, s);
const f = x => (typeof x === "number" ? +x.toFixed(4) : x);
console.log("SIMULATED DATA ONLY. ln(10) =", f(LN10), "uniform Brier = 0.9\n");
for (const [k, s] of runs) {
  const r = evaluate(k, s);
  console.log(`== ${k} (seed ${s}) scored n=${r.overall.n}`);
  console.log(" overall      ", JSON.stringify(Object.fromEntries(Object.entries(r.overall).map(([a, b]) => [a, f(b)]))));
  r.windows.forEach((w, i) => console.log(` window ${i + 1}     `, `n=${w.n} ll=${f(w.logLoss)} (unif ${f(w.logLossUniform)}, emp ${f(w.logLossEmpirical)}) brier=${f(w.brier)} top1=${f(w.top1)}`));
  console.log(" calibration  ", JSON.stringify(r.calibration.map(c => ({ ...c, meanPredicted: f(c.meanPredicted), observedHit: f(c.observedHit) }))));
  console.log(" calib status ", r.calibrationStatus.ready ? "ready" : "not ready", "scored", r.calibrationStatus.scored, "oos", JSON.stringify(r.calibrationStatus.outOfSample));
  if (r.breaks) console.log(" break alerts at ticks", r.breaks.alertsAtTick.join(","), "| before ll", f(r.breaks.before.logLoss), "n", r.breaks.before.n, "| after ll", f(r.breaks.after.logLoss), "n", r.breaks.after.n);
  else console.log(" break alerts  none");
}
