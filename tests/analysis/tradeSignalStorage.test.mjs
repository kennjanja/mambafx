import test from 'node:test';
import assert from 'node:assert/strict';
import { createPredictionHistoryStore, mergeArchiveRecords, ARCHIVE_KEY, PREDICTION_HISTORY_STORE } from '../../src/analysis/tradeSignalStorage.js';
import { openTracked, updateTracked } from '../../src/analysis/tradeSignalTracker.js';
import { createLifecycleRegistry } from '../../src/analysis/tradeSignalLifecycle.js';

class FakeIndexedDB {
  databases = new Map();
  failNextPut = false;
  open(name) {
    const request = {};
    queueMicrotask(() => {
      let db = this.databases.get(name);
      if (!db) {
        db = { stores: new Map(), objectStoreNames: { contains: (key) => db.stores.has(key) },
          createObjectStore: (key, options) => db.stores.set(key, { options, rows: new Map() }),
          transaction: (storeName, mode) => this.makeTransaction(db, storeName, mode) };
        request.result = db;
        this.databases.set(name, db);
        request.onupgradeneeded?.();
      } else request.result = db;
      request.onsuccess?.();
    });
    return request;
  }
  makeTransaction(db, storeName, mode) {
    let rows = new Map(db.stores.get(storeName).rows), aborted = false;
    const tx = { error: null,
      objectStore: () => ({
        getAll: () => {
          const req = {};
          setTimeout(() => {
            if (aborted) return;
            req.result = [...rows.values()].map((x) => ({ ...x }));
            req.onsuccess?.();
            if (aborted) return;
            if (mode === 'readwrite') db.stores.get(storeName).rows = rows;
            tx.oncomplete?.();
          }, 0);
          return req;
        },
        clear: () => rows.clear(),
        put: (record) => { if (this.failNextPut) { this.failNextPut = false; throw new Error('injected interruption'); } rows.set(record.storageKey, { ...record }); },
      }),
      abort: () => { if (!aborted) { aborted = true; tx.error = new Error('aborted'); tx.onabort?.(); } },
    };
    return tx;
  }
}
function storageWith(records) {
  const map = new Map([[ARCHIVE_KEY, JSON.stringify(records)]]);
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) };
}

test('IndexedDB migration preserves legacy content and verifies data without deleting source', async () => {
  const original = [{ id: 'legacy-1', symbol: 'R_10', openedAt: 12, expiresAt: 42, state: 'wrong', last: 99, rule: 'hold', primaryModel: { model_id: 'A' }, lifecycleHistory: [{ at: 11 }] }];
  const legacyStorage = storageWith(original), store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage });
  const migrated = await store.load();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].resolution_method, 'legacy-scan-sample');
  assert.equal(migrated[0].state, 'wrong'); assert.equal(migrated[0].openedAt, 12); assert.deepEqual(migrated[0].primaryModel, original[0].primaryModel);
  assert.equal(migrated[0].model_id, null); assert.equal(migrated[0].familyValues, null);
  assert.equal(legacyStorage.getItem(ARCHIVE_KEY), JSON.stringify(original));
});

test('interrupted migration leaves transaction and localStorage source intact; retry imports once', async () => {
  const original = [{ id: 'legacy-2', state: 'correct', expiresAt: 50 }], legacyStorage = storageWith(original), idb = new FakeIndexedDB();
  const store = createPredictionHistoryStore({ indexedDB: idb, legacyStorage });
  await store.open(); idb.failNextPut = true;
  await assert.rejects(store.migrateLegacy(), /injected interruption/);
  assert.equal(legacyStorage.getItem(ARCHIVE_KEY), JSON.stringify(original));
  const afterRetry = await store.load();
  assert.equal(afterRetry.length, 1); assert.equal(afterRetry[0].state, 'correct');
  assert.equal((await store.load()).length, 1);
});

test('migration retries and duplicate writes deduplicate by ID without losing rich fields', async () => {
  const legacyStorage = storageWith([{ id: 'same', state: 'wrong', target: 101 }]), store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage });
  await store.load();
  await store.add([{ id: 'same', state: 'wrong', model_id: 'G', lifecycleHistory: [{ at: 1 }] }, { id: 'new', state: 'correct' }, { id: 'new', state: 'correct' }]);
  const rows = await store.load();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === 'same').target, 101);
  assert.equal(rows.find((r) => r.id === 'same').model_id, 'G');
  assert.equal(rows.find((r) => r.id === 'same').resolution_method, 'legacy-scan-sample');
});

