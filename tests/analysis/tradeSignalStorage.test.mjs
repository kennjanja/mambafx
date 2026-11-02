import test from 'node:test';
import assert from 'node:assert/strict';
import { createPredictionHistoryStore, ARCHIVE_KEY, PREDICTION_HISTORY_STORE } from '../../src/analysis/tradeSignalStorage.js';

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
