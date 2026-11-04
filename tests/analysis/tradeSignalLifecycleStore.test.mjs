import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleStore, LIFECYCLE_STORAGE_KEY } from '../../src/analysis/tradeSignalLifecycleStore.js';
import { createLifecycleRegistry, applyRetention, TERMINAL_SNAPSHOT_TTL_SEC, HISTORY_MAX, RECORDS_MAX } from '../../src/analysis/tradeSignalLifecycle.js';
import { createPredictionHistoryStore } from '../../src/analysis/tradeSignalStorage.js';

// Minimal transactional IndexedDB double: atomic commit, optional byte quota, injectable failures.
class FakeIDB {
  constructor({ quotaBytes = Infinity } = {}) { this.dbs = new Map(); this.quotaBytes = quotaBytes; this.failNextWrite = null; this.writes = 0; }
  open(name, version) {
    const request = {};
    queueMicrotask(() => {
      let db = this.dbs.get(name); const upgrade = !db || db.version < version;
      if (!db) { db = this.makeDb(); this.dbs.set(name, db); }
      request.result = db;
      if (upgrade) { db.version = version; request.onupgradeneeded?.(); }
      request.onsuccess?.();
    });
    return request;
  }
  makeDb() {
    const db = { version: 0, stores: new Map(), objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore: (n, o) => db.stores.set(n, { keyPath: o.keyPath, rows: new Map() }), close() {},
      transaction: (n, mode) => this.tx(db, n, mode) };
    return db;
  }
  size(db, name, working) {
    let bytes = 0;
    for (const [n, s] of db.stores) for (const row of (n === name ? working : s.rows).values()) bytes += JSON.stringify(row).length;
    return bytes;
  }
  tx(db, name, mode) {
    const store = db.stores.get(name);
    if (!store) throw new Error('NotFoundError: ' + name);
    const working = new Map(store.rows), t = { error: null }; let aborted = false;
    const abort = (error) => { if (aborted) return; aborted = true; t.error = error; t.onabort?.(); };
    setTimeout(() => {
      if (aborted) return;
      if (mode === 'readwrite') {
        this.writes++;
        if (this.failNextWrite) { const e = this.failNextWrite; this.failNextWrite = null; abort(e); return; }
        if (this.size(db, name, working) > this.quotaBytes) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; abort(e); return; }
        store.rows = working;
      }
      t.oncomplete?.();
    }, 5);
    t.abort = () => abort(new Error('aborted'));
    t.objectStore = () => ({
      getAll: () => { const r = {}; setTimeout(() => { r.result = [...working.values()].map((x) => JSON.parse(JSON.stringify(x))); r.onsuccess?.(); }, 0); return r; },
      put: (row) => { working.set(row[store.keyPath], JSON.parse(JSON.stringify(row))); },
      delete: (key) => { working.delete(key); },
      clear: () => { working.clear(); },
    });
    return t;
  }
  rows(name = 'lifecycle') { return [...this.dbs.get('mfx_prediction_history_v1').stores.get(name).rows.values()]; }
}

const memoryStorage = (initial = {}, { failRemove = false } = {}) => {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => { if (failRemove) throw new Error('remove blocked'); map.delete(k); } };
};
const legacyRecord = (symbol, updatedAt, extra = {}) => ({ key: `${symbol}|scalp`, state: 'Watching', lifecycleHistory: [{ from: 'No Setup', to: 'Watching', at: 1, reason: 'x' }], updatedAt, ...extra });
const legacyPayload = (...records) => ({ [LIFECYCLE_STORAGE_KEY]: JSON.stringify(Object.fromEntries(records.map((r) => [r.key, r]))) });
const profile = { id: 'scalp' };
const sig = (patch = {}) => ({ symbol: 'R_10', dir: 1, status: 'watching', bias: { verdict: 'bullish-lean' }, reason: 'waiting for location', waitingCondition: 'displacement', nearestLevel: 101.5, ...patch });

test('migration: legacy localStorage lifecycle moves to IndexedDB, is verified, then the source is freed', async () => {
  const idb = new FakeIDB(), legacy = memoryStorage(legacyPayload(legacyRecord('R_10', 10), legacyRecord('R_25', 11), legacyRecord('R_50', 12)));
  const store = createLifecycleStore({ indexedDB: idb, legacyStorage: legacy });
  const result = await store.migrateLegacy();
  assert.deepEqual([result.migrated, result.total, result.legacyRemoved], [3, 3, true]);
  assert.equal(idb.rows().length, 3);
  assert.equal(legacy.map.has(LIFECYCLE_STORAGE_KEY), false);
  const registry = createLifecycleRegistry({ store }); await registry.init();
  assert.equal(registry.get('R_25|scalp').state, 'Watching');
});

