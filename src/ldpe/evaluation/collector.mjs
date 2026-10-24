import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  EVALUATION_SYMBOLS, PUBLIC_HISTORY_URL, appendJsonLines, parseHistoryMessage,
  readJsonLines, validateDatasetRows, writeJsonAtomically,
} from "./data.mjs";

export const DEFAULT_DATA_DIR = path.join(os.homedir(), ".mambafx", "ldpe-evaluation-v2");
const PAGE_SIZE = 1000;
const PAGE_DELAY_MS = 1000;
const MAX_PAGE_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 15000;

export class DerivHistoryClient {
  constructor(url = PUBLIC_HISTORY_URL, timeoutMs = 30000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.opening = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async #connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Deriv history websocket connection timed out"));
      }, this.timeoutMs);
      socket.onopen = () => { clearTimeout(timer); this.socket = socket; resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("Deriv history websocket connection failed")); };
      socket.onmessage = (event) => this.#message(String(event.data));
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        for (const { reject: fail, timer: requestTimer } of this.pending.values()) {
          clearTimeout(requestTimer);
          fail(new Error("Deriv history websocket closed while a request was pending"));
        }
        this.pending.clear();
      };
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  #message(raw) {
    let message;
    try { message = JSON.parse(raw); }
    catch (error) {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`invalid JSON from Deriv history websocket: ${error.message}`));
      }
      this.pending.clear();
      return;
    }
    const request = this.pending.get(message.req_id);
    if (!request) return;
    this.pending.delete(message.req_id);
    clearTimeout(request.timer);
    request.resolve(raw);
  }

  async historyPage(symbol, end) {
    await this.#connect();
    const reqId = ++this.nextId;
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`${symbol}: history request timed out`));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ ticks_history: symbol, end, count: PAGE_SIZE, style: "ticks", req_id: reqId }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error(`${symbol}: failed to send history request: ${error.message}`));
      }
    });
    return parseHistoryMessage(raw, symbol);
  }

  close() {
    if (this.socket) this.socket.close();
    this.socket = null;
  }
}

