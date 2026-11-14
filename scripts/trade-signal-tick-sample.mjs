// Read-only bounded sample; this is a data-quality probe, not a backtest.
// node scripts/trade-signal-tick-sample.mjs R_100 reports/trade-signal-ticks.json
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [symbol, output] = process.argv.slice(2);
if (!symbol || !output || !/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
  console.error('usage: node scripts/trade-signal-tick-sample.mjs SYMBOL OUTPUT.json');
  process.exit(2);
}
const endpoint = 'wss://api.derivws.com/trading/v1/options/ws/public';
const requested = { ticks_history: symbol, end: 'latest', count: 1000, style: 'ticks', req_id: 1 };
const socket = new WebSocket(endpoint);
const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error('Tick-history request timed out')); }, 20000);
  socket.addEventListener('open', () => socket.send(JSON.stringify(requested)));
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Tick-history connection failed')); });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (error) { clearTimeout(timer); socket.close(); reject(error); return; }
    if (message.req_id !== 1) return;
    clearTimeout(timer); socket.close();
    if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
    else resolve(message);
  });
});
const times = response.history?.times, prices = response.history?.prices;
if (!Array.isArray(times) || !Array.isArray(prices) || !times.length || times.length !== prices.length || response.echo_req?.ticks_history !== symbol) {
  throw new Error('Invalid response or mismatched requested symbol');
}
const intervals = new Map(), duplicates = new Set(), seen = new Set();
let invalid = 0, outOfOrder = 0, duplicateRows = 0, maxGap = 0;
for (let i = 0; i < times.length; i++) {
  const t = times[i], p = prices[i];
  if (!Number.isSafeInteger(t) || t < 0 || !Number.isFinite(p) || p <= 0) invalid++;
  if (seen.has(t)) { duplicateRows++; duplicates.add(t); }
  seen.add(t);
  if (i > 0) {
    const gap = t - times[i - 1];
    if (gap < 0) outOfOrder++;
    if (Number.isFinite(gap) && gap > 0) {
      intervals.set(gap, (intervals.get(gap) || 0) + 1);
      maxGap = Math.max(maxGap, gap);
    }
  }
}
const sortedIntervals = [...intervals].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
const modal = sortedIntervals[0]?.[0] ?? null;
const data = {
  source: endpoint, collectedAtUtc: new Date().toISOString(), requested, response,
  integrity: {
    rows: times.length, invalid, duplicateTimestampRows: duplicateRows, distinctDuplicateTimestamps: duplicates.size,
    outOfOrder, firstEpoch: times[0], lastEpoch: times.at(-1), maxGapSec: maxGap,
    modalIntervalSec: modal, intervalCounts: Object.fromEntries([...intervals].sort((a, b) => a[0] - b[0])),
    gapsExceedingModalInterval: modal === null ? null : [...intervals].filter(([gap]) => gap > modal).reduce((sum, [, count]) => sum + count, 0),
    declaredPipSize: response.pip_size ?? null,
    limitations: 'Timestamp collisions can be distinct ticks; no sequence ID is supplied. Modal spacing cannot prove missing ticks. Numeric JSON loses formatted trailing zeros. Symbol is checked only against the echoed request. UTC epochs are feed-provided, not independently verified. Completeness and accuracy are unverified.',
  },
};
const text = JSON.stringify(data, null, 2) + '\n';
writeFileSync(output, text, { flag: 'wx' });
console.log(JSON.stringify({ file: output, sha256: createHash('sha256').update(text).digest('hex'), integrity: data.integrity }, null, 2));
