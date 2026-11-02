// Lifecycle state lives in the same IndexedDB database as Prediction History (separate object store, keyPath 'key').
// localStorage is only a migration source: it is never modified until the migration has been read back and verified.
import { PREDICTION_HISTORY_DB, PREDICTION_HISTORY_VERSION, LIFECYCLE_STORE, ensureStores } from './tradeSignalStorage.js';

export const LIFECYCLE_STORAGE_KEY = 'mfx_ts_lifecycle_v1';

const plain = (record) => JSON.parse(JSON.stringify(record));
const stamp = (record) => (Number.isFinite(record?.updatedAt) ? record.updatedAt : 0);

export function createLifecycleStore({ indexedDB = globalThis.indexedDB, legacyStorage = globalThis.localStorage, legacyKey = LIFECYCLE_STORAGE_KEY } = {}) {
  let dbPromise = null, migrationPromise = null;

  function open() {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB is unavailable; lifecycle state is kept in memory only'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PREDICTION_HISTORY_DB, PREDICTION_HISTORY_VERSION);
      request.onupgradeneeded = () => ensureStores(request.result);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => { dbPromise = null; reject(request.error || new Error('Lifecycle database open failed')); };
      request.onblocked = () => { dbPromise = null; reject(new Error('Lifecycle database upgrade was blocked by another open MambaFX tab')); };
    });
    return dbPromise;
  }

  async function loadAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIFECYCLE_STORE, 'readonly'), request = tx.objectStore(LIFECYCLE_STORE).getAll();
      let rows;
      request.onsuccess = () => { rows = request.result; };
      request.onerror = () => { try { tx.abort(); } catch {} reject(request.error || new Error('Lifecycle read failed')); };
      tx.oncomplete = () => resolve(rows || []);
      tx.onerror = () => reject(tx.error || new Error('Lifecycle read transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Lifecycle read transaction aborted'));
    });
  }

  // One atomic transaction: either every put/delete is applied or none is.
  async function write({ put = [], remove = [] } = {}) {
    if (!put.length && !remove.length) return;
    const rows = put.map(plain), db = await open();
    await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(LIFECYCLE_STORE, 'readwrite');
        const store = tx.objectStore(LIFECYCLE_STORE);
        for (const key of remove) store.delete(key);
        for (const row of rows) store.put(row);
      } catch (error) { try { tx?.abort(); } catch {} reject(error); return; }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Lifecycle write failed'));
      tx.onabort = () => reject(tx.error || new Error('Lifecycle write aborted'));
    });
  }

  function readLegacy() {
    let raw;
    try { raw = legacyStorage?.getItem(legacyKey) ?? null; }
    catch (error) { throw new Error(`Could not read legacy lifecycle state: ${error.message}`); }
    if (raw == null || raw === '') return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Legacy lifecycle state is malformed; source data was preserved'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Legacy lifecycle state is not an object; source data was preserved');
    return Object.entries(parsed).filter(([, record]) => record && typeof record.state === 'string').map(([key, record]) => ({ ...record, key }));
  }

  // Idempotent: keyed by record key, never overwrites a newer stored record, verified by read-back before the source is removed.
  function migrateLegacy() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      const legacy = readLegacy();
      if (!legacy) return { migrated: 0, total: 0, legacyRemoved: false, skipped: true };
      const stored = new Map((await loadAll()).map((record) => [record.key, record]));
      const toPut = legacy.filter((record) => !stored.has(record.key) || stamp(stored.get(record.key)) < stamp(record));
      if (toPut.length) await write({ put: toPut });
      const verified = new Map((await loadAll()).map((record) => [record.key, record]));
      for (const record of legacy) {
        const found = verified.get(record.key);
        if (!found || stamp(found) < stamp(record)) throw new Error('Legacy lifecycle verification failed; source data was preserved');
      }
      let legacyRemoved = false;
      try { legacyStorage.removeItem(legacyKey); legacyRemoved = true; } catch { /* leaving the source is harmless: re-migration is a no-op */ }
      return { migrated: toPut.length, total: legacy.length, legacyRemoved, skipped: false };
    })().catch((error) => { migrationPromise = null; throw error; });
    return migrationPromise;
  }

  return { open, loadAll, write, migrateLegacy };
}

let defaultStore = null;
export function defaultLifecycleStore() {
  if (!defaultStore) defaultStore = createLifecycleStore();
  return defaultStore;
}
