// Beast Mode page: joins Bazu's live prediction with the Trade Signal setups (see beastMode.js), records every combined
// signal and follows it to the end of Bazu's predicted window. Read-only: it never places orders.
import { combine, openBeast, updateBeast, progress, summarize } from './beastMode.js';

const KEY = 'mfx_beast_v1', KEEP = 500;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fp = (p, dp) => (p == null || !Number.isFinite(p) ? '—' : p.toFixed(dp ?? (Math.abs(p) >= 1000 ? 2 : Math.abs(p) >= 100 ? 3 : 4)));
const clock = (s) => { s = Math.max(0, Math.ceil(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const nowSec = () => Math.floor(Date.now() / 1000);

let recs = [];
try { recs = JSON.parse(localStorage.getItem(KEY) || '[]').filter((r) => r && r.id); } catch (_) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(recs.slice(-KEEP))); } catch (_) {} };
let timer = null, lastHtml = '';
const isActive = () => { const p = $('page-beastmode'); return !!p && p.classList.contains('active'); };

function tradeSigsFor(sym) {
  const R = window.__tsResults; if (!R) return [];
  return [...R.entries()].filter(([k]) => k.startsWith(sym + '|')).map(([, v]) => v.sig);
}

function tick() {
  if (!isActive()) { stop(); return; }
  const t = nowSec();
  const live = typeof window.bazuLiveSignals === 'function' ? window.bazuLiveSignals() : [];
  const bySym = new Map(live.map((m) => [m.symbol, m]));
  // follow open records
  for (const r of recs) if (r.state === 'open') { const m = bySym.get(r.symbol); updateBeast(r, m ? m.price : null, t); }
  // combine and open fresh records (one open record per market)
  const rows = [];
  for (const m of live) {
    const combo = combine(m.direction ? m : null, tradeSigsFor(m.symbol));
    rows.push({ m, combo });
    if (combo.state !== 'beast' || recs.some((r) => r.symbol === m.symbol && r.state === 'open')) continue;
    const label = m.name || m.symbol, probe = openBeast(m.symbol, label, combo, m, m.price, t);
    if (probe && !recs.some((r) => r.key === probe.key)) recs.push(probe);
  }
  save();
  render(rows, t);
}

const STATE_TXT = { beast: 'BEAST — Bazu and Trade Signal agree', conflict: 'Conflict — Bazu and Trade Signal disagree (not recorded)', 'bazu-only': 'Bazu only — no matching Trade Signal entry', 'trade-only': 'Trade Signal only — Bazu not tradable', watching: 'Trade Signal watching for a trigger', none: 'No signal' };

