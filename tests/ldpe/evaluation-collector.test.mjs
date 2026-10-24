import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectSymbol } from "../../src/ldpe/evaluation/collector.mjs";

test("collector persists ticks and provenance resumably without requiring an account", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mambafx-ldpe-"));
  const now = Math.floor(Date.now() / 1000);
  const fakeClient = {
    closed: false,
    async historyPage(symbol) {
      return [
        { symbol, epoch: now - 1, quote: "123.40", decimals: 2, source: "deriv-public-ticks-history", collectedAt: "2026-10-24T00:00:00.000Z" },
        { symbol, epoch: now, quote: "123.41", decimals: 2, source: "deriv-public-ticks-history", collectedAt: "2026-10-24T00:00:00.000Z" },
      ];
    },
    close() { this.closed = true; },
  };
  try {
    const result = await collectSymbol("R_100", { directory, days: 3, requestDelayMs: 0, client: fakeClient });
    assert.equal(result.totalUniqueTicks, 2);
    assert.equal(result.quality.accepted, 2);
    assert.equal(result.validationStatus, "checked");
    assert.equal(fakeClient.closed, true);
    const saved = await fs.readFile(path.join(directory, "R_100.ticks.jsonl"), "utf8");
    assert.match(saved, /"quote":"123\.40"/);
    assert.match(saved, /"source":"deriv-public-ticks-history"/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("collector refuses symbols outside the frozen evaluation list", async () => {
  await assert.rejects(collectSymbol("R_10", { days: 3 }), /unregistered evaluation symbol/);
});

test("collector refuses any request outside the 3-day evaluation window", async () => {
  await assert.rejects(collectSymbol("R_100", { days: 30 }), /limited to the most recent 3 days/);
});

test("collector stops cleanly when Deriv cannot page older than its available history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mambafx-ldpe-oldest-"));
  const now = Math.floor(Date.now() / 1000);
  const file = path.join(directory, "R_100.ticks.jsonl");
  await fs.writeFile(file, `${JSON.stringify({
    symbol: "R_100", epoch: now - 7200, quote: "123.40", decimals: 2,
    source: "deriv-public-ticks-history", collectedAt: new Date().toISOString(), pageId: 1,
  })}\n`, "utf8");
  let calls = 0;
  const page = Array.from({ length: 1000 }, (_, i) => ({
    symbol: "R_100", epoch: now - 999 + i, quote: `123.${String(i % 100).padStart(2, "0")}`,
    decimals: 2, source: "deriv-public-ticks-history", collectedAt: new Date().toISOString(),
  }));
  const client = {
    async historyPage() { calls++; return page; },
    close() {},
  };
  try {
    const result = await collectSymbol("R_100", { directory, days: 3, requestDelayMs: 0, client });
    assert.equal(calls, 2);
    assert.equal(result.historyRangeUnavailable, true);
    assert.equal(result.complete, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
