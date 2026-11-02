// Trade Signal page: scans every market for a 30 min bias + 5 min entry setup (see tradeSignal.js) and lists
// the setups. Clicking one opens Candle Charts on that market with all evidence highlighted in blue.
// Uses its own read-only WebSocket (public candle history); it never places orders.
import { buildTradeSignal, PROFILE_LIST, ALL_GRANULARITIES, fmtPrice } from './tradeSignal.js';
import { openTracked, updateTracked, progress, summarize, deduplicateOpenRecords } from './tradeSignalTracker.js';
import { predictionHistoryStore } from './tradeSignalStorage.js';
import { createLifecycleRegistry } from './tradeSignalLifecycle.js';

const TFS = [...new Set([60, ...ALL_GRANULARITIES])].sort((a, b) => a - b).map((g) => ({ g }));
const COUNT = 300, MARKET_TIMEOUT_MS = 12000, RESCAN_MS = 60000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const results = new Map();     // symbol/profile -> { sig, at }
const lifecycleRegistry = createLifecycleRegistry();
let lifecycleLoadError = null;
try { lifecycleRegistry.load(); } catch (error) { lifecycleLoadError = error; }
let ws = null, running = false, endpointIdx = 0, symMap = {}, scanTimer = null, marketTimer = null;
let queue = [], cur = null, scanned = 0, total = 0, lastScanAt = null, reqSeq = 7100, status = lifecycleLoadError ? 'lifecycle storage error' : 'idle';
const pendingExpiryTicks = new Map();
for (const record of lifecycleRegistry.list()) {
  const profile = PROFILE_LIST.find((item) => item.id === record.key?.split('|').slice(-1)[0]);
  const symbol = record.key?.slice(0, record.key.lastIndexOf('|'));
  if (!profile || !symbol) continue;
  results.set(record.key, { sig: { symbol, label: labelOf(symbol), profile: profile.id, profileName: record.profileName || profile.name, holdLabel: record.holdLabel || profile.holdLabel, entryG: record.entryG || profile.tfs.entry.g, dir: record.direction || 0, status: record.state === 'Signal Active' ? 'signal' : ['Watching', 'Approaching Location', 'Trigger Detected'].includes(record.state) ? 'watching' : 'none', action: record.action, headline: record.headline || `${labelOf(symbol)}: ${record.state}`, reason: record.reason || '', waitingCondition: record.waitingCondition || '', nearestLevel: record.nearestLevel, bias: record.bias || { balance: record.overallBalance || 0 }, overallBalance: record.overallBalance, familyValues: record.familyValues || [], primaryModel: record.primaryModel, secondaryModels: record.secondaryModels || [], inducementEvents: record.inducementEvents || [], evidenceSnapshot: record.evidenceSnapshot || [], target: record.target, invalidation: record.invalidation, lifecycleState: record.state, lifecycleHistory: record.lifecycleHistory || [] }, at: record.updatedAt || Date.now() });
}
// Every signal produced is followed until its predicted window lapses, then marked correct (green tick) or wrong (red X).
const TRACK_KEY = 'mfx_ts_track_v1', TRACK_MAX = 300;
let tracked = [];
try { tracked = deduplicateOpenRecords(JSON.parse(localStorage.getItem(TRACK_KEY) || '[]').filter((r) => r && r.id && r.expiresAt)); } catch (error) { lifecycleLoadError = lifecycleLoadError || error; }
const saveTracked = () => { try { localStorage.setItem(TRACK_KEY, JSON.stringify(tracked.slice(-TRACK_MAX))); } catch (error) { status = 'storage error: ' + error.message; throw error; } };
const nowSec = () => Math.floor(Date.now() / 1000);
// Resolved predictions use shared IndexedDB persistence; the legacy browser archive remains untouched until migration verification.
let archiveError = null;
function archive(recs) {
  if (!recs.length) return Promise.resolve();
  return predictionHistoryStore.add(recs).then(() => { archiveError = null; window.dispatchEvent(new Event('mfx-prediction-archived')); })
    .catch((error) => { archiveError = error; status = 'Prediction History storage error'; render(); });
}
predictionHistoryStore.migrateLegacy().then(() => archive(tracked.filter((r) => r.state === 'correct' || r.state === 'wrong'))).catch((error) => { archiveError = error; status = 'Prediction History storage error'; });
let uiTimer = null;
const pending = new Map();     // req_id -> request type and candle granularity

