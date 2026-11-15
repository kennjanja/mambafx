// Separate from research observations and from every other trading module.
export async function openExecutionStore({ indexedDB = globalThis.indexedDB, name = "super-mathes-trading-v1" } = {}) {
  if (!indexedDB) throw new Error("IndexedDB is unavailable");
  const opened = indexedDB.open(name, 1);
  opened.onupgradeneeded = event => event.target.result.createObjectStore("accounts", { keyPath: "accountId" });
  const db = await new Promise((resolve, reject) => {
    opened.onsuccess = () => resolve(opened.result);
    opened.onerror = () => reject(opened.error || new Error("Trading database could not be opened"));
    opened.onblocked = () => reject(new Error("Trading database upgrade is blocked by another tab"));
  });
  db.onversionchange = () => db.close();
  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("accounts", mode);
      let result;
      try {
        const request = action(tx.objectStore("accounts"));
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error("Trading database request failed"));
      } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("Trading database transaction aborted"));
      tx.onerror = () => {};
    });
  }
  return {
    async load(accountId) {
      if (typeof accountId !== "string" || !accountId) throw new Error("Trading account is required");
      return transaction("readonly", store => store.get(accountId));
    },
    async save(state) {
      if (!state || typeof state.accountId !== "string" || !state.accountId) throw new Error("Trading account is required");
      await transaction("readwrite", store => store.put(state));
    },
    close() { db.close(); },
  };
}