test('migration interrupted mid-write keeps the source untouched and a retry completes it without duplicates', async () => {
  const idb = new FakeIDB(), legacy = memoryStorage(legacyPayload(legacyRecord('R_10', 10), legacyRecord('R_25', 11)));
  const store = createLifecycleStore({ indexedDB: idb, legacyStorage: legacy });
  idb.failNextWrite = new Error('interrupted');
  await assert.rejects(store.migrateLegacy(), /interrupted/);
  assert.equal(legacy.map.has(LIFECYCLE_STORAGE_KEY), true, 'source data preserved after interruption');
  assert.equal(idb.rows().length, 0, 'atomic transaction left no partial rows');
  const retry = await store.migrateLegacy();
  assert.equal(retry.migrated, 2);
  assert.equal(idb.rows().length, 2);
  assert.equal(legacy.map.has(LIFECYCLE_STORAGE_KEY), false);
});

test('migration is idempotent: repeated or concurrent runs never duplicate and never overwrite a newer record', async () => {
  const idb = new FakeIDB(), payload = legacyPayload(legacyRecord('R_10', 10), legacyRecord('R_25', 11));
  const a = createLifecycleStore({ indexedDB: idb, legacyStorage: memoryStorage(payload, { failRemove: true }) });
  const b = createLifecycleStore({ indexedDB: idb, legacyStorage: memoryStorage(payload, { failRemove: true }) });
  const [ra] = await Promise.all([a.migrateLegacy(), b.migrateLegacy()]);
  assert.equal(ra.legacyRemoved, false, 'removal failure is tolerated');
  assert.equal(idb.rows().length, 2);
  await a.write({ put: [legacyRecord('R_10', 99, { state: 'Approaching Location' })] });
  const c = createLifecycleStore({ indexedDB: idb, legacyStorage: memoryStorage(payload) });
  const again = await c.migrateLegacy();
  assert.equal(again.migrated, 0, 'nothing newer to import');
  assert.equal(idb.rows().length, 2);
  assert.equal(idb.rows().find((r) => r.key === 'R_10|scalp').state, 'Approaching Location', 'newer IndexedDB record kept');
});

test('migration rejects malformed legacy data without touching it', async () => {
  const legacy = memoryStorage({ [LIFECYCLE_STORAGE_KEY]: '{not json' });
  const store = createLifecycleStore({ indexedDB: new FakeIDB(), legacyStorage: legacy });
  await assert.rejects(store.migrateLegacy(), /malformed/);
  assert.equal(legacy.map.get(LIFECYCLE_STORAGE_KEY), '{not json');
});

test('Prediction History and lifecycle share one database without interfering', async () => {
  const idb = new FakeIDB(), legacy = memoryStorage();
  const history = createPredictionHistoryStore({ indexedDB: idb, legacyStorage: legacy });
  const lifecycle = createLifecycleStore({ indexedDB: idb, legacyStorage: legacy });
  await history.add([{ id: 'p1', state: 'correct', expiresAt: 5 }]);
  await lifecycle.write({ put: [legacyRecord('R_10', 1)] });
  assert.equal((await history.load()).length, 1);
  assert.equal((await lifecycle.loadAll()).length, 1);
  assert.equal(idb.dbs.size, 1);
});

test('full IndexedDB quota: state stays live, the failure and cause are reported, and the next update retries', async () => {
  const idb = new FakeIDB({ quotaBytes: 0 }), errors = [];
  const store = createLifecycleStore({ indexedDB: idb, legacyStorage: memoryStorage() });
  const registry = createLifecycleRegistry({ store, onPersistChange: (e) => errors.push(e ? e.name + ': ' + e.message : null) });
  await registry.init();
  const s = sig();
  registry.update(s, profile, 100);
  assert.equal(s.lifecycleState, 'Watching');
  assert.equal(s.waitingCondition, 'displacement');
  assert.equal(s.nearestLevel, 101.5);
  await registry.flush();
  assert.match(registry.persistenceError.message, /quota/);
  assert.deepEqual(errors, ['QuotaExceededError: The quota has been exceeded.']);
  const s2 = sig();
  registry.update(s2, profile, 160);
  assert.equal(s2.lifecycleState, 'Watching', 'live state keeps advancing in memory while storage is full');
  await registry.flush();
  idb.quotaBytes = Infinity;
  registry.update(sig(), profile, 220);
  await registry.flush();
  assert.equal(registry.persistenceError, null);
  assert.equal(errors[errors.length - 1], null, 'recovery is reported');
  assert.equal(idb.rows().length, 1);
  assert.equal(idb.rows()[0].lifecycleHistory.length, 2);
});