test('unmappable legacy records are preserved intact and have stable keys', async () => {
  const data = [{ symbol: 'X', state: 'wrong', legacyExtra: { untouched: true } }], legacyStorage = storageWith(data);
  const store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage });
  const rows = await store.load();
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].legacyExtra, { untouched: true });
  assert.equal(rows[0].resolution_method, 'legacy-scan-sample');
  assert.equal(rows[0].model_context, null); assert.equal(rows[0].overallBalance, null);
});

test('unavailable IndexedDB fails explicitly without modifying or discarding legacy records', async () => {
  const raw = [{ id: 'retained', state: 'wrong' }], legacyStorage = storageWith(raw);
  const store = createPredictionHistoryStore({ indexedDB: null, legacyStorage });
  await assert.rejects(store.load(), /IndexedDB is unavailable/);
  assert.equal(legacyStorage.getItem(ARCHIVE_KEY), JSON.stringify(raw));
});

test('duplicate archive writes cannot replace frozen qualification and outcome fields', async () => {
  const store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage: storageWith([]) });
  const original = { id: 'snapshot', state: 'correct', entry: 100, dir: 1, openedAt: 10, expiresAt: 20,
    primaryModel: { model_id: 'A' }, secondaryModels: [{ model_id: 'B' }], qualifyingModelIds: ['A', 'B'],
    evidenceSnapshot: [{ label: 'original' }], entryEvidence: { verdict: 'bullish-lean' },
    familyValues: [{ family: 'liquidity', value: 1 }], lifecycleHistory: [{ at: 10 }], target: 105, invalidation: 98 };
  await store.add([original]);
  await store.add([{ ...original, state: 'wrong', entry: 1, dir: -1,
    primaryModel: { model_id: 'G' }, secondaryModels: [], qualifyingModelIds: ['G'],
    evidenceSnapshot: [{ label: 'changed' }], entryEvidence: { verdict: 'bearish-lean' },
    familyValues: [], lifecycleHistory: [], target: 10, invalidation: 11 }]);
  const [stored] = await store.load();
  for (const key of Object.keys(original)) assert.deepEqual(stored[key], original[key], key);
});

test('duplicate legacy records keep first recorded evidence while retaining missing fields', async () => {
  const original = [
    { id: 'legacy-duplicate', state: 'wrong', primaryModel: { model_id: 'A' }, evidenceSnapshot: [{ label: 'first' }] },
    { id: 'legacy-duplicate', state: 'correct', primaryModel: { model_id: 'B' }, evidenceSnapshot: [{ label: 'second' }], target: 105 },
  ];
  const legacyStorage = storageWith(original);
  const store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage });
  const [stored] = await store.load();
  assert.equal(stored.state, 'wrong');
  assert.deepEqual(stored.primaryModel, original[0].primaryModel);
  assert.deepEqual(stored.evidenceSnapshot, original[0].evidenceSnapshot);
  assert.equal(stored.target, 105);
  assert.equal(legacyStorage.getItem(ARCHIVE_KEY), JSON.stringify(original));
});

test('duplicate archive merges are idempotent and do not replace existing nested snapshots', () => {
  const original = { id: 'same', state: 'correct', primaryModel: { model_id: 'A', events: ['sweep'] },
    evidenceSnapshot: [{ label: 'original' }], entryEvidence: null };
  const incoming = { id: 'same', state: 'wrong', primaryModel: { model_id: 'B' },
    evidenceSnapshot: [{ label: 'changed' }], entryEvidence: { verdict: 'bullish-lean' } };
  const once = mergeArchiveRecords([original], [incoming]);
  const twice = mergeArchiveRecords(once, [incoming]);
  assert.deepEqual(twice, once);
  assert.deepEqual(once[0].primaryModel, original.primaryModel);
  assert.deepEqual(once[0].evidenceSnapshot, original.evidenceSnapshot);
  assert.deepEqual(once[0].entryEvidence, incoming.entryEvidence);
});

test('legacy enrichment fills null top-level fields but never merges into existing nested snapshots', () => {
  const first = { id: 'legacy', state: 'wrong', primaryModel: { model_id: 'A', detail: null }, evidenceSnapshot: [{ label: 'first' }], entryEvidence: null };
  const later = { id: 'legacy', state: 'correct', primaryModel: { model_id: 'B', detail: 'new' }, evidenceSnapshot: [{ label: 'second' }], entryEvidence: { verdict: 'bullish-lean' } };
  const [merged] = mergeArchiveRecords([first], [later, later]);
  assert.equal(merged.state, 'wrong');
  assert.deepEqual(merged.primaryModel, first.primaryModel);
  assert.deepEqual(merged.evidenceSnapshot, first.evidenceSnapshot);
  assert.deepEqual(merged.entryEvidence, later.entryEvidence);
});

