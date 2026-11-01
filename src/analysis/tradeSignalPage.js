// Trade Signal page: scans every market for a 30 min bias + 5 min entry setup (see tradeSignal.js) and lists
// the setups. Clicking one opens Candle Charts on that market with all evidence highlighted in blue.
// Uses its own read-only WebSocket (public candle history); it never places orders.
import { buildTradeSignal, TRADE_SIGNAL_TFS, fmtPrice } from './tradeSignal.js';

const TFS = [TRADE_SIGNAL_TFS.entry, TRADE_SIGNAL_TFS.bias, ...TRADE_SIGNAL_TFS.htf];
const COUNT = 300, MARKET_TIMEOUT_MS = 12000, RESCAN_MS = 60000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const results = new Map();     // symbol -> { sig, at }
let ws = null, running = false, endpointIdx = 0, symMap = {}, scanTimer = null, marketTimer = null;
let queue = [], cur = null, scanned = 0, total = 0, lastScanAt = null, reqSeq = 7100, status = 'idle';
const pending = new Map();     // req_id -> granularity

const isActive = () => { const p = $('page-tradesignal'); return !!p && p.classList.contains('active'); };
const markets = () => (typeof MARKETS !== 'undefined' ? Object.keys(MARKETS) : []);
const labelOf = (s) => (typeof MARKETS !== 'undefined' && MARKETS[s]) || s;

function send(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function connect() {
  const eps = typeof WS_ENDPOINTS !== 'undefined' ? WS_ENDPOINTS : [];
  if (!eps.length) { status = 'no endpoint'; render(); return; }
  const url = eps[endpointIdx % eps.length];
  let opened = false;
  try { ws = new WebSocket(url); } catch (_) { retry(); return; }
  status = 'connecting';
  ws.onopen = () => { opened = true; send({ active_symbols: 'brief', req_id: 7099 }); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.msg_type === 'active_symbols' || m.req_id === 7099) { onSymbols(m); return; }
    if (m.error) { if (pending.has(m.req_id)) onCandles(m.req_id, null); return; }
    if (m.msg_type === 'candles' && Array.isArray(m.candles) && pending.has(m.req_id)) onCandles(m.req_id, m.candles);
  };
  ws.onclose = () => { ws = null; if (!opened) endpointIdx++; if (running) retry(); };
  ws.onerror = () => {};
}
function retry() { clearTimeout(scanTimer); scanTimer = setTimeout(() => { if (running && !ws) connect(); }, 3000); }

function onSymbols(m) {
  const list = m.active_symbols || [];
  symMap = {};
  for (const k of markets()) {
    let d = null;
    try { d = typeof _findDiscoveredSymbol === 'function' ? _findDiscoveredSymbol(list, k) : null; } catch (_) {}
    symMap[k] = d ? (d.underlying_symbol || d.symbol || k) : k;
  }
  scan();
}

