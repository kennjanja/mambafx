// SOS / SOW bot page. Scans every market on every timeframe; the moment a closed candle prints a Sign of Strength it buys a
// Rise on a Sign of Strength, Fall on a Sign of Weakness, for a user-set duration (default 15 s), on whichever Deriv account is connected (demo or real).
// Orders go straight to the app's authenticated trading socket (window.gridWs). Results are Deriv's own.
import { GRANULARITIES, detectFresh, tfLabel } from './sosSow.js';
import { isVolatilityAbove100 } from './tradeSignalBot.js';

const KEY = 'mfx_sossow_v1', SET = 'mfx_sossow_set_v1', KEEP = 400, FRESH_SEC = 45, REQ_GAP_MS = 25, POLL_MS = 400;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nowSec = () => Math.floor(Date.now() / 1000);
// Every market: the app's list, the Jump/Step indices, and every open synthetic index Deriv reports.
const known = () => ({ ...(typeof MARKETS !== 'undefined' ? MARKETS : {}), ...(typeof DISABLED_MARKETS !== 'undefined' ? DISABLED_MARKETS : {}) });
const extra = new Map();   // symbol -> display name, from active_symbols
// The bot trades only Volatility indices (R_n and 1HZnV), never Jump, Step, Crash/Boom or other markets.
const isVolatilityIndex = (s) => /^(R_\d+|1HZ\d+V)$/.test(s);
const markets = () => [...new Set([...Object.keys(known()), ...extra.keys()])].filter(isVolatilityIndex);
const labelOf = (s) => known()[s] || extra.get(s) || s;

let recs = [];
try { recs = JSON.parse(localStorage.getItem(KEY) || '[]').filter((r) => r && r.id); } catch (_) {}
for (const r of recs) if (r.state === 'placing') { r.state = 'failed'; r.reason = 'page closed while placing; outcome unknown, check Deriv'; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(recs.slice(-KEEP))); } catch (_) {} };
let cfg = { stake: 1, maxOpen: 3, tfs: GRANULARITIES.slice(), durValue: 15, durUnit: 's', mgOn: false, mgMult: 2, mgSteps: 3 };
try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(SET) || '{}') }; } catch (_) {}
// Deriv Rise/Fall: 1-10 ticks, or at least 15 seconds.
const DUR_LIMITS = { t: [1, 10], s: [15, 86400] };
function clampDuration(value, unit) {
  const u = unit === 't' ? 't' : 's', [lo, hi] = DUR_LIMITS[u], n = Math.round(Number(value));
  return { value: Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : (u === 't' ? 5 : 15), unit: u };
}
const durText = (n, u) => n + (u === 't' ? (n === 1 ? ' tick' : ' ticks') : 's');
const curDur = () => clampDuration(cfg.durValue, cfg.durUnit);
// Martingale: after each consecutive settled loss on this account the stake is multiplied; a win, or more than mgSteps losses in a row, returns it to the base stake.
function martingaleStake(account) {
  if (!cfg.mgOn) return { stake: cfg.stake, step: 0 };
  const settled = recs.filter((x) => x.account === account && (x.state === 'won' || x.state === 'lost')).sort((a, b) => (a.settledAt || 0) - (b.settledAt || 0));
  let losses = 0;
  for (let i = settled.length - 1; i >= 0 && settled[i].state === 'lost'; i--) losses++;
  const step = losses % (Math.max(1, cfg.mgSteps) + 1);
  return { stake: +(cfg.stake * Math.pow(Math.max(1, cfg.mgMult), step)).toFixed(2), step };
}
const saveCfg = () => { try { localStorage.setItem(SET, JSON.stringify(cfg)); } catch (_) {} };

let armed = false, ws = null, endpointIdx = 0, symMap = {}, pollTimer = null, uiTimer = null, running = false, lastSeq = 0;
const seen = new Set(recs.map((r) => r.key));       // events already acted on
const asked = new Map();                            // 'sym|g' -> boundary already requested
const pending = new Map();                          // req_id -> { sym, g, b }
const queue = [];
let sendTimer = null, reqSeq = 9100, lastScanAt = null, lastErr = '';
const watched = new WeakSet();