function render(rows, t) {
  const el = $('bmList'); if (!el) return;
  const s = summarize(recs);
  const bar = $('bmStatus');
  const bz = typeof window.bazuLiveSignals === 'function', ts = window.__tsResults && window.__tsResults.size;
  if (bar) bar.textContent = `Bazu feed: ${bz && rows.length ? rows.length + ' markets' : 'waiting'} · Trade Signal scan: ${ts ? ts + ' results' : 'waiting'} · ${s.open} running · ${s.correct} ✓ · ${s.wrong} ✗${s.void ? ' · ' + s.void + ' unscored' : ''}${s.hitRate != null ? ' · ' + (s.hitRate * 100).toFixed(0) + '% of ' + s.n + ' (descriptive only, not a validated edge)' : ''}`;
  const open = recs.filter((r) => r.state === 'open').sort((a, b) => a.expiresAt - b.expiresAt);
  const done = recs.filter((r) => r.state !== 'open').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 60);
  const run = (r) => {
    const m = rows.find((x) => x.m.symbol === r.symbol), dp = m && m.m.dp, spot = m && m.m.price > 0 ? m.m.price : r.last;
    const d = (spot - r.entry) * r.dir, cls = d > 0 ? 'up' : d < 0 ? 'dn' : 'mu';
    return `<div class="bm-row" data-sym="${esc(r.symbol)}" data-prof="${esc(r.profile)}" role="button" tabindex="0">
      <span class="bm-badge ${r.dir === 1 ? 'up' : 'dn'}">${esc(r.side)}</span>
      <span class="ts-main"><b>${esc(r.label)} · ${esc(r.bazuDuration)} <em class="ts-prof">${esc(r.profile)}</em></b>
        <span class="ts-sub">entry ${fp(r.entry, dp)} → ${fp(spot, dp)} <b class="${cls}">${d > 0 ? 'in favour' : d < 0 ? 'against' : 'level'} ${d >= 0 ? '+' : ''}${d.toFixed(dp ?? 3)}</b> · Bazu strength ${(r.bazuStrength * 100).toFixed(0)}% · trigger ${esc(r.trigger || '—')} · target ${fp(r.target, dp)} · invalidation ${fp(r.invalidation, dp)}${r.touch ? ' · <b>' + esc(r.touch) + ' touched</b>' : ''}</span>
        <span class="ts-bar"><i style="width:${(progress(r, t) * 100).toFixed(1)}%"></i></span></span>
      <span class="ts-res run">${clock(r.expiresAt - t)}</span></div>`;
  };
  const hist = (r) => `<tr class="bm-hr" data-sym="${esc(r.symbol)}" data-prof="${esc(r.profile)}"><td class="${r.state === 'correct' ? 'ph-ok' : r.state === 'wrong' ? 'ph-bad' : 'mu'}">${r.state === 'correct' ? '&#10003;' : r.state === 'wrong' ? '&#10007;' : '—'}</td><td>${new Date(r.openedAt * 1000).toLocaleTimeString()}</td><td>${esc(r.label)}</td><td>${esc(r.side)} ${esc(r.bazuDuration)}</td><td>${esc(r.profile)}</td><td>${fp(r.entry)}</td><td>${fp(r.exit ?? r.last)}</td><td>${r.touch ? esc(r.touch) : '—'}</td><td>${r.state === 'void' ? 'unscored (not followed at expiry)' : r.state === 'correct' ? 'exit moved with the signal' : 'exit not beyond entry (tie loses)'}</td></tr>`;
  const other = rows.filter((x) => x.combo.state !== 'none' && x.combo.state !== 'beast').sort((a, b) => (a.combo.state === 'conflict' ? 0 : 1) - (b.combo.state === 'conflict' ? 0 : 1));
  const html = `<div class="ts-h">Running beast signals</div>` + (open.length ? open.map(run).join('') : '<div class="ts-empty">None right now. A beast signal appears only when Bazu has a tradable Rise/Fall and a Trade Signal entry in the same direction.</div>')
    + `<div class="ts-h">Not combined (${other.length})</div>` + (other.length ? other.map((x) => `<div class="ts-none"><b>${esc(x.m.name || x.m.symbol)}</b> — ${esc(STATE_TXT[x.combo.state])}</div>`).join('') : '<div class="ts-none">—</div>')
    + `<div class="ts-h">Beast history</div>` + (done.length ? `<table class="ph-t"><thead><tr><th></th><th>Opened</th><th>Market</th><th>Bazu</th><th>Trade Signal</th><th>Entry</th><th>Exit</th><th>Touched</th><th>Result</th></tr></thead><tbody>${done.map(hist).join('')}</tbody></table>` : '<div class="ts-none">No completed beast signals yet.</div>');
  if (html !== lastHtml) { lastHtml = html; el.innerHTML = html; }
}

export function bmStart() {
  if (typeof window.tsStart === 'function') window.tsStart();   // the Trade Signal scanner feeds this page
  clearInterval(timer); timer = setInterval(tick, 1000); tick();
}
export function bmStop() { clearInterval(timer); timer = null; }
function stop() { bmStop(); }

function csv() {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['symbol,side,bazu_duration,profile,opened_utc,expires_utc,entry,exit,target,invalidation,touched,result'];
  for (const r of recs) lines.push([r.symbol, r.side, r.bazuDuration, r.profile, new Date(r.openedAt * 1000).toISOString(), new Date(r.expiresAt * 1000).toISOString(), r.entry, r.exit ?? r.last, r.target, r.invalidation, r.touch, r.state].map(q).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = 'beast-mode-history.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', (e) => {
  const t = e.target; if (!t) return;
  if (t.id === 'bmCsv') csv();
  if (t.id === 'bmClear' && window.confirm('Delete all beast signal records?')) { recs = recs.filter((r) => r.state === 'open'); save(); lastHtml = ''; tick(); }
  const r = t.closest && t.closest('#bmList .bm-row, #bmList .bm-hr');
  if (r && window.tsOpen) window.tsOpen(r.dataset.sym, r.dataset.sym + '|' + String(r.dataset.prof || '').toLowerCase());
});
Object.assign(window, { bmStart, bmStop, __beastRecords: () => recs });
