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
  assert.doesNotMatch(dashboard, /id="ctab"|<th>Candle<\/th>/);
  assert.match(dashboard, /id="cdl"/);
  assert.match(dashboard, /<option selected>100<\/option>/);
});

test('dashboard trend excludes the forming candle and refuses stale candle history', () => {
  const start = dashboard.indexOf('const tcache = {}');
  const end = dashboard.indexOf('function badge(', start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({cd: {}, tm: {}, SLOPE_MIN: 0.08});
  vm.runInContext(dashboard.slice(start, end), ctx);
  const candles = Array.from({length: 57}, (_, i) => ({
    t: i * 60, h: i + 2, l: i, c: i + 1,
  }));
  ctx.cd.A = candles;
  ctx.tm.A = [56 * 60 + 30];
  assert.equal(vm.runInContext('trend1m("A").st', ctx), 'U');
  ctx.cd.A[56] = {t: 56 * 60, h: 1000, l: -1000, c: -1000};
  assert.equal(vm.runInContext('trend1m("A").st', ctx), 'U');
  ctx.tm.A = [60 * 60];
  assert.equal(vm.runInContext('trend1m("A")', ctx), null);
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