const acct = () => ({ connected: !!(window.gridWs && window.gridWs.readyState === 1 && window.gridAuthed), demo: window.gridIsVirtual === true, id: window.gridLoginId, ccy: window.gridCurrency || 'USD' });

// ---- data socket (public candles) ----
function send(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }
function connect() {
  const eps = typeof WS_ENDPOINTS !== 'undefined' ? WS_ENDPOINTS : [];
  if (!eps.length) { lastErr = 'no data endpoint'; return; }
  try { ws = new WebSocket(eps[endpointIdx % eps.length]); } catch (_) { return; }
  let opened = false;
  ws.onopen = () => { opened = true; send({ active_symbols: 'brief', req_id: 9099 }); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.req_id === 9099) { onSymbols(m); return; }
    const p = pending.get(m.req_id); if (!p) return;
    pending.delete(m.req_id);
    if (m.msg_type === 'candles' && Array.isArray(m.candles)) onCandles(p, m.candles.map((c) => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close })));
  };
  ws.onclose = () => { ws = null; if (!opened) endpointIdx++; };
  ws.onerror = () => {};
}
function onSymbols(m) {
  const list = m.active_symbols || []; symMap = {};
  for (const x of list) {
    const s = x.underlying_symbol || x.symbol;
    if (s && x.market === 'synthetic_index' && isVolatilityIndex(s) && !isVolatilityAbove100(s, x.display_name || x.underlying_symbol_name || '') && !x.is_trading_suspended && x.exchange_is_open !== 0 && !/^(WLD|CRASH|BOOM)?BASKET/i.test(s) && !/basket/i.test(x.submarket || '')) extra.set(s, x.display_name || x.underlying_symbol_name || s);
  }
  for (const k of markets()) {
    let d = null; try { d = typeof _findDiscoveredSymbol === 'function' ? _findDiscoveredSymbol(list, k) : null; } catch (_) {}
    symMap[k] = d ? (d.underlying_symbol || d.symbol || k) : k;
  }
}
function pump() {
  clearTimeout(sendTimer);
  const j = queue.shift(); if (!j) { sendTimer = null; return; }
  if (nowSec() - j.b <= FRESH_SEC - 5 && ws && ws.readyState === WebSocket.OPEN) {   // skip jobs that went stale in the queue
    const id = ++reqSeq; pending.set(id, j);
    send({ ticks_history: symMap[j.sym] || j.sym, end: 'latest', count: 45, style: 'candles', granularity: j.g, req_id: id });
  }
  sendTimer = setTimeout(pump, REQ_GAP_MS);
}
// Each (market, timeframe) is fetched once, just after its candle boundary has passed.
function poll() {
  if (!running) return;
  if (!ws) connect();
  const t = nowSec();
  if (ws && ws.readyState === WebSocket.OPEN && Object.keys(symMap).length) {
    for (const k of markets()) {
      for (const g of cfg.tfs) {
        const b = Math.floor(t / g) * g, id = k + '|' + g;
        if (t - b > FRESH_SEC - 10 || asked.get(id) === b) continue;
        asked.set(id, b); queue.push({ sym: k, g, b });
      }
    }
    queue.sort((a, c) => a.g - c.g);   // short timeframes first: their window is the tightest
    lastScanAt = Date.now(); if (queue.length && !sendTimer) pump();
  }
  render();
}
function onCandles(p, candles) {
  // The just-closed candle may not be served yet at the exact boundary; ask again at once instead of waiting for the next poll.
  const lastClosed = candles.filter((c) => c.epoch + p.g <= nowSec()).pop();
  if (p.b && (!lastClosed || lastClosed.epoch < p.b - p.g) && (p.n || 0) < 6) { setTimeout(() => { queue.unshift({ ...p, n: (p.n || 0) + 1 }); if (!sendTimer) pump(); }, 300); return; }
  const ev = detectFresh(candles, p.g, nowSec(), FRESH_SEC);
  if (!ev) return;
  const key = p.sym + '|' + ev.g + '|' + ev.candleEpoch + '|' + ev.kind;
  if (seen.has(key)) return;
  seen.add(key);
  const r = { id: 'ss' + Date.now() + Math.random().toString(36).slice(2, 6), key, symbol: p.sym, label: labelOf(p.sym), kind: ev.kind, side: ev.kind === 'SOS' ? 'Rise' : 'Fall', contractType: ev.contractType, tf: ev.tf, g: ev.g, level: ev.level, close: ev.close, at: Date.now(), stake: cfg.stake, state: 'seen', reason: '' };
  recs.push(r);
  if (armed) trade(r); else { r.reason = 'bot off: not traded'; r.state = 'skipped'; }
  save(); render();
}

