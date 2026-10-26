// Runs every tests/<suite>/*.test.mjs as its own node process (a combined LDPE run hangs) and reports the real
// exit code and the TAP totals per file. A file whose totals cannot be parsed is reported UNKNOWN, never passing.
// Usage: node scripts/run-all-tests.mjs [suite ...]   (default: analysis bazu ldpe)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['analysis', 'bazu', 'ldpe'];
const grand = { tests: 0, pass: 0, fail: 0, files: 0, bad: [] };
for (const s of suites) {
  const dir = join('tests', s);
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort(); } catch { console.log(`${s}: no directory`); continue; }
  const t = { tests: 0, pass: 0, fail: 0 };
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=120000', join(dir, f)], { encoding: 'utf8', timeout: 300000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const num = (k) => { const m = out.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? +m[1] : null; };
    const row = { tests: num('tests'), pass: num('pass'), fail: num('fail') };
    const known = row.tests != null && row.pass != null && row.fail != null;
    const ok = r.status === 0 && known && row.fail === 0;
    if (known) { t.tests += row.tests; t.pass += row.pass; t.fail += row.fail; }
    grand.files++;
    if (!ok) grand.bad.push(`${s}/${f}`);
    console.log(`${ok ? 'OK     ' : known ? 'FAIL   ' : 'UNKNOWN'} ${s}/${f} exit=${r.status}${r.signal ? ' signal=' + r.signal : ''} tests=${row.tests} pass=${row.pass} fail=${row.fail}`);
  }
  console.log(`== ${s}: files=${files.length} tests=${t.tests} pass=${t.pass} fail=${t.fail}`);
  grand.tests += t.tests; grand.pass += t.pass; grand.fail += t.fail;
}
console.log(`== TOTAL files=${grand.files} tests=${grand.tests} pass=${grand.pass} fail=${grand.fail} notOk=${grand.bad.length}${grand.bad.length ? ' -> ' + grand.bad.join(', ') : ''}`);
process.exit(grand.bad.length ? 1 : 0);