test('active outcome and lifecycle advance before archival while entry snapshots remain frozen', async () => {
  const values = new Map(), storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const registry = createLifecycleRegistry({ storage }); registry.load();
  const signal = { symbol: 'R_10', label: 'R_10', profile: 'scalp', dir: 1, status: 'signal', price: 100, holdSec: 180,
    primaryModel: { model_id: 'A', events: [{ label: 'original' }] }, evidenceSnapshot: [{ label: 'original' }],
    layers: { location: { status: 'Approaching Location', evidence: [] } } };
  registry.update(signal, { id: 'scalp' }, 1000);
  const record = openTracked(signal, 1000);
  signal.primaryModel.events[0].label = 'mutated';
  signal.evidenceSnapshot[0].label = 'mutated';
  assert.equal(registry.get('R_10|scalp').primaryModel.events[0].label, 'original');
  assert.equal(registry.get('R_10|scalp').evidenceSnapshot[0].label, 'original');
  updateTracked(record, { price: 101, nowSec: 1180 });
  assert.equal(record.state, 'correct');
  assert.equal(record.primaryModel.events[0].label, 'original');
  assert.equal(record.evidenceSnapshot[0].label, 'original');
  registry.close('R_10|scalp', 1180);
  assert.equal(registry.get('R_10|scalp').state, 'Closed');
  const store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage: storageWith([]) });
  await store.add([record]);
  await store.add([{ ...record, primaryModel: { model_id: 'B' }, evidenceSnapshot: [{ label: 'conflict' }] }]);
  const [archived] = await store.load();
  assert.equal(archived.state, 'correct');
  assert.equal(archived.primaryModel.events[0].label, 'original');
  assert.equal(archived.evidenceSnapshot[0].label, 'original');
});

test('a resolved duplicate advances an archived open record without replacing its snapshot', () => {
  const [merged] = mergeArchiveRecords([{ id: 'open', state: 'open', last: 100, primaryModel: { model_id: 'A' } }],
    [{ id: 'open', state: 'correct', last: 101, primaryModel: { model_id: 'B' } }]);
  assert.equal(merged.state, 'correct');
  assert.equal(merged.last, 101);
  assert.equal(merged.primaryModel.model_id, 'A');
});

test('resolved outcomes survive stale open writes in both orders and repeated migration', async () => {
  const open = { id: 'same', state: 'open', last: 100, resolvedAt: null, resolutionPending: true,
    primaryModel: { model_id: 'A', events: [{ label: 'first' }] }, evidenceSnapshot: [{ label: 'first' }] };
  const done = { ...open, state: 'correct', last: 101, resolvedAt: 180, resolutionPending: false,
    resolutionIssue: null, resolution_method: 'expiry-tick' };
  for (const [first, second] of [[open, done], [done, open]]) {
    const once = mergeArchiveRecords([first], [second]);
    assert.equal(once[0].state, 'correct');
    assert.equal(once[0].last, 101);
    assert.equal(once[0].resolutionPending, false);
    assert.deepEqual(mergeArchiveRecords(once, [second]), once);
    const legacy = storageWith([first, second, second]);
    const store = createPredictionHistoryStore({ indexedDB: new FakeIndexedDB(), legacyStorage: legacy });
    const rows = await store.load();
    assert.deepEqual(await store.load(), rows);
    assert.equal(rows[0].state, 'correct');
    assert.equal(rows[0].primaryModel.events[0].label, 'first');
  }
});

test('newer lifecycle information advances without replacing frozen evidence', () => {
  const original = { id: 'a', state: 'open', updatedAt: 1, lifecycleState: 'Signal Active',
    lifecycleHistory: [{ at: 1 }], evidenceSnapshot: [{ nested: ['original'] }] };
  const next = { ...original, updatedAt: 2, lifecycleState: 'Closed',
    lifecycleHistory: [{ at: 1 }, { at: 2 }], evidenceSnapshot: [{ nested: ['changed'] }] };
  const [merged] = mergeArchiveRecords([original], [next]);
  assert.equal(merged.lifecycleState, 'Closed');
  assert.deepEqual(merged.lifecycleHistory, next.lifecycleHistory);
  assert.deepEqual(merged.evidenceSnapshot, original.evidenceSnapshot);
  assert.deepEqual(mergeArchiveRecords([merged], [original])[0], merged);
});