// ---- trading socket ----
function call(msg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = window.gridWs;
    if (!s || s.readyState !== 1 || !window.gridAuthed) return reject(new Error('Not connected to a Deriv account'));
    const id = (window.gridReqId = (window.gridReqId || 0) + 1);
    const to = setTimeout(() => { delete window.gridPending[id]; reject(new Error('Deriv timeout')); }, timeoutMs);
    window.gridPending[id] = (data, err) => { clearTimeout(to); err ? reject(new Error(err.message || 'Deriv error')) : resolve(data); };
    s.send(JSON.stringify({ ...msg, req_id: id }));
  });
}
function watch() {
  const s = window.gridWs; if (!s || watched.has(s)) return; watched.add(s);
  s.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    const c = m.msg_type === 'proposal_open_contract' && m.proposal_open_contract; if (!c || !c.contract_id) return;
    const r = recs.find((x) => x.contractId === String(c.contract_id)); if (!r || r.state === 'won' || r.state === 'lost') return;
    if (c.entry_tick != null) r.entry = c.entry_tick;
    if (c.is_sold || c.status === 'won' || c.status === 'lost' || c.is_expired) {
      r.exit = c.exit_tick ?? c.sell_spot ?? r.exit; r.profit = Number(c.profit);
      r.state = c.status === 'won' || r.profit > 0 ? 'won' : 'lost'; if (!Number.isFinite(r.profit)) r.state = c.status === 'won' ? 'won' : 'lost';
      r.settledAt = Date.now(); save(); render();
    }
  });
}
async function trade(r) {
  const a = acct();
  const openN = recs.filter((x) => x.state === 'placing' || x.state === 'open').length;
  if (!a.connected) { r.state = 'failed'; r.reason = 'no connected Deriv account'; return; }
  if (recs.some((x) => x !== r && x.symbol === r.symbol && (x.state === 'placing' || x.state === 'open'))) { r.state = 'skipped'; r.reason = 'market already has an open trade'; return; }
  if (openN >= cfg.maxOpen) { r.state = 'skipped'; r.reason = 'max open trades reached'; return; }
  r.state = 'placing'; r.account = a.demo ? 'demo' : 'real'; r.loginId = a.id;
  const mg = martingaleStake(r.account); r.stake = mg.stake; r.mgStep = mg.step;
  const dur = curDur(); r.durValue = dur.value; r.durUnit = dur.unit;
  try {
    watch();
    const sym = symMap[r.symbol] || r.symbol;
    const prop = await call({ proposal: 1, amount: r.stake, basis: 'stake', contract_type: r.contractType, currency: a.ccy, duration: dur.value, duration_unit: dur.unit, underlying_symbol: sym });
    if (!prop || !prop.id) throw new Error('no proposal id from Deriv');
    const buy = await call({ buy: prop.id, price: prop.ask_price });
    const bought = (buy && buy.buy) || buy;   // the host socket hands back the buy object itself
    if (!bought || bought.contract_id == null) throw new Error('Deriv returned no contract id');
    r.contractId = String(bought.contract_id); r.buyPrice = bought.buy_price; r.payout = bought.payout; r.boughtAt = Date.now(); r.state = 'open';
    if (window.gridWs && window.gridWs.readyState === 1) window.gridWs.send(JSON.stringify({ proposal_open_contract: 1, contract_id: Number(r.contractId), subscribe: 1 }));
  } catch (e) { r.state = 'failed'; r.reason = e.message; }
  save(); render();
}

