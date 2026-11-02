import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleRegistry, LIFECYCLE_STORAGE_KEY } from '../../src/analysis/tradeSignalLifecycle.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
const profile = { id: 'scalp' };
const sig = (patch = {}) => ({ symbol: 'R_10', dir: 1, status: 'watching', bias: { verdict: 'bullish-lean' }, reason: 'waiting for location', ...patch });

test('repeated scans and reload resume one lifecycle record without duplicate active setups', () => {
  const storage = memoryStorage(), first = createLifecycleRegistry({ storage });
  first.load();
  first.update(sig(), profile, 100);
  first.update(sig(), profile, 110);
  assert.equal(first.list().length, 1);
  assert.equal(first.get('R_10|scalp').state, 'Watching');
  const reloaded = createLifecycleRegistry({ storage });
  reloaded.load(); reloaded.update(sig(), profile, 120);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get('R_10|scalp').lifecycleHistory.length, 2);
  assert.equal(reloaded.get('R_10|scalp').lifecycleHistory[0].at, 100);
});

test('lifecycle state survives page navigation by reloading its persistence key', () => {
  const storage = memoryStorage(), a = createLifecycleRegistry({ storage });
  a.load(); a.update(sig(), profile, 100);
  assert.ok(storage.getItem(LIFECYCLE_STORAGE_KEY));
  const b = createLifecycleRegistry({ storage }); b.load();
  assert.equal(b.get('R_10|scalp').state, 'Watching');
  assert.equal(b.get('R_10|scalp').waitingCondition, 'waiting for location');
});

test('profile watching expiry records terminal state and repeated scans cannot reopen it', () => {
  const storage = memoryStorage(), registry = createLifecycleRegistry({ storage });
  registry.load(); registry.update(sig(), profile, 100);
  registry.update(sig(), profile, 100 + 900);
  assert.equal(registry.get('R_10|scalp').state, 'Expired Without Entry');
  const before = registry.get('R_10|scalp').lifecycleHistory;
  const later = sig({ status: 'signal', primaryModel: { model_id: 'A' } });
  registry.update(later, profile, 2000);
  assert.equal(registry.get('R_10|scalp').state, 'Expired Without Entry');
  assert.deepEqual(later.lifecycleHistory, before);
});

test('active signal closes once and terminal Closed state is not reopened', () => {
  const storage = memoryStorage(), registry = createLifecycleRegistry({ storage });
  registry.load();
  registry.update(sig({ status: 'signal', primaryModel: { model_id: 'B' }, layers: { location: { status: 'Approaching Location', evidence: [] } } }), profile, 100);
  assert.equal(registry.get('R_10|scalp').state, 'Signal Active');
  registry.close('R_10|scalp', 280);
  registry.close('R_10|scalp', 300);
  const before = registry.get('R_10|scalp').lifecycleHistory;
  registry.update(sig({ status: 'signal', primaryModel: { model_id: 'A' } }), profile, 400);
  assert.equal(registry.get('R_10|scalp').state, 'Closed');
  assert.deepEqual(registry.get('R_10|scalp').lifecycleHistory, before);
});

test('persistence errors are surfaced and not swallowed', () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const registry = createLifecycleRegistry({ storage }); registry.load();
  assert.throws(() => registry.update(sig(), profile, 100), /quota/);
  assert.equal(registry.get('R_10|scalp').state, 'Watching');
  assert.match(registry.persistenceError.message, /quota/);
});
