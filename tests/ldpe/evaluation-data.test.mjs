import test from "node:test";
import assert from "node:assert/strict";
import { parseHistoryMessage, validateDatasetRows } from "../../src/ldpe/evaluation/data.mjs";

test("history parsing preserves raw quoted price precision and provenance", () => {
  const raw = '{"msg_type":"history","req_id":7,"pip_size":0.01,"history":{"times":[100,101],"prices":[123.40,123.57]}}';
  const rows = parseHistoryMessage(raw, "1HZ10V", "2026-10-24T00:00:00.000Z");
  assert.equal(rows[0].quote, "123.40");
  assert.equal(rows[0].decimals, 2);
  assert.equal(rows[0].source, "deriv-public-ticks-history");
  assert.equal(rows[1].epoch, 101);
});

test("dataset validation reports duplicates, page-local disorder, bad precision, and gaps", () => {
  const rows = [
    { symbol: "R_100", epoch: 10, quote: "12.30", decimals: 2, pageId: 1 },
    { symbol: "R_100", epoch: 12, quote: "12.31", decimals: 2, pageId: 1 },
    { symbol: "R_100", epoch: 11, quote: "12.32", decimals: 2, pageId: 1 },
    { symbol: "R_100", epoch: 20, quote: "12.40", decimals: 2, pageId: 2 },
    { symbol: "R_100", epoch: 20, quote: "12.40", decimals: 2, pageId: 3 },
    { symbol: "R_100", epoch: 21, quote: "12.4", decimals: 2, pageId: 3 },
  ];
  const result = validateDatasetRows(rows, "R_100");
  assert.equal(result.quality.duplicates, 1);
  assert.equal(result.quality.outOfOrder, 1);
  assert.equal(result.quality.precisionMismatch, 1);
  assert.equal(result.quality.gaps, 1);
  assert.ok(result.rows.every((row) => Number.isInteger(row.digit)));
});

test("malformed history payloads fail explicitly rather than reconstructing quote values", () => {
  assert.throws(() => parseHistoryMessage('{"msg_type":"history","history":{"times":[1],"prices":[2.3]}}', "R_100"), /pip_size/);
});
