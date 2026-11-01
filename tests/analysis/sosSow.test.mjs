import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFresh, contractFor, tfLabel } from '../../src/analysis/sosSow.js';

const G = 60, T0 = 1_700_000_000 - (1_700_000_000 % 60);
// flat-ish range, then one big candle
function series(lastOpen, lastClose, n = 50) {
  const cs = [];
  for (let i = 0; i < n - 1; i++) { const m = 100 + (i % 2 ? 0.1 : -0.1); cs.push({ epoch: T0 + i * G, open: m, high: m + 0.3, low: m - 0.3, close: m + (i % 2 ? -0.05 : 0.05) }); }
  const hi = Math.max(lastOpen, lastClose) + 0.1, lo = Math.min(lastOpen, lastClose) - 0.1;
  cs.push({ epoch: T0 + (n - 1) * G, open: lastOpen, high: hi, low: lo, close: lastClose });
  return cs;
}
const closeOfLast = (cs) => cs[cs.length - 1].epoch + G;

test('SOS on the last closed candle -> CALL, SOW -> PUT', () => {
  const up = series(100, 103), dn = series(100, 97);
  const a = detectFresh(up, G, closeOfLast(up) + 2), b = detectFresh(dn, G, closeOfLast(dn) + 2);
  assert.equal(a.kind, 'SOS'); assert.equal(a.contractType, 'CALL'); assert.equal(a.dir, 1);
  assert.equal(b.kind, 'SOW'); assert.equal(b.contractType, 'PUT'); assert.equal(b.dir, -1);
});
test('a candle that is still forming is never used', () => {
  const up = series(100, 103);
  assert.equal(detectFresh(up, G, closeOfLast(up) - 10), null);
});
test('stale events (closed longer ago than the freshness window) are ignored', () => {
  const up = series(100, 103);
  assert.equal(detectFresh(up, G, closeOfLast(up) + 120), null);
  assert.ok(detectFresh(up, G, closeOfLast(up) + 120, 200));
});
test('ordinary candle, short history and bad input give null', () => {
  const calm = series(100, 100.05);
  assert.equal(detectFresh(calm, G, closeOfLast(calm) + 2), null);
  assert.equal(detectFresh(series(100, 103, 20), G, closeOfLast(series(100, 103, 20)) + 2), null);
  assert.equal(detectFresh(null, G, 0), null);
});
test('helpers', () => { assert.equal(contractFor('SOS'), 'CALL'); assert.equal(contractFor('SOW'), 'PUT'); assert.equal(contractFor('x'), null); assert.equal(tfLabel(14400), '4h'); assert.equal(tfLabel(300), '5m'); });