// ---- UI ----
const clockTxt = (ms) => new Date(ms).toLocaleTimeString();
function render() {
  const el = $('ssList'); if (!el) return;
  const a = acct(), open = recs.filter((r) => r.state === 'open' || r.state === 'placing');
  const done = recs.filter((r) => r.state === 'won' || r.state === 'lost');
  const pl = (k) => done.filter((r) => r.account === k).reduce((s, r) => s + (Number.isFinite(r.profit) ? r.profit : 0), 0);
  const st = $('ssStatus');
  if (st) st.innerHTML = `Account: <b class="${a.connected ? (a.demo ? 'ss-demo' : 'ss-real') : ''}">${a.connected ? (a.demo ? 'DEMO' : 'REAL') + ' ' + esc(a.id || '') : 'not connected'}</b> · bot <b>${armed ? 'ON' : 'off'}</b> · scanning ${markets().length} markets × ${cfg.tfs.length} timeframes${lastScanAt ? '' : ' (starting…)'} · ${open.length} open · ${done.filter((r) => r.state === 'won').length} won / ${done.filter((r) => r.state === 'lost').length} lost · P/L demo ${pl('demo').toFixed(2)} · real ${pl('real').toFixed(2)}`;
  const row = (r) => `<tr><td>${clockTxt(r.at)}</td><td>${esc(r.label)}</td><td><b class="${r.kind === 'SOS' ? 'ss-up' : 'ss-dn'}">${r.kind}</b> ${esc(r.tf)}</td><td>${r.side} ${durText(r.durValue || 15, r.durUnit || 's')}</td><td>${r.account ? esc(r.account) : '—'}</td><td>${r.state === 'won' ? '<b class="ss-up">&#10003; won</b>' : r.state === 'lost' ? '<b class="ss-dn">&#10007; lost</b>' : esc(r.state)}</td><td>${r.profit != null && Number.isFinite(r.profit) ? (r.profit >= 0 ? '+' : '') + r.profit.toFixed(2) : '—'}</td><td class="mu">${esc(r.reason || (r.entry != null ? 'entry ' + r.entry + (r.exit != null ? ' exit ' + r.exit : '') : ''))}</td></tr>`;
  const list = recs.slice(-80).reverse();
  const html = list.length ? `<table class="ph-t"><thead><tr><th>Time</th><th>Market</th><th>Event</th><th>Trade</th><th>Account</th><th>Result</th><th>P/L</th><th>Note</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>` : '<div class="ts-empty">No SOS/SOW seen yet. Events appear here the moment a candle closes with one.</div>';
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
  const box = $('ssArm'); if (box) box.checked = armed;
  const bd = $('ssAcctDemo'), br = $('ssAcctReal');
  if (bd && br) { bd.className = a.connected && a.demo ? 'on-demo' : ''; br.className = a.connected && !a.demo ? 'on-real' : ''; }
}
function readInputs() {
  const s = parseFloat(($('ssStake') || {}).value), m = parseInt(($('ssMax') || {}).value, 10);
  if (Number.isFinite(s) && s >= 0.35) cfg.stake = +s.toFixed(2);
  if (Number.isFinite(m) && m >= 1) cfg.maxOpen = m;
  cfg.tfs = GRANULARITIES.filter((g) => { const c = $('ssTf' + g); return c ? c.checked : true; });
  const d = clampDuration(($('ssDur') || {}).value, ($('ssDurUnit') || {}).value);
  cfg.durValue = d.value; cfg.durUnit = d.unit;
  cfg.mgOn = !!(($('ssMg') || {}).checked);
  const mm = parseFloat(($('ssMgMult') || {}).value), ms = parseInt(($('ssMgSteps') || {}).value, 10);
  if (Number.isFinite(mm) && mm >= 1) cfg.mgMult = +mm.toFixed(2);
  if (Number.isFinite(ms) && ms >= 1) cfg.mgSteps = Math.min(ms, 20);
  paintInputs();
  saveCfg();
}
function paintInputs() {
  if ($('ssMg')) $('ssMg').checked = !!cfg.mgOn;
  if ($('ssMgMult')) $('ssMgMult').value = cfg.mgMult; if ($('ssMgSteps')) $('ssMgSteps').value = cfg.mgSteps;
  if ($('ssStake')) $('ssStake').value = cfg.stake; if ($('ssMax')) $('ssMax').value = cfg.maxOpen;
  const d = curDur(), du = $('ssDur'), dun = $('ssDurUnit');
  if (dun) dun.value = d.unit;
  if (du) { du.value = d.value; du.min = DUR_LIMITS[d.unit][0]; du.max = DUR_LIMITS[d.unit][1]; }
  const host = $('ssTfs'); if (host && !host.dataset.done) { host.dataset.done = 1; host.innerHTML = GRANULARITIES.map((g) => `<label><input type="checkbox" id="ssTf${g}" ${cfg.tfs.includes(g) ? 'checked' : ''}> ${tfLabel(g)}</label>`).join(' '); }
}
// Switch the app's Deriv connection between the demo and real account of the current login. The bot is always switched off first.
async function switchAcct(type) {
  const msg = $('ssAcctMsg'), say = (t) => { if (msg) msg.textContent = t; };
  const a = acct();
  if (a.connected && (type === 'demo') === a.demo) { say('already on the ' + type + ' account'); return; }
  armed = false; render();
  const host = window.__ldpeHost;
  if (!host || typeof host.selectAccountType !== 'function') { say('account switch unavailable'); return; }
  say('switching to ' + type + '…');
  let r; try { r = await host.selectAccountType(type); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) { say(r.error || 'switch failed'); return; }
  for (let i = 0; i < 40; i++) {   // wait for the reconnect to authorise on the new account
    await new Promise((res) => setTimeout(res, 500));
    const n = acct(); if (n.connected && (type === 'demo') === n.demo) { say('connected to ' + type + ' ' + (n.id || '') + '. Bot is off; switch it on when ready.'); render(); return; }
  }
  say('still connecting to ' + type + '. Check the Trading Grid page.'); render();
}
function arm(on) {
  if (on) {
    readInputs(); const a = acct();
    if (!a.connected) { window.alert('Connect a Deriv account first.'); render(); return; }
    if (!a.demo && !window.confirm('REAL account ' + (a.id || '') + ': this bot will place REAL-money ' + durText(curDur().value, curDur().unit) + ' trades of ' + cfg.stake + (cfg.mgOn ? ' (Martingale x' + cfg.mgMult + ', up to ' + cfg.mgSteps + ' steps, max stake ' + (cfg.stake * Math.pow(cfg.mgMult, cfg.mgSteps)).toFixed(2) + ')' : '') + ' ' + a.ccy + ' on every SOS/SOW it sees, with no further prompts. Continue?')) { render(); return; }
  }
  armed = on; render();
}

