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

test('lifecycle persists evidence snapshots and invalidates a triggered model before entry', () => {
  const storage = memoryStorage(), registry = createLifecycleRegistry({ storage });
  registry.load();
  const snapshot = [{ sequenceNumber: 1, label: 'pivot' }];
  registry.update(sig({ evidenceSnapshot: snapshot, entry: { verdict: 'bullish-lean', balance: 0.4 }, inducementEvents: [{ state: 'confirmed' }] }), profile, 100);
  assert.deepEqual(registry.get('R_10|scalp').evidenceSnapshot, snapshot);
  assert.deepEqual(registry.get('R_10|scalp').entry, { verdict: 'bullish-lean', balance: 0.4 });
  const located = sig({ status: 'watching', layers: { location: { status: 'Approaching Location', evidence: [] } }, primaryModel: { model_id: 'F' }, evidenceSnapshot: snapshot });
  registry.update(located, profile, 110);
  assert.equal(registry.get('R_10|scalp').state, 'Trigger Detected');
  registry.update(sig({ status: 'watching', layers: { location: { status: 'Approaching Location', evidence: [] } }, reason: 'protected level failed' }), profile, 120);
  assert.equal(registry.get('R_10|scalp').state, 'Invalidated Before Entry');
  assert.match(registry.get('R_10|scalp').lifecycleHistory.at(-1).reason, /no longer qualifies/);
  const reloaded = createLifecycleRegistry({ storage }); reloaded.load();
  assert.deepEqual(reloaded.get('R_10|scalp').evidenceSnapshot, snapshot);
  assert.deepEqual(reloaded.get('R_10|scalp').entry, { verdict: 'bullish-lean', balance: 0.4 });
});

test('an opposing bias terminalizes an approaching setup', () => {
  const registry = createLifecycleRegistry({ storage: memoryStorage() }); registry.load();
  registry.update(sig(), profile, 100);
  registry.update(sig({ layers: { location: { status: 'Approaching Location', evidence: [] } }, primaryModel: { model_id: 'B' } }), profile, 110);
  registry.update(sig({ status: 'wait', dir: -1, reason: 'entry context opposes bias' }), profile, 120);
  assert.equal(registry.get('R_10|scalp').state, 'Opposed');
});


test('entry qualification snapshot freezes at Trigger Detected through later scans and reload', () => {
  const storage = memoryStorage(), registry = createLifecycleRegistry({ storage });
  registry.load();
  registry.update(sig(), profile, 100);
  const located = sig({ layers: { location: { status: 'Approaching Location', evidence: [{ price: 99 }] } } });
  registry.update(located, profile, 110);
  const trigger = sig({ status: 'watching', dir: 1, detectedAt: 109, confirmedAt: 108, price: 100,
    entry: { verdict: 'bullish-lean', balance: 0.6 }, overallBalance: 0.6,
    familyValues: [{ family: 'liquidity', value: 0.8 }], primaryModel: { model_id: 'F', context: 'trend' },
    secondaryModels: [{ model_id: 'G' }], target: { price: 105 }, invalidation: { price: 95 },
    trigger: { kind: 'model', label: 'confirmed inducement' }, entryG: 180,
    inducementEvents: [{ state: 'confirmed', sweepIndex: 5 }], evidenceSnapshot: [{ occurredAt: 105, confirmedAt: 108, label: 'sweep' }],
    layers: { location: { status: 'Approaching Location', evidence: [{ price: 99 }] } } });
  registry.update(trigger, profile, 120);
  assert.equal(registry.get('R_10|scalp').state, 'Trigger Detected');
  assert.equal(registry.get('R_10|scalp').entryFrozenAt, 120);
  const keys = ['direction', 'entry', 'overallBalance', 'familyValues', 'primaryModel', 'secondaryModels', 'target', 'invalidation',
    'trigger', 'entryG', 'price', 'confirmedAt', 'detectedAt', 'model_id', 'model_context', 'inducementEvents', 'evidenceSnapshot'];
  const frozen = Object.fromEntries(keys.map((key) => [key, JSON.parse(JSON.stringify(registry.get('R_10|scalp')[key]))]));
  const later = sig({ status: 'signal', dir: -1, detectedAt: 999, confirmedAt: 998, price: 120,
    entry: { verdict: 'bearish-lean', balance: -0.9 }, overallBalance: -0.9, familyValues: [{ family: 'structure', value: -1 }],
    primaryModel: { model_id: 'A', context: 'swing' }, secondaryModels: [], target: { price: 80 }, invalidation: { price: 130 },
    trigger: { kind: 'model', label: 'different later trigger' }, entryG: 900, inducementEvents: [{ state: 'invalid' }], evidenceSnapshot: [{ label: 'later' }],
    layers: { location: { status: 'Approaching Location', evidence: [] } } });
  registry.update(later, profile, 130);
  assert.equal(registry.get('R_10|scalp').state, 'Signal Active');
  assert.deepEqual(Object.fromEntries(keys.map((key) => [key, registry.get('R_10|scalp')[key]])), frozen);
  const reloaded = createLifecycleRegistry({ storage }); reloaded.load();
  assert.deepEqual(Object.fromEntries(keys.map((key) => [key, reloaded.get('R_10|scalp')[key]])), frozen);
});