const isActive = () => ['page-tradesignal', 'page-beastmode'].some((id) => { const p = $(id); return !!p && p.classList.contains('active'); });
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
    if (m.error) { if (pending.has(m.req_id)) onCandles(m.req_id, null); if (pendingExpiryTicks.has(m.req_id)) onExpiryTicks(m.req_id, null); return; }
    if (m.msg_type === 'candles' && Array.isArray(m.candles) && pending.has(m.req_id)) onCandles(m.req_id, m.candles);
    if (m.msg_type === 'history' && pending.has(m.req_id)) onCandles(m.req_id, m.history || null);
    if (m.msg_type === 'history' && pendingExpiryTicks.has(m.req_id)) onExpiryTicks(m.req_id, m.history || null);
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
  requestExpiredTicks();
  queue = markets().slice(); total = queue.length; scanned = 0; status = 'scanning';
  next();
}
function next() {
  clearTimeout(marketTimer); pending.clear();
  if (!running) return;
  const sym = queue.shift();
  if (!sym) { status = 'idle'; lastScanAt = Date.now(); render(); clearTimeout(scanTimer); scanTimer = setTimeout(() => { if (isActive()) scan(); else stop(); }, RESCAN_MS); return; }
  const monitorOpen = tracked.some((r) => r.symbol === sym && r.state === 'open');
  const scanTfs = TFS.filter((tf) => tf.g !== 60 || monitorOpen);
  cur = { sym, candles: {}, tick: null, got: 0, want: scanTfs.length + 1 };
  for (const tf of scanTfs) {
    const id = ++reqSeq; pending.set(id, { type: 'candles', g: tf.g });
    send({ ticks_history: symMap[sym] || sym, end: 'latest', count: tf.g === 60 ? 360 : COUNT, style: 'candles', granularity: tf.g, req_id: id });
  }
  const spotId = ++reqSeq; pending.set(spotId, { type: 'spot' });
  send({ ticks_history: symMap[sym] || sym, end: 'latest', count: 1, style: 'ticks', req_id: spotId });
  marketTimer = setTimeout(finishMarket, MARKET_TIMEOUT_MS);
  render();
}
function onCandles(id, candles) {
  const req = pending.get(id); pending.delete(id);
  if (!cur || !req) return;
  if (req.type === 'spot') {
    const times = candles && candles.times, prices = candles && candles.prices;
    if (Array.isArray(times) && times.length && Array.isArray(prices) && prices.length) cur.tick = { epoch: +times[times.length - 1], quote: +prices[prices.length - 1] };
  } else if (candles) cur.candles[req.g] = candles.map((c) => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
  if (++cur.got >= cur.want) finishMarket();
}
function finishMarket() {
  clearTimeout(marketTimer);
  if (!cur) return;
  const { sym, candles, tick } = cur; cur = null;
  const scanTime = nowSec();
  for (const profile of PROFILE_LIST) {
    let sig;
    try { sig = buildTradeSignal({ symbol: sym, label: labelOf(sym), candles, profile, nowSec: scanTime }); }
    catch (e) { sig = { symbol: sym, label: labelOf(sym), profile: profile.id, profileName: profile.name, status: 'insufficient', dir: 0, reason: 'analysis error: ' + e.message, headline: labelOf(sym) + ': analysis error' }; }
    if (tick && Number.isFinite(tick.quote) && tick.quote > 0) { sig.price = tick.quote; sig.entryAt = tick.epoch; sig.detectedAt = scanTime; }
    updateLifecycle(sig, profile, scanTime);
    results.set(sym + '|' + profile.id, { sig, at: Date.now() });
    track(sym, sig, candles[60] || []);
  }
  scanned++; render(); next();
}

function updateLifecycle(sig, profile, at) {
  if (lifecycleLoadError) {
    sig.lifecycleState = 'Insufficient Data';
    sig.waitingCondition = 'lifecycle storage unavailable; existing setup state was not overwritten';
    status = 'lifecycle storage error';
    return;
  }
  try { lifecycleRegistry.update(sig, profile, at); }
  catch (error) { status = 'lifecycle storage error: ' + error.message; sig.waitingCondition = 'could not persist lifecycle state'; }
}

function track(sym, sig, resolutionCandles) {
  const t = nowSec();
  const pid = sig.profile || 'intraday', mine = (r) => r.symbol === sym && (r.profile || 'intraday') === pid && r.state === 'open';
  let open = tracked.find(mine);
  if (open) {
    updateTracked(open, { candles: resolutionCandles, nowSec: t });
    if (open.state !== 'open') {
      const key = sym + '|' + pid;
      try {
        const lifecycle = lifecycleRegistry.close(key, open.resolvedAt || t);
        if (lifecycle) { open.lifecycleState = lifecycle.state; open.lifecycleHistory = lifecycle.lifecycleHistory; }
      } catch (error) { status = 'lifecycle storage error: ' + error.message; }
      archive([open]);
    }
  }
  const lifecycle = lifecycleRegistry.get(sym + '|' + pid);
  if (!tracked.some(mine) && (!lifecycle || lifecycle.state === 'Signal Active')) {
    const entryAt = Number.isFinite(sig.entryAt) ? sig.entryAt : Number.isFinite(sig.detectedAt) ? sig.detectedAt : t;
    const rec = openTracked(sig, entryAt);
    if (rec) tracked.push(rec);
  }
  try { saveTracked(); } catch (_) {}
}
function requestExpiredTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const t = nowSec();
  for (const rec of tracked) {
    if (rec.state !== 'open' || t < rec.expiresAt || (rec._tickRequestedAt && t - rec._tickRequestedAt < 30)) continue;
    const id = ++reqSeq; pendingExpiryTicks.set(id, rec.id); rec._tickRequestedAt = t;
    send({ ticks_history: symMap[rec.symbol] || rec.symbol, start: rec.expiresAt - 30, end: rec.expiresAt, count: 1000, style: 'ticks', req_id: id });
  }
}
function onExpiryTicks(id, history) {
  const recordId = pendingExpiryTicks.get(id); pendingExpiryTicks.delete(id);
  const rec = tracked.find((r) => r.id === recordId && r.state === 'open'); if (!rec) return;
  const times = history && history.times, prices = history && history.prices;
  const ticks = Array.isArray(times) && Array.isArray(prices) ? times.map((epoch, i) => ({ epoch: +epoch, quote: +prices[i] })).filter((tick) => Number.isFinite(tick.epoch) && Number.isFinite(tick.quote)) : [];
  updateTracked(rec, { ticks, nowSec: nowSec() });
  if (rec.state !== 'open') archive([rec]);
  saveTracked(); render();
}

