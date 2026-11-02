// Prediction History page: archive of every Trade Signal prediction that has lapsed, with its correct/wrong result.
// Read-only view of the archive written by tradeSignalPage.js. Counts are descriptive, not a validated edge.
import { predictionHistoryStore } from './tradeSignalStorage.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fp = (p) => { if (p == null) return '—'; const a = Math.abs(p); return p.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : 5); };
let renderGeneration = 0;
const load = () => predictionHistoryStore.load();
const reason = (r) => r.rule === 'end' || r.rule === 'hold' ? (r.hit === 'wrong' ? 'price went through the entry' : r.state === 'correct' ? 'ended ' + (r.dir === 1 ? 'above' : 'below') + ' the entry' : 'ended ' + (r.dir === 1 ? 'at or below' : 'at or above') + ' the entry') : r.hit === 'correct' ? 'target reached first' : r.hit === 'wrong' ? 'invalidation reached first'
  : (r.state === 'correct' ? 'lapsed, moved with signal' : 'lapsed, moved against signal');

export async function phRender() {
  const el = $('phList'); if (!el) return;
  const generation = ++renderGeneration;
  let all;
  try { all = await load(); } catch (error) { el.textContent = `Prediction History unavailable: ${error.message}`; return; }
  if (generation !== renderGeneration) return;
  all.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  const sel = $('phMarket'), res = $('phResult');
  const markets = [...new Set(all.map((r) => r.label))].sort();
  if (sel && sel.options.length !== markets.length + 1) { const cur = sel.value; sel.innerHTML = '<option value="">All markets</option>' + markets.map((m) => `<option>${esc(m)}</option>`).join(''); sel.value = cur; }
  const rows = all.filter((r) => (!sel || !sel.value || r.label === sel.value) && (!res || !res.value || r.state === res.value));
  const ok = rows.filter((r) => r.state === 'correct').length;
  const sum = $('phSummary');
  if (sum) sum.textContent = rows.length ? `${rows.length} prediction(s) · ${ok} correct · ${rows.length - ok} wrong · ${(ok / rows.length * 100).toFixed(0)}% hit rate (descriptive only; small samples, unvalidated weights — not evidence of an edge)` : 'no archived predictions yet';
  el.innerHTML = rows.length ? `<table class="ph-t"><thead><tr><th></th><th>Closed</th><th>Market</th><th>Side</th><th>Entry</th><th>Target</th><th>Invalidation</th><th>Last</th><th>Model</th><th>Outcome</th></tr></thead><tbody>`
    + rows.map((r) => `<tr class="ph-r" data-sym="${esc(r.symbol)}" title="Open ${esc(r.label)} in Candle Charts"><td class="${r.state === 'correct' ? 'ph-ok' : 'ph-bad'}">${r.state === 'correct' ? '&#10003;' : '&#10007;'}</td><td>${new Date((r.expiresAt || 0) * 1000).toLocaleString()}</td><td>${esc(r.label)}</td><td>${esc(r.action)}</td><td>${fp(r.entry)}</td><td>${fp(r.target)}</td><td>${fp(r.invalidation)}</td><td>${fp(r.last)}</td><td>${esc(r.model_id || 'legacy')}</td><td>${esc(reason(r))}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="ts-empty">Predictions are archived here when their predicted time lapses. Open Trade Signal to scan; monitoring data is persisted for later resolution.</div>';
}
async function csv() {
  let a;
  try { a = await load(); } catch (error) { const el = $('phList'); if (el) el.textContent = `CSV export unavailable: ${error.message}`; return; } const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['symbol,label,action,opened_utc,expired_utc,entry,target,invalidation,last,result,outcome,model_id,model_context,confirmed_at,detected_at,overall_balance,resolution_method,family_values'];
  for (const r of a) lines.push([r.symbol, r.label, r.action, new Date(r.openedAt * 1000).toISOString(), new Date(r.expiresAt * 1000).toISOString(), r.entry, r.target, r.invalidation, r.last, r.state, reason(r), r.model_id, r.model_context, r.confirmedAt, r.detectedAt, r.overallBalance, r.resolution_method, JSON.stringify(r.familyValues)].map(q).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const l = document.createElement('a'); l.href = url; l.download = 'prediction-history.csv'; l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', (e) => {
  const t = e.target; if (!t) return;
  if (t.id === 'phCsv') csv();
  if (t.id === 'phClear' && window.confirm('Delete the whole prediction archive?')) predictionHistoryStore.clear().then(phRender).catch((error) => { const el = $('phList'); if (el) el.textContent = `Could not clear Prediction History: ${error.message}`; });
  const r = t.closest && t.closest('#phList .ph-r'); if (r && window.tsOpen) window.tsOpen(r.dataset.sym);
});
document.addEventListener('change', (e) => { if (e.target && (e.target.id === 'phMarket' || e.target.id === 'phResult')) phRender(); });
window.addEventListener('mfx-prediction-archived', () => { const p = $('page-predhistory'); if (p && p.classList.contains('active')) phRender(); });
window.phRender = phRender;