export function ssStart() { paintInputs(); if (!running) { running = true; clearInterval(pollTimer); pollTimer = setInterval(poll, POLL_MS); } poll(); }
export function ssLeave() { if (!armed) { running = false; clearInterval(pollTimer); pollTimer = null; } }
document.addEventListener('change', (e) => { const t = e.target; if (t && t.id === 'ssArm') arm(t.checked); else if (t && /^ss(Stake|Max|Tf|Dur|Mg)/.test(t.id || '')) { readInputs(); } });
document.addEventListener('click', (e) => { const t = e.target; if (t && t.id === 'ssAcctDemo') switchAcct('demo'); if (t && t.id === 'ssAcctReal') switchAcct('real'); if (t && t.id === 'ssCsv') csv(); if (t && t.id === 'ssClear' && window.confirm('Delete the SOS/SOW trade log?')) { recs = recs.filter((r) => r.state === 'open' || r.state === 'placing'); save(); render(); } });
window.addEventListener('pagehide', () => { armed = false; });
function csv() {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['time_utc,market,event,timeframe,side,duration_s,account,stake,state,profit,entry,exit,contract_id,note', ...recs.map((r) => [new Date(r.at).toISOString(), r.symbol, r.kind, r.tf, r.side, r.durValue ? durText(r.durValue, r.durUnit) : '15s', r.account, r.stake, r.state, r.profit, r.entry, r.exit, r.contractId, r.reason].map(q).join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = 'sos-sow-trades.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
Object.assign(window, { ssStart, ssLeave, __sossowRecords: () => recs, __sossowIngest: (sym, g, candles) => onCandles({ sym, g, b: 0 }, candles) });