function trackedHtml() {
  const t = nowSec();
  const open = tracked.filter((r) => r.state === 'open').sort((a, b) => a.expiresAt - b.expiresAt);
  const done = tracked.filter((r) => r.state !== 'open').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0)).slice(0, 40);
  const s = summarize(tracked);
  const fmtLeft = (sec) => { sec = Math.max(0, sec); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const line = (r) => {
    const endRule = (x) => x.rule === 'end' || (x.rule === 'hold' && x.hit !== 'wrong');
    const buy = r.dir === 1, cls = r.state === 'correct' ? 'ts-ok' : r.state === 'wrong' ? 'ts-bad' : '';
    const mark = r.state === 'correct' ? '<span class="ts-res ok" title="Correct">&#10003;</span>' : r.state === 'wrong' ? '<span class="ts-res bad" title="Wrong">&#10007;</span>' : `<span class="ts-res run" title="Running">${fmtLeft(r.expiresAt - t)}</span>`;
    const why = endRule(r) ? (r.state === 'open' ? (((r.last - r.entry) * r.dir > 0) ? 'currently ' + (r.dir === 1 ? 'above' : 'below') + ' the entry; only the end of the period counts' : 'currently not ' + (r.dir === 1 ? 'above' : 'below') + ' the entry; only the end of the period counts') : r.state === 'correct' ? 'ended ' + (r.dir === 1 ? 'above' : 'below') + ' the entry' : 'ended ' + (r.dir === 1 ? 'at or below' : 'at or above') + ' the entry') + (r.targetHit ? ', target touched (reference only)' : '')
      : r.hit === 'exit' ? 'exited early: ' + esc(r.exitReason || 'opposing reversal')
      : r.hit === 'correct' ? 'target reached first' : r.hit === 'wrong' ? 'invalidation reached first' : (r.state === 'correct' ? 'lapsed, price moved with the signal' : 'lapsed, price moved against the signal');
    return `<div class="ts-trk ${cls}" data-sym="${esc(r.symbol)}" role="button" tabindex="0" title="Open ${esc(r.label)} in Candle Charts">
      ${mark}<span class="ts-main"><b>${esc(r.label)} · ${esc(r.action)} @ ${fmtPrice(r.entry)} <em class="ts-prof">${esc(r.profileName || 'Intraday')} · hold ${esc(r.holdLabel || '30 min')}</em></b>
      <span class="ts-sub">${r.trigger ? 'trigger: ' + esc(r.trigger) + ' · ' : ''}${r.target != null ? 'target ' + fmtPrice(r.target) : 'no target'} · invalidation ${r.invalidation != null ? fmtPrice(r.invalidation) : '—'} · last ${fmtPrice(r.last)} · ${why} · ${new Date(r.openedAt * 1000).toLocaleTimeString()}</span>
      ${r.state === 'open' ? `<span class="ts-bar"><i data-id="${esc(r.id)}" style="width:${(progress(r, t) * 100).toFixed(1)}%"></i></span>` : ''}</span></div>`;
  };
  if (!tracked.length) return '';
  return `<div class="ts-h">Signal results — ${s.open} running · ${s.correct} &#10003; · ${s.wrong} &#10007;${s.hitRate != null ? ' · ' + (s.hitRate * 100).toFixed(0) + '% (n=' + s.resolved + ', not a validated edge)' : ''}</div>`
    + open.map(line).join('') + done.map(line).join('');
}
function tickUi() {
  if (!isActive()) return;
  const t = nowSec(); let expired = false;
  for (const r of tracked) if (r.state === 'open' && t >= r.expiresAt + 1 && !r._late) { expired = true; }
  document.querySelectorAll('#tsList .ts-bar i').forEach((i) => { const r = tracked.find((x) => x.id === i.dataset.id); if (r) i.style.width = (progress(r, t) * 100).toFixed(1) + '%'; });
  document.querySelectorAll('#tsList .ts-res.run').forEach((el) => { const row = el.closest('.ts-trk'); const r = tracked.find((x) => x.id === (row.querySelector('i') || {}).dataset?.id); if (r) { const s = Math.max(0, r.expiresAt - t); el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); } });
  // a lapsed record is resolved by the next scan (needs the candles); trigger one promptly
  if (expired && status === 'idle' && ws) scan();
}

