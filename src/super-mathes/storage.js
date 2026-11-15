import { SequenceLedger } from "./data.js";
import { createResearchPrediction, markUnscorable, observePrediction } from "./recurrence.js";

const STORES = ["sources", "observations", "predictions", "reports", "settings"];
const pending = row => row.status !== "Unscorable" && row.observations.length < 5;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function transaction(db, mode, action) {
  const tx = db.transaction(STORES, mode);
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => {};
  });
  return (async () => {
    try {
      const result = await action(tx);
      await finished;
      return result;
    } catch (error) {
      try { tx.abort(); } catch (_) { /* Transaction has already finished. */ }
      await finished.catch(() => {});
      throw error;
    }
  })();
}

function restoreRecord(row) {
  let record = createResearchPrediction({
    ...row.prediction,
    hazards: row.prediction.recurrence.hazards,
  });
  for (const observation of row.observations) record = observePrediction(record, observation);
  if (row.status === "Unscorable") record = markUnscorable(record);
  if (record.status !== row.status || record.appearancePosition !== row.appearancePosition) {
    throw new Error("Corrupt prediction lifecycle record");
  }
  return record;
}

async function invalidatePending(tx, state, reason) {
  const store = tx.objectStore("predictions");
  const rows = await Promise.all(state.pending.map(id => request(store.get(id))));
  for (const row of rows) {
    if (!row || row.source !== state.source || !pending(row)) throw new Error("Corrupt pending prediction index");
    const invalid = markUnscorable(restoreRecord(row));
    store.put({ ...row, ...invalid, interruptionReason: reason });
  }
  state.pending = [];
  state.connected = false;
}

export async function openResearchStore({ indexedDB = globalThis.indexedDB, name = "super-mathes-v1" } = {}) {
  if (!indexedDB) throw new Error("IndexedDB is unavailable");
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = event => {
    const db = event.target.result;
    db.createObjectStore("sources", { keyPath: "source" });
    const observations = db.createObjectStore("observations", { keyPath: ["source", "epoch"] });
    observations.createIndex("source", "source");
    const predictions = db.createObjectStore("predictions", { keyPath: "id" });
    predictions.createIndex("source", "source");
    predictions.createIndex("history", ["source", "createdAt", "id"]);
    const reports = db.createObjectStore("reports", { keyPath: "id" });
    reports.createIndex("source", "source");
    reports.createIndex("history", ["source", "createdAt", "id"]);
    db.createObjectStore("settings", { keyPath: "key" });
  };
  const db = await request(open);
  db.onversionchange = () => db.close();
  return new ResearchStore(db);
}

