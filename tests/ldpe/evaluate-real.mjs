// Out-of-sample evaluation of the unchanged LDPE engine on REAL public Deriv ticks (no login, no orders).
// Network script, not part of the test suite. Run: node tests/ldpe/evaluate-real.mjs [ticksPerSymbol] [horizon] [symbols...]
// Reports paired log-loss / Brier differences vs the uniform 10% baseline with a block-bootstrap CI
// (forecasts overlap, so a block of 2*horizon+50 forecasts is resampled), plus a uniformity test on the raw digits.
import { Ldpe, LN10, chi2sf } from "../../src/ldpe/engine.js";

const N = Number(process.argv[2]) || 20000;
const H = Number(process.argv[3]) || 5;
const SYMS = process.argv.slice(4).length ? process.argv.slice(4) : ["1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"];
const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function fetchTicks(sym, total) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL), out = [];
    let end = "latest", rid = 0;
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("timeout " + sym)); }, 120000);
    const ask = () => ws.send(JSON.stringify({ ticks_history: sym, end, count: 1000, style: "ticks", req_id: ++rid }));
    ws.onopen = ask;
    ws.onerror = () => reject(new Error("ws error " + sym));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.error) { clearTimeout(timer); ws.close(); return reject(new Error(sym + ": " + m.error.message)); }
      if (!m.history) return;
      const pip = m.pip_size, dec = Number.isInteger(pip) ? pip : Math.round(-Math.log10(pip));
      const rows = m.history.times.map((t, i) => ({ epoch: Number(t), quote: Number(m.history.prices[i]).toFixed(dec), decimals: dec }));
      out.unshift(...rows);
      if (out.length >= total || rows.length < 1000) { clearTimeout(timer); ws.close(); return resolve(out.slice(-total)); }
      end = String(rows[0].epoch - 1); ask();
    };
  });
}

const rng = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

function blockBootstrap(d, block, reps = 2000, seed = 11) {
  const n = d.length, r = rng(seed), means = [];
  for (let b = 0; b < reps; b++) {
    let s = 0, c = 0;
    while (c < n) { const st = Math.floor(r() * n); for (let k = 0; k < block && c < n; k++, c++) s += d[(st + k) % n]; }
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(reps * 0.025)], means[Math.floor(reps * 0.975)]];
}

for (const sym of SYMS) {
  let ticks;
  try { ticks = await fetchTicks(sym, N); } catch (e) { console.log(`${sym}: fetch failed (${e.message})`); continue; }
  const e = new Ldpe({ horizon: H, minTicks: 100 }); e.historyMax = 1e7;
  const counts = new Array(10).fill(0);
  for (const t of ticks) { const r = e.ingest(sym, t); if (r && r.digit != null) counts[r.digit]++; }
  const n = counts.reduce((a, b) => a + b, 0), chi = counts.reduce((a, c) => a + (c - n / 10) ** 2 / (n / 10), 0);
  const fs = e.state(sym).forecasts.filter(f => f.status === "scored" && f.realized != null);
  const dLL = [], dBr = [];
  let hit = 0;
  for (const f of fs) {
    const v = f.vectors.final, d = f.realized;
    dLL.push(-Math.log(Math.max(v[d], 1e-12)) - LN10);             // < 0 means better than uniform
    dBr.push(v.reduce((a, p, i) => a + (p - (i === d ? 1 : 0)) ** 2, 0) - 0.9);
    if (f.predictedDigit === d) hit++;
  }
  const m = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const ciL = fs.length ? blockBootstrap(dLL, 2 * H + 50) : [NaN, NaN];
  const traded = fs.filter(f => f.decision === "TRADE");
  const tHit = traded.filter(f => f.predictedDigit === f.realized).length;
  console.log(`${sym}: ticks ${ticks.length}, scored ${fs.length}, digit chi2 p=${chi2sf(chi, 9).toFixed(3)}, ` +
    `dLogLoss ${m(dLL).toExponential(2)} CI[${ciL[0].toExponential(1)}, ${ciL[1].toExponential(1)}] (neg = beats uniform), dBrier ${m(dBr).toExponential(2)}, ` +
    `top1 ${(hit / (fs.length || 1) * 100).toFixed(2)}% (chance 10%), TRADE forecasts ${traded.length}` + (traded.length ? ` hit ${(tHit / traded.length * 100).toFixed(2)}%` : ""));
}