function row(sig) {
  const buy = sig.dir === 1, cls = sig.status === 'signal' ? (buy ? 'ts-buy' : 'ts-sell') : 'ts-wait';
  const trg = sig.trigger ? ` | trigger ${esc(sig.trigger.kind)}: ${esc(sig.trigger.label)}` : '';
  const inv = sig.invalidation ? ` | invalidation ${fmtPrice(sig.invalidation.price)}` : '';
  const model = sig.primaryModel ? sig.primaryModel.name : '?';
  const nearest = sig.nearestLevel != null ? fmtPrice(sig.nearestLevel) : '?';
  const familyText = (sig.familyValues || []).map((f) => `${f.family} ${f.value >= 0 ? '+' : ''}${f.value.toFixed(2)}`).join(' | ');
  return `<div class="ts-row ${cls}" data-sym="${esc(sig.symbol)}" data-key="${esc(sig.symbol + '|' + sig.profile)}" role="button" tabindex="0" title="Open ${esc(sig.label)} in Candle Charts with the stored evidence highlighted">
    <span class="ts-badge">${sig.status === 'watching' ? 'WAIT' : esc(sig.action || '')}</span>
    <span class="ts-main"><b><em class="ts-prof">${esc(sig.profileName || '')} | ${esc(sig.lifecycleState || 'No Setup')}</em> ${esc(sig.headline)}</b>
      <span class="ts-sub">direction ${sig.dir === 1 ? 'Bullish' : sig.dir === -1 ? 'Bearish' : '?'} | evidence balance ${sig.overallBalance == null ? '?' : sig.overallBalance.toFixed(2)} | model ${esc(model)} | waiting for ${esc(sig.waitingCondition || '?')} | nearest ${nearest} | target ${sig.target ? fmtPrice(sig.target.price) : '?'}${inv} | hold ${esc(sig.holdLabel || '?')}${trg}</span>
      ${familyText ? `<span class="ts-sub">families: ${esc(familyText)} (heuristic, provisional)</span>` : ''}</span>
    <span class="ts-go">Open charts</span></div>`;
}
function render() {
  const el = $('tsList'); if (!el) return;
  const all = [...results.values()].map((r) => r.sig);
  if (lifecycleLoadError) status = 'lifecycle storage error';
  if (archiveError) status = 'Prediction History storage error';
  const live = all.filter((s) => s.status === 'signal').sort((a, b) => Math.abs(b.bias.balance) - Math.abs(a.bias.balance));
  const watch = all.filter((s) => s.status === 'watching').sort((a, b) => Math.abs(b.bias.balance) - Math.abs(a.bias.balance));
  const wait = all.filter((s) => s.status === 'wait');
  const rest = all.filter((s) => !['signal', 'watching', 'wait'].includes(s.status));
  const bar = $('tsStatus');
  if (bar) bar.textContent = `${status === 'scanning' ? `scanning ${scanned}/${total}…` : status}${lastScanAt ? ' · last full scan ' + new Date(lastScanAt).toLocaleTimeString() : ''} · ${live.length} entry signal(s) · ${watch.length} watching for a trigger · ${wait.length} opposed`;
  el.innerHTML = trackedHtml() + (live.length ? live.map(row).join('') : `<div class="ts-empty">${status === 'scanning' && !all.length ? 'Scanning markets…' : 'No market has an entry trigger right now (pullback or liquidity sweep).'}</div>`)
    + (watch.length ? `<div class="ts-h">Watching - lean found, waiting for a pullback / swing / liquidity sweep</div>` + watch.map(row).join('') : '')
    + (wait.length ? `<div class="ts-h">Opposed (bias lean, entry timeframe against it)</div>` + wait.map(row).join('') : '')
    + (rest.length ? `<details class="ts-rest"><summary>No setup (${rest.length})</summary>${rest.map((s) => `<div class="ts-none"><b>${esc(s.label)} · ${esc(s.profileName || '')}</b> — ${esc(s.reason || s.headline)}</div>`).join('')}</details>` : '');
}

