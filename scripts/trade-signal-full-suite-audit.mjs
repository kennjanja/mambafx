// Run every *.test.mjs under tests independently, preserving complete output.
// Usage: node scripts/trade-signal-full-suite-audit.mjs reports/full-suite.tap
import { readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const output = process.argv[2];
if (!output) throw new Error('Supply an output path');
function discover(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? discover(path) : entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : [];
  });
}
const files = discover('tests');
if (!files.length) throw new Error('No test files discovered');
writeFileSync(output, `Full-suite audit\nNode ${process.version}\nFiles discovered: ${files.length}\n`, { flag: 'wx' });
const total = { files: files.length, tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0, unknown: [], bad: [] };
for (const file of files) {
  const command = [process.execPath, '--test', '--test-reporter=tap', '--test-timeout=120000', file];
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 300000, maxBuffer: 128 * 1024 * 1024 });
  const out = result.stdout || '', err = result.stderr || '';
  const read = (name) => {
    const matches = [...out.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map((name) => [name, read(name)]));
  const known = Object.values(counts).every((value) => value !== null);
  if (known) for (const name of Object.keys(counts)) total[name] += counts[name];
  else total.unknown.push(file);
  if (result.status !== 0 || !known || counts.fail || counts.cancelled) total.bad.push(file);
  appendFileSync(output, `\n===== ${file} =====\nCOMMAND ${JSON.stringify(command)}\nEXIT ${result.status} SIGNAL ${result.signal || 'none'} ERROR ${result.error?.stack || 'none'}\n--- STDOUT ---\n${out}\n--- STDERR ---\n${err}\nCOUNTS ${JSON.stringify(counts)}\n`);
  console.log(`${known && result.status === 0 && !counts.fail && !counts.cancelled ? 'OK' : known ? 'FAIL' : 'UNKNOWN'} ${file} ${JSON.stringify(counts)}`);
}
appendFileSync(output, `\n===== SUMMARY =====\n${JSON.stringify(total, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(total)}`);
process.exitCode = total.bad.length ? 1 : 0;
