import { findSignal } from './tests/bazu/siglogSupport3m.mjs';
import { buildRecord, finalizeF, finalizeG, validateRecord, gReady } from './src/bazu/siglog3m.js';
const f = findSignal({ from: 6000 });
const rec = buildRecord({ sig: f.sig, cfg: f.cfg, symbol: f.symbol, prices: f.w.p, epochs: f.w.e, remote: f.remote, trade: null });
console.log('A-E', validateRecord(rec));
const pr = f.w.p.slice(0, f.k + 2000), ep = f.w.e.slice(0, f.k + 2000);
const r2 = finalizeF(rec, { prices: pr, epochs: ep });
console.log('F', validateRecord(r2), r2.F.result, r2.F.hypothetical_outcomes.length, r2.F.hindsight?.factors.length, gReady(r2, ep.at(-1)));
const r3 = finalizeG(r2, { prices: pr, epochs: ep });
console.log('G', validateRecord(r3), JSON.stringify(r3.G).slice(0, 300));
console.log(f.sig.votes?.length, f.sig.votes?.slice(0,2), Object.keys(f.sig.families||{}), r2.E.inputs.votes.length, JSON.stringify(r2.E.e4).slice(0,300))


