// Repeatable real-data validation. Usage:
//   node scripts/validate-ticks.mjs <ticks.csv> [--symbol R_25] [--out report.json] [--tf 60,300,600,1800,3600,14400]
// Input: CSV with a header containing `timestamp_epoch` and a price column (`raw_price_formatted` or `price`/`quote`).
// Ticks are aggregated into UTC-aligned candles; partial first/last candles are dropped (nothing is filled or invented).
// Output: data-integrity record + per-timeframe validation (first 60% = development, last 40% = held-out).
import fs from 'node:fs';
import { validateEvents } from '../src/analysis/validate.js';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.error('usage: node scripts/validate-ticks.mjs <ticks.csv> [--symbol X] [--out report.json] [--tf secs,secs]'); process.exit(2); }
const symbol = opt('symbol', 'unknown');
const tfs = opt('tf', '60,300,600,1800,3600,14400').split(',').map(Number);

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const head = lines[0].split(',');
const ei = head.indexOf('timestamp_epoch');
const pi = ['raw_price_formatted', 'price', 'quote'].map((k) => head.indexOf(k)).find((i) => i >= 0);
if (ei < 0 || pi === undefined) { console.error('required columns not found; header =', head.join(',')); process.exit(2); }

const integrity = { source: file, symbol, rows: lines.length - 1, invalid: 0, duplicateEpochs: 0, outOfOrder: 0, maxGapSec: 0, decimals: 0 };
const ticks = [];
let prev = -Infinity; const gapCounts = new Map();
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(','), epoch = Number(f[ei]), price = Number(f[pi]);
  if (!Number.isFinite(epoch) || !Number.isFinite(price) || price <= 0) { integrity.invalid++; continue; }
  integrity.decimals = Math.max(integrity.decimals, (f[pi].split('.')[1] || '').length);
  if (epoch === prev) { integrity.duplicateEpochs++; continue; }
  if (epoch < prev) { integrity.outOfOrder++; continue; }
  if (prev > -Infinity) { const g = epoch - prev; gapCounts.set(g, (gapCounts.get(g) || 0) + 1); integrity.maxGapSec = Math.max(integrity.maxGapSec, g); }
  prev = epoch; ticks.push([epoch, price]);
}
const modal = [...gapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
integrity.ticks = ticks.length; integrity.modalIntervalSec = modal ? modal[0] : null;
integrity.gapsOverTenIntervals = [...gapCounts.entries()].filter(([g]) => modal && g > 10 * modal[0]).reduce((s, [, n]) => s + n, 0);
integrity.firstUtc = new Date(ticks[0][0] * 1000).toISOString(); integrity.lastUtc = new Date(ticks[ticks.length - 1][0] * 1000).toISOString();

function aggregate(g) {
  const out = []; let cur = null;
  for (const [t, p] of ticks) {
    const b = Math.floor(t / g) * g;
    if (!cur || cur.epoch !== b) { if (cur) out.push(cur); cur = { epoch: b, open: p, high: p, low: p, close: p, firstTick: t }; }
    cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; cur.lastTick = t;
  }
  if (cur) out.push(cur);
  const iv = integrity.modalIntervalSec || 1;
  while (out.length && out[0].firstTick > out[0].epoch + iv) out.shift();
  while (out.length && out[out.length - 1].lastTick < out[out.length - 1].epoch + g - iv) out.pop();
  return out.map(({ epoch, open, high, low, close }) => ({ epoch, open, high, low, close }));
}

const report = { integrity, method: 'next-bar-open entry; horizons 1,3,5,10,20 bars; first 60% development, last 40% held-out; Wilson 95%; n<30 => no verdict', timeframes: {} };
let tested = 0;
for (const g of tfs) {
  const candles = aggregate(g);
  if (candles.length < 120) { report.timeframes[g] = { candles: candles.length, skipped: 'fewer than 120 candles' }; continue; }
  const r = validateEvents(candles, { instrument: symbol, timeframe: g });
  tested += r.summary.filter((s) => s.regime === 'all' && s.dir === 0).length * 5;
  report.timeframes[g] = {
    candles: candles.length, from: new Date(candles[0].epoch * 1000).toISOString(), to: new Date(candles[candles.length - 1].epoch * 1000).toISOString(),
    splitIndex: r.splitIndex, events: r.records.length, baseline: r.baseline, summary: r.summary,
  };
}
report.multipleTesting = { note: 'Each kind x horizon is a separate test. At 95% intervals ~5% of groups are expected to look different from the reference by chance alone; groups are also serially dependent.', approxKindHorizonTests: tested, expectedFalseFlags: Math.round(tested * 0.05 * 10) / 10 };
const out = opt('out', null);
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ integrity, timeframes: Object.fromEntries(Object.entries(report.timeframes).map(([k, v]) => [k, { candles: v.candles, from: v.from, to: v.to, events: v.events }])), multipleTesting: report.multipleTesting }, null, 1));