function scan() {
  if (!running || !ws) return;
  queue = markets().slice(); total = queue.length; scanned = 0; status = 'scanning';
  next();
}
function next() {
  clearTimeout(marketTimer); pending.clear();
  if (!running) return;
  const sym = queue.shift();
  if (!sym) { status = 'idle'; lastScanAt = Date.now(); render(); clearTimeout(scanTimer); scanTimer = setTimeout(() => { if (isActive()) scan(); else stop(); }, RESCAN_MS); return; }
  cur = { sym, candles: {}, got: 0, want: TFS.length };
  for (const tf of TFS) {
    const id = ++reqSeq; pending.set(id, tf.g);
    send({ ticks_history: symMap[sym] || sym, end: 'latest', count: COUNT, style: 'candles', granularity: tf.g, req_id: id });
  }
  marketTimer = setTimeout(finishMarket, MARKET_TIMEOUT_MS);
  render();
}
function onCandles(id, candles) {
  const g = pending.get(id); pending.delete(id);
  if (!cur) return;
  if (candles) cur.candles[g] = candles.map((c) => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
  if (++cur.got >= cur.want) finishMarket();
}
function finishMarket() {
  clearTimeout(marketTimer);
  if (!cur) return;
  const { sym, candles } = cur; cur = null;
  let sig;
  try { sig = buildTradeSignal({ symbol: sym, label: labelOf(sym), candles }); }
  catch (e) { sig = { symbol: sym, label: labelOf(sym), status: 'insufficient', dir: 0, reason: 'analysis error: ' + e.message, headline: labelOf(sym) + ': analysis error' }; }
  results.set(sym, { sig, at: Date.now() });
  scanned++; render(); next();
}

function row(sig) {
  const buy = sig.dir === 1, cls = sig.status === 'signal' ? (buy ? 'ts-buy' : 'ts-sell') : 'ts-wait';
  const inv = sig.invalidation ? ` · invalidation ${fmtPrice(sig.invalidation.price)} (${esc(sig.invalidation.rule)})` : '';
  return `<div class="ts-row ${cls}" data-sym="${esc(sig.symbol)}" role="button" tabindex="0" title="Open ${esc(sig.label)} in Candle Charts with the evidence highlighted">
    <span class="ts-badge">${esc(sig.action || '')}</span>
    <span class="ts-main"><b>${esc(sig.headline)}</b>
      <span class="ts-sub">price ${sig.price != null ? fmtPrice(sig.price) : '—'}${inv} · ${esc(sig.biasTf)} balance ${sig.bias.balance == null ? '—' : sig.bias.balance.toFixed(2)} · ${esc(sig.entryTf)} ${esc(sig.entry.verdict)}</span></span>
    <span class="ts-go">Open charts ›</span></div>`;
}
function render() {
  const el = $('tsList'); if (!el) return;
  const all = [...results.values()].map((r) => r.sig);
  const live = all.filter((s) => s.status === 'signal').sort((a, b) => Math.abs(b.bias.balance) - Math.abs(a.bias.balance));
  const wait = all.filter((s) => s.status === 'wait');
  const rest = all.filter((s) => s.status !== 'signal' && s.status !== 'wait');
  const bar = $('tsStatus');
  if (bar) bar.textContent = `${status === 'scanning' ? `scanning ${scanned}/${total}…` : status}${lastScanAt ? ' · last full scan ' + new Date(lastScanAt).toLocaleTimeString() : ''} · ${live.length} setup(s) · ${wait.length} waiting`;
  el.innerHTML = (live.length ? live.map(row).join('') : `<div class="ts-empty">${status === 'scanning' && !all.length ? 'Scanning markets…' : 'No market currently has a 30 min lean with a non-opposing 5 min entry.'}</div>`)
    + (wait.length ? `<div class="ts-h">Waiting (30 min lean, 5 min opposes)</div>` + wait.map(row).join('') : '')
    + (rest.length ? `<details class="ts-rest"><summary>No setup (${rest.length})</summary>${rest.map((s) => `<div class="ts-none"><b>${esc(s.label)}</b> — ${esc(s.reason || s.headline)}</div>`).join('')}</details>` : '');
}

export function tsStart() {
  if (running) { render(); return; }
  running = true; status = 'connecting'; render();
  if (!ws) connect(); else scan();
}
export function tsStop() {
  running = false; clearTimeout(scanTimer); clearTimeout(marketTimer);
  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
  status = 'idle';
}
export function tsRescan() { if (running && ws && status !== 'scanning') scan(); else if (!running) tsStart(); }

/** Open Candle Charts on the market with the blue evidence highlight on. */
export function tsOpen(sym) {
  const r = results.get(sym);
  window.__tsFocus = { symbol: sym, headline: r ? r.sig.headline : sym };
  const chip = $('pa-evid');
  if (chip && !chip.checked) { chip.checked = true; chip.dispatchEvent(new Event('change')); }
  if (typeof window.mfxSwitchMarket === 'function') window.mfxSwitchMarket(sym);
  showPage('candles');
  if (typeof window.mfxTfFocusRefresh === 'function') window.mfxTfFocusRefresh();
}

document.addEventListener('click', (e) => {
  const r = e.target.closest && e.target.closest('#tsList .ts-row'); if (r) tsOpen(r.dataset.sym);
  if (e.target && e.target.id === 'tsRescan') tsRescan();
});
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('ts-row')) { e.preventDefault(); tsOpen(e.target.dataset.sym); } });
Object.assign(window, { tsStart, tsStop, tsOpen, tsRescan, __tsResults: results });
