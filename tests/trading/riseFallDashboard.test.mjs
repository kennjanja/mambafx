import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('index.html', 'utf8');
const dashboard = readFileSync('rise-fall-dashboard.html', 'utf8');

test('dashboard is separately navigable and sandboxed from trading credentials', () => {
  assert.match(html, /id="navRiseFallDashboard" onclick="showPage\('risefalldashboard'\)"/);
  assert.match(html, /id="riseFallDashboardFrame"[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(dashboard, /<script[^>]+src=/i);
  assert.match(dashboard, /ticks_history/);
  assert.doesNotMatch(dashboard, /\bproposal\s*:|\bbuy\s*:/);
});

test('opening loads the dashboard once; leaving unloads its live feed', () => {
  const start = html.indexOf('function showPage(which){');
  const end = html.indexOf('window.addEventListener("mfx:modules-changed"', start);
  assert.ok(start >= 0 && end > start);
  let frameSrc = null, writes = 0;
  const frame = {
    hasAttribute: key => key === 'src' && frameSrc !== null,
    set src(value){ frameSrc = value; writes++; },
    removeAttribute(key){ if (key === 'src') frameSrc = null; },
  };
  const page = {classList:{toggle(){}}};
  const document = { getElementById(id){ return id === 'riseFallDashboardFrame' ? frame : page; } };
  const ctx = vm.createContext({document, window:{}});
  vm.runInContext(html.slice(start, end), ctx);
  ctx.showPage('risefalldashboard');
  assert.equal(frameSrc, 'rise-fall-dashboard.html');
  ctx.showPage('risefalldashboard');
  assert.equal(writes, 1);
  ctx.showPage('live');
  assert.equal(frameSrc, null);
});