test('limited IndexedDB quota falls back to compact records and still persists', async () => {
  const idb = new FakeIDB({ quotaBytes: 30000 });
  const store = createLifecycleStore({ indexedDB: idb, legacyStorage: memoryStorage() });
  const registry = createLifecycleRegistry({ store }); await registry.init();
  const heavy = { evidenceSnapshot: Array.from({ length: 300 }, (_, i) => ({ sequenceNumber: i, label: 'x'.repeat(60) })) };
  for (let i = 0; i < 6; i++) registry.update(sig({ symbol: 'M' + i, ...heavy }), profile, 100);
  await registry.flush();
  assert.equal(registry.persistenceError, null);
  assert.equal(idb.rows().length, 6);
  assert.ok(idb.rows().every((r) => r.evidenceSnapshot === undefined), 'pre-entry records persisted without bulky evidence');
  const reloaded = createLifecycleRegistry({ store }); await reloaded.init();
  assert.equal(reloaded.get('M3|scalp').state, 'Watching');
});

test('state survives reload through IndexedDB', async () => {
  const idb = new FakeIDB(), legacy = memoryStorage();
  const first = createLifecycleRegistry({ store: createLifecycleStore({ indexedDB: idb, legacyStorage: legacy }) }); await first.init();
  first.update(sig(), profile, 100); first.update(sig(), profile, 160); await first.flush();
  const second = createLifecycleRegistry({ store: createLifecycleStore({ indexedDB: idb, legacyStorage: legacy }) }); await second.init();
  assert.equal(second.get('R_10|scalp').state, 'Watching');
  second.update(sig(), profile, 220); await second.flush();
  assert.equal(idb.rows().length, 1);
});

test('retention: old terminal records drop frozen snapshots, history is capped, the registry is bounded', async () => {
  const old = { key: 'R_10|scalp', state: 'Closed', updatedAt: 1000, evidenceSnapshot: [{ a: 1 }], inducementEvents: [{ b: 1 }], familyValues: [{ c: 1 }], entry: { d: 1 }, bias: { e: 1 }, lifecycleHistory: [] };
  assert.equal(applyRetention({ ...old }, 1000 + TERMINAL_SNAPSHOT_TTL_SEC - 1), false);
  const pruned = { ...old };
  assert.equal(applyRetention(pruned, 1000 + TERMINAL_SNAPSHOT_TTL_SEC), true);
  assert.equal(pruned.evidenceSnapshot, undefined);
  assert.equal(pruned.state, 'Closed');
  const active = { ...old, state: 'Signal Active' };
  assert.equal(applyRetention(active, 1e9), false, 'active records are never pruned');
  const long = { key: 'k', state: 'Watching', updatedAt: 1, lifecycleHistory: Array.from({ length: HISTORY_MAX + 50 }, (_, i) => ({ at: i })) };
  applyRetention(long, 2);
  assert.equal(long.lifecycleHistory.length, HISTORY_MAX);
  assert.equal(long.lifecycleHistory[HISTORY_MAX - 1].at, HISTORY_MAX + 49);

  const idb = new FakeIDB(), store = createLifecycleStore({ indexedDB: idb, legacyStorage: memoryStorage() });
  await store.write({ put: Array.from({ length: RECORDS_MAX + 20 }, (_, i) => ({ key: `S${i}|scalp`, state: 'Expired Without Entry', updatedAt: i, lifecycleHistory: [] })) });
  const registry = createLifecycleRegistry({ store, nowSec: () => 5 }); await registry.init();
  registry.update(sig({ symbol: 'LIVE' }), profile, 5); await registry.flush();
  assert.ok(idb.rows().length <= RECORDS_MAX);
  assert.ok(idb.rows().some((r) => r.key === 'LIVE|scalp'), 'the live record is kept');
  assert.equal(idb.rows().some((r) => r.key === 'S0|scalp'), false, 'oldest terminal records are dropped first');
});
