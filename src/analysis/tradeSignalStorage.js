// Prediction History uses one IndexedDB archive. Browser localStorage is read only as a migration source.
export const ARCHIVE_KEY = 'mfx_ts_archive_v1';
export const PREDICTION_HISTORY_DB = 'mfx_prediction_history_v1';
export const PREDICTION_HISTORY_VERSION = 1;
export const PREDICTION_HISTORY_STORE = 'records';

export function migrateLegacyRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (record.resolution_method) return { ...record };
  return { ...record, model_id: record.model_id ?? null, model_context: record.model_context ?? null,
    familyValues: record.familyValues ?? null, overallBalance: record.overallBalance ?? null, resolution_method: 'legacy-scan-sample' };
}

function recordKey(record, index = 0) {
  if (record.id != null && String(record.id)) return `id:${record.id}`;
  if (record.symbol && record.openedAt != null && record.expiresAt != null) return `legacy-record:${record.symbol}|${record.profile || ''}|${record.openedAt}|${record.expiresAt}|${record.entry ?? ''}`;
  const serialized = JSON.stringify(record);
  let hash = 2166136261;
  for (let i = 0; i < serialized.length; i++) { hash ^= serialized.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `legacy:${(hash >>> 0).toString(16)}`;
}

export function migrateArchiveRecords(records = []) {
  const migrated = [], positions = new Map();
  for (const [index, original] of (Array.isArray(records) ? records : []).entries()) {
    if (!original || typeof original !== 'object') continue;
    const record = migrateLegacyRecord(original), key = recordKey(record, index);
    if (positions.has(key)) {
      const existing = positions.get(key);
      migrated[existing] = { ...migrated[existing], ...record };
    } else { positions.set(key, migrated.length); migrated.push(record); }
  }
  return migrated;
}

function mergePreserving(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null && merged[key] != null) continue;
    if (['state', 'hit', 'last', 'resolvedAt', 'exitAt', 'resolution_method', 'entry', 'openedAt', 'expiresAt'].includes(key) && merged[key] != null) continue;
    merged[key] = value;
  }
  return merged;
}

export function mergeArchiveRecords(existing = [], incoming = []) {
  const merged = migrateArchiveRecords(existing), positions = new Map();
  merged.forEach((record, index) => positions.set(recordKey(record, index), index));
  for (const [index, original] of incoming.entries()) {
    if (!original || typeof original !== 'object') continue;
    const record = migrateLegacyRecord(original), key = recordKey(record, index);
    if (positions.has(key)) {
      const target = positions.get(key); merged[target] = mergePreserving(merged[target], record);
    } else { positions.set(key, merged.length); merged.push(record); }
  }
  return merged;
}

// Compatibility reader for legacy-only consumers/tests. It never mutates or deletes the source archive.
export function loadArchive(storage = globalThis.localStorage) {
  try {
    const records = JSON.parse(storage?.getItem(ARCHIVE_KEY) || '[]');
    return Array.isArray(records) ? migrateArchiveRecords(records) : [];
  } catch { return []; }
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

export function createPredictionHistoryStore({ indexedDB = globalThis.indexedDB, legacyStorage = globalThis.localStorage } = {}) {
  let dbPromise = null, migrationPromise = null;
  function open() {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB is unavailable; Prediction History was not modified'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PREDICTION_HISTORY_DB, PREDICTION_HISTORY_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PREDICTION_HISTORY_STORE)) db.createObjectStore(PREDICTION_HISTORY_STORE, { keyPath: 'storageKey' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { dbPromise = null; reject(request.error || new Error('Prediction History database open failed')); };
      request.onblocked = () => { dbPromise = null; reject(new Error('Prediction History database upgrade was blocked')); };
    });
    return dbPromise;
  }

  function readAll(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PREDICTION_HISTORY_STORE, 'readonly'), request = tx.objectStore(PREDICTION_HISTORY_STORE).getAll();
      let rows;
      request.onsuccess = () => { rows = request.result; };
      request.onerror = () => { try { tx.abort(); } catch {} reject(request.error || new Error('Prediction History read failed')); };
      tx.oncomplete = () => resolve(rows || []);
      tx.onerror = () => reject(tx.error || new Error('Prediction History read transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Prediction History read transaction aborted'));
    });
  }

  function mergeInTransaction(db, records) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PREDICTION_HISTORY_STORE, 'readwrite'), store = tx.objectStore(PREDICTION_HISTORY_STORE);
      let mergedKeys = [], failure = null;
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const existing = (request.result || []).map(({ storageKey, ...record }) => record);
          const merged = mergeArchiveRecords(existing, records);
          const byKey = new Map();
          for (const [index, record] of merged.entries()) byKey.set(recordKey(record, index), record);
          store.clear();
          mergedKeys = [...byKey.keys()];
          for (const [storageKey, record] of byKey) store.put({ ...record, storageKey });
        } catch (error) { failure = error; try { tx.abort(); } catch {} reject(error); }
      };
      request.onerror = () => { try { tx.abort(); } catch {} reject(request.error || new Error('Prediction History merge read failed')); };
      tx.oncomplete = () => resolve(mergedKeys);
      tx.onerror = () => reject(tx.error || new Error('Prediction History merge failed'));
      tx.onabort = () => reject(failure || tx.error || new Error('Prediction History merge aborted'));
    });
  }

  async function migrateLegacy() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      let raw = null, legacy = [];
      try { raw = legacyStorage?.getItem(ARCHIVE_KEY) ?? null; }
      catch (error) { throw new Error(`Could not read legacy Prediction History: ${error.message}`); }
      if (raw != null && raw !== '') {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { throw new Error('Legacy Prediction History is malformed; source data was preserved'); }
        if (!Array.isArray(parsed)) throw new Error('Legacy Prediction History is not an array; source data was preserved');
        legacy = migrateArchiveRecords(parsed);
      }
      const db = await open();
      if (legacy.length) await mergeInTransaction(db, legacy);
      const stored = await readAll(db);
      const storedKeys = new Set(stored.map(({ storageKey }) => storageKey));
      for (const [index, record] of legacy.entries()) if (!storedKeys.has(recordKey(record, index))) throw new Error('Legacy Prediction History verification failed; source data was preserved');
      return stored.map(({ storageKey, ...record }) => record);
    })().catch((error) => { migrationPromise = null; throw error; });
    return migrationPromise;
  }

  async function load() {
    await migrateLegacy();
    const db = await open();
    return (await readAll(db)).map(({ storageKey, ...record }) => record);
  }

  async function add(records) {
    const incoming = Array.isArray(records) ? records : [records];
    await migrateLegacy();
    const db = await open();
    await mergeInTransaction(db, incoming);
    return (await readAll(db)).map(({ storageKey, ...record }) => record);
  }

  async function clear() {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PREDICTION_HISTORY_STORE, 'readwrite');
      tx.objectStore(PREDICTION_HISTORY_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Prediction History clear failed'));
      tx.onabort = () => reject(tx.error || new Error('Prediction History clear aborted'));
    });
    try { legacyStorage?.removeItem(ARCHIVE_KEY); } catch (error) { throw new Error(`Prediction History was cleared in IndexedDB but legacy archive cleanup failed: ${error.message}`); }
    migrationPromise = null;
  }

  return { open, load, add, clear, migrateLegacy };
}

export const predictionHistoryStore = createPredictionHistoryStore();