function statePath(directory, symbol) { return path.join(directory, `${symbol}.collection.json`); }
function ticksPath(directory, symbol) { return path.join(directory, `${symbol}.ticks.jsonl`); }
async function readMetadata(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function epochBounds(values) {
  let min = Infinity, max = -Infinity;
  for (const value of values) { if (value < min) min = value; if (value > max) max = value; }
  return values.size ? { min, max } : { min: null, max: null };
}

export async function collectSymbol(symbol, {
  directory = process.env.MAMBAFX_LDPE_DATA_DIR || DEFAULT_DATA_DIR,
  days = 3,
  requestDelayMs = PAGE_DELAY_MS,
  maxPages = Infinity,
  onProgress = () => {},
  client = new DerivHistoryClient(),
} = {}) {
  if (!EVALUATION_SYMBOLS.includes(symbol)) throw new Error(`unregistered evaluation symbol: ${symbol}`);
  if (days !== 3) throw new Error("this evaluation is limited to the most recent 3 days");
  const file = ticksPath(directory, symbol), metadataFile = statePath(directory, symbol);
  const existing = await readJsonLines(file);
  const previousMetadata = await readMetadata(metadataFile);
  const accepted = new Set(existing.map((row) => Number(row.epoch)).filter(Number.isFinite));
  const bounds = epochBounds(accepted);
  const oldestExisting = bounds.min;
  const cutoff = Math.floor(Date.now() / 1000 - days * 86400);
  const pageIds = new Set(existing.map((row) => row.pageId).filter((id) => Number.isInteger(id)));
  let pageId = [...pageIds].reduce((max, value) => Math.max(max, value), 0);
  let end = "latest", pages = 0, fresh = 0, reconnects = 0, reachedOverlap = false, exhausted = false;
  let historyRangeUnavailable = false;
  const reconnectEvents = [...(previousMetadata?.reconnectEvents || [])];
  try {
    while (pages < maxPages) {
      let rows;
      for (let attempt = 0; ; attempt++) {
        try {
          rows = await client.historyPage(symbol, end);
          break;
        } catch (error) {
          if (attempt >= MAX_PAGE_ATTEMPTS - 1) throw error;
          reconnects++;
          reconnectEvents.push({ at: new Date().toISOString(), end, message: error.message, retry: attempt + 1 });
          client.close();
          await delay(Math.min(MAX_RETRY_DELAY_MS, 1000 * (2 ** attempt)));
        }
      }
      pages++;
      if (!rows?.length) { exhausted = true; break; }
      pageId++;
      const pageEpochs = rows.map((row) => Number(row.epoch)).filter(Number.isFinite);
      if (pageEpochs.some((epoch, i) => i > 0 && epoch <= pageEpochs[i - 1])) {
        throw new Error(`${symbol}: Deriv returned non-ascending or duplicate epochs within a page`);
      }
      const requestedEnd = end === "latest" ? null : Number(end);
      if (requestedEnd !== null && pageEpochs[0] > requestedEnd) {
        historyRangeUnavailable = true;
        break;
      }
      const overlap = rows.some((row) => accepted.has(Number(row.epoch)));
      const freshRows = rows.filter((row) => {
        const epoch = Number(row.epoch);
        if (!Number.isFinite(epoch) || accepted.has(epoch)) return false;
        accepted.add(epoch);
        if (bounds.min === null || epoch < bounds.min) bounds.min = epoch;
        if (bounds.max === null || epoch > bounds.max) bounds.max = epoch;
        return true;
      }).map((row) => ({ ...row, pageId }));
      await appendJsonLines(file, freshRows);
      fresh += freshRows.length;
      const oldestPageEpoch = pageEpochs[0];
      onProgress({ symbol, pages, fresh, total: accepted.size, oldestEpoch: oldestPageEpoch, cutoff });
      await writeJsonAtomically(metadataFile, {
        version: 1,
        symbol,
        source: PUBLIC_HISTORY_URL,
        windowDays: days,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        pages,
        totalUniqueTicks: accepted.size,
        oldestEpoch: bounds.min,
        newestEpoch: bounds.max,
        lastRequestEnd: end,
        reconnects: (previousMetadata?.reconnects || 0) + reconnects,
        reconnectEvents,
        complete: oldestPageEpoch <= cutoff || exhausted,
        historyRangeUnavailable,
      });
      if (oldestPageEpoch <= cutoff || rows.length < PAGE_SIZE) {
        exhausted = rows.length < PAGE_SIZE;
        if (exhausted && oldestPageEpoch > cutoff) historyRangeUnavailable = true;
        break;
      }
      if (overlap && !reachedOverlap) {
        reachedOverlap = true;
        if (oldestExisting !== null && oldestExisting <= cutoff) break;
        end = oldestExisting !== null ? String(oldestExisting - 1) : String(oldestPageEpoch - 1);
      } else {
        end = String(oldestPageEpoch - 1);
      }
      if (requestDelayMs) await delay(requestDelayMs);
      if (freshRows.length === 0 && pageEpochs[0] <= requestedEnd) {
        throw new Error(`${symbol}: history pagination made no progress at end=${end}`);
      }
    }
  } finally {
    client.close();
  }

  const allRows = await readJsonLines(file);
  const validation = validateDatasetRows(allRows, symbol);
  const metadata = {
    version: 1,
    symbol,
    source: PUBLIC_HISTORY_URL,
    windowDays: days,
    lastUpdatedAt: new Date().toISOString(),
    pageCountThisRun: pages,
    totalPageCount: (previousMetadata?.totalPageCount || previousMetadata?.pages || 0) + pages,
    newTicksThisRun: fresh,
    totalNewTicks: (previousMetadata?.totalNewTicks || previousMetadata?.newTicksThisRun || 0) + fresh,
    totalUniqueTicks: validation.quality.accepted,
    oldestEpoch: validation.rows[0]?.epoch ?? null,
    newestEpoch: validation.rows[validation.rows.length - 1]?.epoch ?? null,
    reconnects: (previousMetadata?.reconnects || 0) + reconnects,
    reconnectEvents,
    reachedRequestedWindow: validation.rows.length > 0 && validation.rows[0].epoch <= cutoff,
    complete: validation.rows.length > 0 && validation.rows[0].epoch <= cutoff,
    historyRangeUnavailable,
    quality: validation.quality,
    validationStatus: validation.quality.precisionMismatch || validation.quality.malformed ||
      validation.quality.duplicates || validation.quality.outOfOrder ? "failed" : "checked",
  };
  await writeJsonAtomically(metadataFile, metadata);
  return metadata;
}

export async function collectAll(options = {}) {
  const symbols = options.symbols || [...EVALUATION_SYMBOLS];
  const results = [];
  for (const symbol of symbols) {
    results.push(await collectSymbol(symbol, {
      ...options,
      onProgress: (progress) => {
        options.onProgress?.(progress);
      },
    }));
  }
  return results;
}
