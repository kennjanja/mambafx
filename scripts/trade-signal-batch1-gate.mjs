// Only this gate may authorize a clean v1.1 Batch 1 run. It never starts Batch 1.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const definitions = [
  ['docs/trade-signal-definitions-v1.md', 'f4b226cfe8b970b77085d5fcc3288ebb693797f0c9c2c6a975c1cce6a8de5a86'],
  ['docs/trade-signal-definitions-v1.1.md', '58a441faf5495714d2e22b4136a8eb9431a5be16e63c3bfd54f2dbdac2fb4ab7'],
  ['docs/trade-signal-definitions-v1.2.md', '27c53e2dcfb75d68697dccac8d486f2168867d73ffca53c7b4536eb9cad9798f'],
  ['docs/trade-signal-definitions-v1.3.md', '34e656722f5fbec471367d85384e172fd9998c4f470270e4a5cf354d84c365a2'],
  ['docs/trade-signal-sweep-pivot-clarification.md', 'c2c99b1586a2bd961bc784d1cbec497604b16da2be48b131a9c21e7ea1996521'],
  ['docs/trade-signal-atr-clarification.md', '465ed28d816633131be9a745fd89964d2313bc95f4f7df8483e91b1fba3d3cdc'],
  ['docs/trade-signal-deferred-pivot-clarification.md', 'f91eb6b9bfa8e48a289cf49213fd35186687b00b564237154377b9da49651a6b'],
  ['docs/trade-signal-model-a-group-clarification.md', '97b11d63c862ab883d98962fc5095f15cbc7fa6568a136c999990355298dad85'],
];
function sourceFingerprint() {
  const entries = [];
  function collect(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name);
      if (item.isDirectory()) collect(path);
      else if (item.isFile()) entries.push(path);
      else throw new Error(`Unsupported source entry: ${path}`);
    }
  }
  collect('src');
  entries.push('index.html');
  const hash = createHash('sha256');
  for (const file of entries) {
    const bytes = readFileSync(file);
    hash.update(JSON.stringify([file.replaceAll('\\', '/'), bytes.length]));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
let blocked = false;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.error || head.status !== 0 || !/^[0-9a-f]{40}\s*$/i.test(head.stdout || '')) {
  console.error('BLOCKED: unable to establish the Git HEAD.');
  blocked = true;
} else {
  console.log(`Git HEAD (base only; working tree may be dirty): ${head.stdout.trim()}`);
}
const sourceBefore = sourceFingerprint();
console.log(`Uncommitted-inclusive source SHA-256 (src and index.html): ${sourceBefore}`);
for (const [file, expected] of definitions) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(`${file}: ${actual}`);
  if (actual !== expected) {
    console.error(`BLOCKED: frozen definition hash differs for ${file}`);
    blocked = true;
  }
}
const requiredFiles = [
  'tests/conformance/tradeSignalV11.conformance.mjs',
  'tests/conformance/tradeSignalV11.differential.conformance.mjs',
  'tests/conformance/tradeSignalV13.integration.conformance.mjs',
  'tests/conformance/tradeSignalDeferredPivot.conformance.mjs',
  'tests/conformance/tradeSignalMultiPoolInjected.conformance.mjs',
  'tests/reference/tradeSignalModelAV11.reference.mjs',
];
const discovered = readdirSync('tests/conformance').filter((name) => name.endsWith('.conformance.mjs'))
  .sort().map((name) => join('tests', 'conformance', name).replaceAll('\\', '/'));
const files = [...new Set([...requiredFiles, ...discovered])];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8' });
  const out = result.stdout || '';
  process.stdout.write(out);
  if (result.stderr) process.stderr.write(result.stderr);
  const count = (name) => {
    const matches = [...out.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map((key) => [key, count(key)]));
  if (result.error || result.status !== 0 || !counts.tests || counts.fail !== 0 || counts.skipped !== 0
    || counts.cancelled !== 0 || counts.todo !== 0 || counts.pass !== counts.tests) {
    console.error(`BLOCKED: ${file} is failing, pending, skipped, incomplete, or could not be run.`);
    blocked = true;
  }
  if (sourceFingerprint() !== sourceBefore) {
    console.error('BLOCKED: source files changed while the conformance suite was running.');
    blocked = true;
  }
}
if (blocked) {
  console.error('BATCH 1 BLOCKED: do not run v1.1 comparisons while conformance is incomplete.');
  process.exitCode = 1;
} else {
  console.log('Conformance gate passed. Record the exact source snapshot and all definition hashes before beginning Batch 1.');
}
