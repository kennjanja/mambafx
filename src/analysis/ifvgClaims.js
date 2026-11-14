import { PREDICTION_HISTORY_DB, PREDICTION_HISTORY_VERSION, LIFECYCLE_STORE, ensureStores } from './tradeSignalStorage.js?v=4';

// A durable atomic claim prevents two tabs or a reload buying the same first retest.
// A failed or uncertain order remains claimed rather than risking a duplicate order.
export function claimInverseFvg({ symbol, granularity, formationEpoch, retestUntil }, indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.reject(new Error('IndexedDB unavailable; inverse FVG trade blocked.'));
  if (!symbol || !Number.isInteger(granularity) || !Number.isFinite(formationEpoch) || !Number.isFinite(retestUntil))
    return Promise.reject(new Error('Inverse FVG identity unavailable; trade blocked.'));
  if (Math.floor(Date.now() / 1000) >= retestUntil)
    return Promise.reject(new Error('The first inverse FVG retest window has ended.'));
  const key = `ifvg-claim|${symbol}|${granularity}|${formationEpoch}`;
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    try { request = indexedDB.open(PREDICTION_HISTORY_DB, PREDICTION_HISTORY_VERSION); }
    catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction.abort(); return; }
      try { ensureStores(request.result, request.transaction); }
      catch (error) { request.transaction.abort(); fail(error); }
    };
    request.onerror = () => fail(request.error || new Error('Could not open inverse FVG claim store.'));
    request.onblocked = () => fail(new Error('Inverse FVG claim store upgrade blocked.'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      try {
        const tx = db.transaction(LIFECYCLE_STORE, 'readwrite');
        const store = tx.objectStore(LIFECYCLE_STORE);
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (row.value.key?.startsWith('ifvg-claim|') && row.value.expiresAt <= Math.floor(Date.now() / 1000))
            row.delete();
          row.continue();
        };
        store.add({ key, expiresAt: retestUntil });
        tx.oncomplete = () => { db.close(); if (!settled) { settled = true; resolve(); } };
        tx.onabort = () => { const error = tx.error; db.close(); fail(error || new Error('Inverse FVG claim could not be saved.')); };
      } catch (error) { db.close(); fail(error); }
    };
  });
}