export function tsStart() {
  if (lifecycleLoadError) status = 'lifecycle storage error: ' + lifecycleLoadError.message;
  if (running) { render(); return; }
  running = true; status = 'connecting'; render();
  clearInterval(uiTimer); uiTimer = setInterval(tickUi, 1000);
  if (!ws) connect(); else scan();
}
export function tsStop() {
  running = false; clearTimeout(scanTimer); clearTimeout(marketTimer); clearInterval(uiTimer);
  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
  status = 'idle';
}
export function tsRescan() { if (running && ws && status !== 'scanning') scan(); else if (!running) tsStart(); }

/** Open Candle Charts on the market with the blue evidence highlight on. */
export function tsOpen(sym, key) {
  const r = results.get(key) || [...results.entries()].find(([k]) => k.startsWith(sym + '|') && results.get(k).sig.status === 'signal')?.[1] || [...results.entries()].find(([k]) => k.startsWith(sym + '|'))?.[1];
  window.__tsFocus = { symbol: sym, headline: r ? r.sig.headline : sym, profile: r?.sig.profile, evidenceSnapshot: r?.sig.evidenceSnapshot || [], entryG: r?.sig.entryG, entryEvidence: r ? { sufficient: true, verdict: r.sig.entry.verdict, balance: r.sig.entry.balance } : null, primaryModel: r?.sig.primaryModel || null, secondaryModels: r?.sig.secondaryModels || [], inducementEvents: r?.sig.inducementEvents || [], lifecycleHistory: r?.sig.lifecycleHistory || [] };
  const chip = $('pa-evid');
  if (chip && !chip.checked) { chip.checked = true; chip.dispatchEvent(new Event('change')); }
  if (typeof window.mfxSwitchMarket === 'function') window.mfxSwitchMarket(sym);
  showPage('candles');
  if (typeof window.mfxTfFocusRefresh === 'function') window.mfxTfFocusRefresh();
}

document.addEventListener('click', (e) => {
  const r = e.target.closest && e.target.closest('#tsList .ts-row, #tsList .ts-trk'); if (r) tsOpen(r.dataset.sym, r.dataset.key);
  if (e.target && e.target.id === 'tsRescan') tsRescan();
});
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && (e.target.classList.contains('ts-row') || e.target.classList.contains('ts-trk'))) { e.preventDefault(); tsOpen(e.target.dataset.sym, e.target.dataset.key); } });
Object.assign(window, { tsStart, tsStop, tsOpen, tsRescan, __tsResults: results });
