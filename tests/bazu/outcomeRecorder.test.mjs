import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutcomeRecorder } from '../../src/bazu/outcomeRecorder3m.js';

const pred = (at, over = {}) => ({ decisionTs: at, wait: true, direction: 0, playbook: null, strength: 0.5, regime: { type: 'trend' }, breakoutState: { state: 'confirmed', direction: 1, edge: 100, strength: {}, confirmation: {}, context: {} }, breakoutFilters: { penetration: { pass: true }, tickFlow: { pass: false }, intensity: { pass: null } }, ...over });
const series = (n) => ({ prices: Array.from({ length: n }, (_, i) => 100 + i), epochs: Array.from({ length: n }, (_, i) => 1000 + i) });

test('records at prediction time and scores horizons with next-tick entry', () => {
  const rec = createOutcomeRecorder(); const s = series(40);
  const row = rec.observe('R_10', pred(1009), s.prices.slice(0, 10), s.epochs.slice(0, 10));
  assert.equal(row[0].filters.tickFlow, 'fail'); assert.equal(row[0].filters.intensity, 'n/a'); assert.equal(row[0].eligible, false);
  rec.resolve('R_10', s.prices, s.epochs);
  assert.equal(rec.all()[0].outcome.entry, 110);
  assert.equal(rec.all()[0].outcome.h[20], 'win');
  assert.equal(rec.report().confirmed.horizons[5].accuracy, 1);
});

test('partial maturity leaves long horizons null and later resolves', () => {
  const rec = createOutcomeRecorder(); const s = series(40);
  rec.observe('R_10', pred(1009), s.prices.slice(0, 10), s.epochs.slice(0, 10));
  rec.resolve('R_10', s.prices.slice(0, 15), s.epochs.slice(0, 15));
  assert.equal(rec.all()[0].outcome.h[20], null);
  rec.resolve('R_10', s.prices, s.epochs);
  assert.equal(rec.all()[0].outcome.h[20], 'win');
});

test('ties count as incorrect and dedupe applies', () => {
  const rec = createOutcomeRecorder(); const flat = { prices: Array(40).fill(100), epochs: Array.from({ length: 40 }, (_, i) => 1000 + i) };
  assert.ok(rec.observe('R_10', pred(1009), flat.prices.slice(0, 10), flat.epochs.slice(0, 10)));
  assert.equal(rec.observe('R_10', pred(1010), flat.prices.slice(0, 11), flat.epochs.slice(0, 11)), null);
  rec.resolve('R_10', flat.prices, flat.epochs);
  assert.equal(rec.all()[0].outcome.h[1], 'tie');
  assert.equal(rec.report().confirmed.horizons[1].accuracy, 0);
});

test('eligible flag separates real signals; no direction means no row', () => {
  const rec = createOutcomeRecorder(); const s = series(10);
  assert.equal(rec.observe('R_10', pred(1009, { breakoutState: { state: 'approaching', direction: 0 } }), s.prices, s.epochs), null);
  const r = rec.observe('R_10', pred(1009, { wait: false, direction: 1, playbook: 'breakout' }), s.prices, s.epochs);
  assert.equal(r[0].eligible, true);
});

test('records every playbook, including gated candidates', () => {
  const rec = createOutcomeRecorder(); const s = series(40);
  const p = { decisionTs: 1009, wait: true, direction: 1, playbook: 'range fade', strength: 0.8, vetoes: ['rr'], breakoutState: null };
  const rows = rec.observe('R_10', p, s.prices.slice(0, 10), s.epochs.slice(0, 10));
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'playbook'); assert.equal(rows[0].eligible, false);
  rec.resolve('R_10', s.prices, s.epochs);
  const rep = rec.report({ kind: 'playbook', groupBy: (r) => r.playbook });
  assert.equal(rep['range fade'].horizons[5].accuracy, 1);
  assert.deepEqual(rec.report({ kind: 'playbook', eligibleOnly: true, groupBy: (r) => r.playbook }), {});
});
