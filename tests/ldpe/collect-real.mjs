import { collectAll } from "../../src/ldpe/evaluation/collector.mjs";
import { EVALUATION_SYMBOLS } from "../../src/ldpe/evaluation/data.mjs";

const args = process.argv.slice(2);
const daysArg = args.find((arg) => arg.startsWith("--days="));
const maxPagesArg = args.find((arg) => arg.startsWith("--max-pages="));
const days = daysArg ? Number(daysArg.slice("--days=".length)) : 3;
const maxPages = maxPagesArg ? Number(maxPagesArg.slice("--max-pages=".length)) : Infinity;
const symbols = args.filter((arg) => !arg.startsWith("--"));

if (symbols.some((symbol) => !EVALUATION_SYMBOLS.includes(symbol))) {
  throw new Error(`symbols must be selected from: ${EVALUATION_SYMBOLS.join(", ")}`);
}

const results = await collectAll({
  days,
  maxPages,
  symbols: symbols.length ? symbols : [...EVALUATION_SYMBOLS],
  onProgress: (progress) => {
    if (progress.pages === 1 || progress.pages % 20 === 0) {
      console.log(`${progress.symbol}: page ${progress.pages}, ${progress.total} unique ticks, oldest ${progress.oldestEpoch}`);
    }
  },
});
for (const result of results) console.log(JSON.stringify(result));
