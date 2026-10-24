import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_DATA_DIR } from "../../src/ldpe/evaluation/collector.mjs";
import { EVALUATION_SYMBOLS, readJsonLines } from "../../src/ldpe/evaluation/data.mjs";
import { evaluateDevelopment, evaluateSelectedHoldout } from "../../src/ldpe/evaluation/runner.mjs";

const dataDirectory = process.env.MAMBAFX_LDPE_DATA_DIR || DEFAULT_DATA_DIR;
const manifestPath = path.resolve("docs/ldpe-evaluation-manifest-v2.2.json");
const manifestBytes = await fs.readFile(manifestPath);
const manifestHash = crypto.createHash("sha256").update(manifestBytes).digest("hex").toUpperCase();
const cutoff = Math.floor(Date.now() / 1000 - 3 * 86400);
const datasets = {};

for (const symbol of EVALUATION_SYMBOLS) {
  const file = path.join(dataDirectory, `${symbol}.ticks.jsonl`);
  const rows = await readJsonLines(file);
  datasets[symbol] = rows.filter((row) => Number(row.epoch) >= cutoff);
  console.log(`${symbol}: loaded ${datasets[symbol].length} ticks from the approved 3-day window`);
}

const development = evaluateDevelopment(datasets);
development.manifestSha256 = manifestHash;
const output = { manifestSha256: manifestHash, development };
if (development.selection.holdoutMayOpen) {
  output.holdout = evaluateSelectedHoldout(datasets, development);
} else {
  output.holdout = { status: "locked", reason: "candidate selection or projected-power gate not passed" };
}

const outputPath = path.join(dataDirectory, "ldpe-evaluation-v2-results.json");
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Manifest SHA-256: ${manifestHash}`);
console.log(`Registered comparisons: ${development.registeredHypotheses}`);
console.log(`Eligible candidate cells: ${development.selection.eligible.length}`);
console.log(`Selected cells: ${development.selection.selected.length}`);
console.log(`Holdout opened: ${development.selection.holdoutMayOpen}`);
console.log(`Results: ${outputPath}`);