export class ResearchStore {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }

  append(input, { discontinuity = false, historical = false } = {}) {
    if (typeof input.rawQuote !== "string" || !/^-?\d+(?:\.\d+)?$/.test(input.rawQuote)) throw new Error("Original quote is required");
    const [whole, fraction = ""] = input.rawQuote.split(".");
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 20 || fraction.length > input.decimals ||
        input.quote !== whole + (input.decimals ? "." + fraction.padEnd(input.decimals, "0") : "")) throw new Error("Original quote and precision do not match");
    const ledger = new SequenceLedger(input.source);
    const validated = ledger.append(input);
    return transaction(this.db, "readwrite", async tx => {
      const sources = tx.objectStore("sources"), observations = tx.objectStore("observations");
      const [existing, stored] = await Promise.all([
        request(observations.get([validated.source, validated.epoch])),
        request(sources.get(validated.source)),
      ]);
      if (existing) {
        if (existing.quote !== validated.quote || existing.decimals !== validated.decimals || existing.rawQuote !== input.rawQuote) throw new Error("Conflicting observation at the same timestamp");
        if (stored && stored.connected) {
          await invalidatePending(tx, stored, "Ambiguous repeated timestamp");
          sources.put(stored);
        }
        return { duplicate: true, observation: existing };
      }
      const state = stored || { source: validated.source, lastSeq: 0, lastEpoch: -1, pending: [], connected: false };
      if (state.decimals !== undefined && state.decimals !== validated.decimals) throw new Error("Source precision changed");
      if (validated.epoch <= state.lastEpoch) throw new Error("Out-of-order observation");
      if (historical && state.connected) throw new Error("Historical imports cannot modify a live source");
      if (discontinuity) await invalidatePending(tx, state, "Feed gap detected");
      const predictions = tx.objectStore("predictions");
      const rows = await Promise.all(state.pending.map(id => request(predictions.get(id))));
      const next = [];
      const segment = state.connected || historical && state.lastSeq ? state.segment : (state.segment || 0) + 1;
      const observation = { ...validated, rawQuote: input.rawQuote, sequence: state.lastSeq + 1, segment };
      for (const row of rows) {
        if (!row || row.source !== state.source || !pending(row)) throw new Error("Corrupt pending prediction index");
        if (observation.sequence !== row.originSequence + row.observations.length + 1) throw new Error("Non-consecutive prediction observation");
        const updated = observePrediction(restoreRecord(row), observation);
        predictions.put({ ...row, ...updated });
        if (pending(updated)) next.push(row.id);
      }
      observations.add(observation);
      sources.put({ ...state, decimals: validated.decimals, lastSeq: observation.sequence, lastEpoch: observation.epoch, segment, pending: next, connected: !historical });
      return { duplicate: false, observation };
    });
  }

  createPrediction(input, expectedSequence, createdAt = Date.now()) {
    const record = createResearchPrediction(input);
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1 ||
        !Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("Invalid prediction origin");
    return transaction(this.db, "readwrite", async tx => {
      const sources = tx.objectStore("sources"), predictions = tx.objectStore("predictions");
      const [state, existing] = await Promise.all([
        request(sources.get(record.prediction.source)), request(predictions.get(record.prediction.id)),
      ]);
      if (existing) throw new Error("Prediction id already exists");
      if (!state || !state.connected || state.lastSeq !== expectedSequence || state.lastEpoch !== record.prediction.timestamp) {
        throw new Error("Prediction origin is stale or the feed is interrupted");
      }
      const row = { ...record, id: record.prediction.id, source: record.prediction.source, originSequence: expectedSequence, createdAt };
      predictions.add(row);
      sources.put({ ...state, pending: [...state.pending, row.id] });
      return row;
    });
  }

  interrupt(source, reason) {
    if (typeof source !== "string" || !source || typeof reason !== "string" || !reason) throw new Error("Source and interruption reason required");
    return transaction(this.db, "readwrite", async tx => {
      const sources = tx.objectStore("sources"), state = await request(sources.get(source));
      if (!state) return;
      await invalidatePending(tx, state, reason);
      sources.put(state);
    });
  }

  interruptAll(reason) {
    if (typeof reason !== "string" || !reason) throw new Error("Interruption reason required");
    return transaction(this.db, "readwrite", async tx => {
      const sources = tx.objectStore("sources"), states = await request(sources.getAll());
      for (const state of states) {
        await invalidatePending(tx, state, reason);
        sources.put(state);
      }
    });
  }

  getSource(source) {
    return transaction(this.db, "readonly", tx => request(tx.objectStore("sources").get(source)));
  }

  listSources() {
    return transaction(this.db, "readonly", tx => request(tx.objectStore("sources").getAll()));
  }

  getPrediction(id) {
    return transaction(this.db, "readonly", async tx => {
      const row = await request(tx.objectStore("predictions").get(id));
      if (!row) return null;
      return { ...row, ...restoreRecord(row) };
    });
  }

  list(store, source, limit = 100) {
    if (!["observations", "predictions", "reports"].includes(store) || typeof source !== "string" || !source ||
        !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid history query");
    return transaction(this.db, "readonly", tx => new Promise((resolve, reject) => {
      const index = store === "observations" ? "source" : "history";
      const range = store === "observations" ? IDBKeyRange.only(source) :
        IDBKeyRange.bound([source, 0, ""], [source, Number.MAX_SAFE_INTEGER, "\uffff"]);
      const rows = [], cursor = tx.objectStore(store).index(index).openCursor(range, "prev");
      cursor.onerror = () => reject(cursor.error || new Error("IndexedDB cursor failed"));
      cursor.onsuccess = () => {
        try {
          const c = cursor.result;
          if (!c || rows.length === limit) return resolve(rows);
          rows.push(store === "predictions" ? { ...c.value, ...restoreRecord(c.value) } : c.value);
          c.continue();
        } catch (error) { reject(error); }
      };
    }));
  }

  saveReport(report) {
    return transaction(this.db, "readwrite", async tx => {
      tx.objectStore("reports").add(report);
    });
  }

  setting(key, value) {
    return transaction(this.db, value === undefined ? "readonly" : "readwrite", async tx => {
      const store = tx.objectStore("settings");
      if (value === undefined) return request(store.get(key));
      store.put({ key, value });
    });
  }
}
