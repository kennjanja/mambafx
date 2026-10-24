import fs from "node:fs/promises";
import path from "node:path";
import { extractDigit } from "../engine.js";

export const EVALUATION_SYMBOLS = Object.freeze(["R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"]);
export const PUBLIC_HISTORY_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function decimalsFromPip(pipSize) {
  const pip = Number(pipSize);
  if (!Number.isFinite(pip) || pip <= 0) throw new Error(`invalid Deriv pip_size: ${pipSize}`);
  if (Number.isInteger(pip)) return pip;
  const decimals = Math.round(-Math.log10(pip));
  if (Math.abs(10 ** -decimals - pip) > Math.max(1e-12, pip * 1e-8)) {
    throw new Error(`unsupported non-decimal pip_size: ${pipSize}`);
  }
  return decimals;
}

function rawArrayTokens(raw, key) {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`Deriv history response has no raw ${key} array`);
  return match[1].trim() ? match[1].split(",").map((token) => token.trim()) : [];
}

function parseToken(token) {
  if (token.startsWith('"')) return JSON.parse(token);
  return token;
}

export function parseHistoryMessage(raw, symbol, collectedAt = new Date().toISOString()) {
  const message = JSON.parse(raw);
  if (message.error) throw new Error(`${symbol}: ${message.error.message || "Deriv history error"}`);
  if (!message.history || !Array.isArray(message.history.times)) return null;
  const priceTokens = rawArrayTokens(raw, "prices");
  const timeTokens = rawArrayTokens(raw, "times").map(Number);
  if (priceTokens.length !== timeTokens.length || timeTokens.length !== message.history.times.length) {
    throw new Error(`${symbol}: raw history array length mismatch`);
  }
  const decimals = decimalsFromPip(message.pip_size);
  return timeTokens.map((epoch, index) => ({
    symbol,
    epoch,
    quote: String(parseToken(priceTokens[index])),
    decimals,
    source: "deriv-public-ticks-history",
    collectedAt,
  }));
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b), mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

export function validateDatasetRows(rows, expectedSymbol) {
  const sorted = [...rows].sort((a, b) => Number(a.epoch) - Number(b.epoch));
  const unique = [], seen = new Set();
  const quality = { received: rows.length, duplicates: 0, outOfOrder: 0, malformed: 0, precisionMismatch: 0, gaps: 0, missingIntervals: 0 };
  const previousByPage = new Map();
  for (const row of rows) {
    const epoch = Number(row.epoch);
    if (!Number.isFinite(epoch)) { quality.malformed++; continue; }
    const pageKey = Number.isInteger(row.pageId) ? row.pageId : "all";
    const previous = previousByPage.get(pageKey) ?? -Infinity;
    if (epoch <= previous) quality.outOfOrder++;
    previousByPage.set(pageKey, epoch);
    if (seen.has(epoch)) { quality.duplicates++; continue; }
    seen.add(epoch);
  }
  const uniqueEpochs = new Set();
  for (const row of sorted) {
    const epoch = Number(row.epoch);
    if (!Number.isFinite(epoch) || !Number.isInteger(row.decimals) || row.symbol !== expectedSymbol ||
        typeof row.quote !== "string" || extractDigit(row.quote, row.decimals) === null) {
      if (row.symbol === expectedSymbol && Number.isFinite(epoch) && extractDigit(row.quote, row.decimals) === null) quality.precisionMismatch++;
      else quality.malformed++;
      continue;
    }
    if (uniqueEpochs.has(epoch)) continue;
    uniqueEpochs.add(epoch);
    unique.push({ ...row, epoch, digit: extractDigit(row.quote, row.decimals) });
  }
  const intervals = [];
  for (let i = 1; i < unique.length; i++) intervals.push(unique[i].epoch - unique[i - 1].epoch);
  const typicalInterval = median(intervals.filter((interval) => interval > 0));
  const gapEpochs = new Set();
  for (let i = 1; i < unique.length; i++) {
    const interval = unique[i].epoch - unique[i - 1].epoch;
    if (typicalInterval > 0 && interval > typicalInterval * 3) {
      quality.gaps++;
      quality.missingIntervals += Math.max(1, Math.round(interval / typicalInterval) - 1);
      gapEpochs.add(unique[i].epoch);
    }
  }
  for (const row of unique) row.gapBefore = gapEpochs.has(row.epoch);
  const days = new Set(unique.map((row) => new Date(row.epoch * 1000).toISOString().slice(0, 10)));
  return {
    rows: unique,
    quality: { ...quality, accepted: unique.length, typicalIntervalSeconds: typicalInterval, calendarDays: days.size },
  };
}

export async function readJsonLines(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const rows = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) { throw new Error(`invalid JSONL at ${filePath}:${index + 1}: ${error.message}`); }
  }
  return rows;
}

export async function appendJsonLines(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!rows.length) return;
  const contents = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await fs.appendFile(filePath, contents, "utf8");
}

export async function writeJsonAtomically(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function dateCoverage(rows) {
  const dates = new Set(rows.map((row) => new Date(Number(row.epoch) * 1000).toISOString().slice(0, 10)));
  return [...dates].sort();
}
