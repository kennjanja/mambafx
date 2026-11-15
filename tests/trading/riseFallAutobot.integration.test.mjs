import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as signal from '../../src/trading/riseFallSignal.mjs';

const html = readFileSync('index.html', 'utf8');
const start = html.indexOf('// Rise/Fall Autobot — Market Control & Confidence Engine');
const end = html.indexOf('// Bullish FVG:', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

test('the legacy reversal detector is not loaded by the application', () => {
  assert.doesNotMatch(html, /src\/trading\/reversalAutoState\.mjs/);
  assert.doesNotMatch(source, /createReversalDetector|MFXReversalAutoState/);
});

function harness(overrides = {}){
  const inputs = {
    rfaStake: '1', rfaMult: '2', rfaMaxLevel: '2',
    rfaMarketTarget: '2', rfaTargetProfit: '20', rfaStopLoss: '20',
    ...overrides,
  };
  const elements = Object.fromEntries(Object.entries(inputs).map(([k, value]) => [k, { value }]));
  const sent = [];
  const pending = {};
  const ctx = vm.createContext({
    window: { MFXRiseFallSignal: signal }, MARKETS: { A: 'A', B: 'B' },
    $: id => elements[id] || null, gridSet(){}, console, setTimeout: fn => fn(),
    Date: { now: () => 10000 * 1000 },
    gridWs: { readyState: 1, send: text => sent.push(JSON.parse(text)) },
    gridAuthed: true, gridBalance: 1000, gridCurrency: 'USD', gridLoginId: 'DEMO',
    gridPending: pending, gridReqId: 0, fmtTime: () => '', alert(){}, confirm: () => true,
    macd: () => ({ macd: 2, signal: 1 }), emaLast: () => 1,
    makeMultiplier(getStake, getMult){
      let next = Number(getStake().value);
      return {
        getNext(){ return next; },
        record(stake, won){ next = won ? Number(getStake().value) : stake * getMult(); },
        reset(){ next = Number(getStake().value); },
      };
    },
  });
  vm.runInContext(source, ctx);
  vm.runInContext(`
    rfaWs = { readyState: 1, send: text => gridWs.send(text) };
    rfaConnected = true;
    rfaUniverseReady = true;
    for (const sym of ['A', 'B']) {
      RFA_MARKETS.push(sym);
      rfaMarketState[sym] = { candles: [], dmiFn: rfaMakeDmiTracker() };
    }
    rfaMarketControl = () => ({bias: 'bullish'});
    for (const st of Object.values(rfaMarketState)) {
      st.candles = Array.from({length: 62}, (_, i) =>
        ({epoch: 6300 + i * 60, open: i, high: i + 2, low: i, close: i + 1}));
    }
    rfaToggleReversal();
  `, ctx);
  const run = text => vm.runInContext(text, ctx);
  const tick = (symbol, price) => { ctx.sym = symbol; ctx.price = price; run('rfaOnTick(sym, price, 10000)'); };
  const prime = symbol => {
    let price = 100;
    tick(symbol, price);
    for (const c of [-1, -1, ...Array(27).fill(1), ...Array(20).fill(-1), 1]) tick(symbol, price += c);
    return price;
  };
  const settle = (profit, id = 100) => {
    const proposal = sent.filter(x => x.proposal).at(-1);
    assert.ok(proposal);
    pending[proposal.req_id]({ id: 'proposal', ask_price: proposal.amount });
    const buy = sent.filter(x => x.buy).at(-1);
    pending[buy.req_id]({ contract_id: id, buy_price: proposal.amount });
    ctx.pnl = profit;
    ctx.id = String(id);
    run('rfaOpenContracts[id].pnl = pnl; rfaSettleContract(id, pnl > 0)');
  };
  return { ctx, run, tick, prime, settle, sent, elements, pending };
}

test('active symbol response wires all discovered markets to tick and candle feeds', () => {
  const h = harness();
  h.run(`rfaUniverseReqId = 99; rfaHandleMsg({
    msg_type: 'active_symbols', req_id: 99,
    active_symbols: [
      { underlying_symbol: '1HZ15V', underlying_symbol_name: 'Volatility 15 (1s) Index', market: 'synthetic_index' },
      { symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index' },
    ],
  })`);
  assert.equal(h.run('RFA_MARKETS.length'), 2);
  assert.deepEqual(h.sent.filter(x => x.ticks).map(x => x.ticks), ['1HZ15V', 'R_100']);
  assert.deepEqual(h.sent.filter(x => x.ticks_history).map(x => x.ticks_history), ['1HZ15V', 'R_100']);
});

test('one market trades at a time; it waits for settlement and a fresh trigger', () => {
  const h = harness();
  let a = h.prime('A');
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
  h.prime('B');
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
  h.settle(-1);
  assert.equal(h.run('rfaReversal.activeSymbol'), 'A');
  h.tick('A', a);
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
  // Rebuild a fresh qualifying window after the unchanged tick.
  h.run('rfaMarketState.A.sample = null');
  a = h.prime('A');
  // The restarted window itself produces the next qualifying trade.
  const proposals = h.sent.filter(x => x.proposal);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].contract_type, 'CALL');
  assert.equal(proposals[1].contract_type, 'CALL');
  assert.equal(proposals[1].amount, 2);
  assert.equal(proposals[1].underlying_symbol, 'A');
});

test('bearish trend and rising Fall percentage submit a PUT', () => {
  const h = harness();
  h.run("rfaMarketControl = () => ({bias: 'bearish'})");
  let price = 100;
  h.tick('A', price);
  for (const change of [1, 1, ...Array(27).fill(-1), ...Array(20).fill(1), -1]) h.tick('A', price += change);
  assert.equal(h.sent.filter(x => x.proposal).at(-1).contract_type, 'PUT');
});

test('market loss limit rotates to another market and resets its stake', () => {
  const h = harness();
  let a = h.prime('A');
  h.settle(-1, 100);
  h.tick('A', a += 1);
  h.settle(-2, 101);
  assert.equal(h.run('rfaReversal.activeSymbol'), null);
  assert.equal(h.run('rfaReversal.lastCompletedSymbol'), 'A');
  const before = h.sent.length;
  h.tick('A', a += 1);
  assert.equal(h.sent.length, before);
  h.prime('B');
  const proposal = h.sent.filter(x => x.proposal).at(-1);
  assert.equal(proposal.underlying_symbol, 'B');
  assert.equal(proposal.amount, 1);
});

test('market profit target rotates, and another completed cycle unlocks the prior market', () => {
  const h = harness({ rfaMarketTarget: '1' });
  let a = h.prime('A');
  h.settle(1, 100);
  assert.equal(h.run('rfaReversal.activeSymbol'), null);
  const count = h.sent.filter(x => x.proposal).length;
  h.tick('A', a += 1);
  assert.equal(h.sent.filter(x => x.proposal).length, count);
  h.prime('B');
  h.settle(1, 101);
  assert.equal(h.run('rfaReversal.lastCompletedSymbol'), 'B');
  h.run('rfaMarketState.A.sample = null');
  h.prime('A');
  assert.equal(h.sent.filter(x => x.proposal).at(-1).underlying_symbol, 'A');
});

test('overall net loss stops the bot immediately upon settlement', () => {
  const h = harness({ rfaStopLoss: '1' });
  h.prime('A');
  h.settle(-1);
  assert.equal(h.run('rfaReversal.running'), false);
  h.prime('B');
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
});

test('overall profit target stops immediately even when market target is not reached', () => {
  const h = harness({ rfaTargetProfit: '1', rfaMarketTarget: '10' });
  h.prime('A');
  h.settle(1);
  assert.equal(h.run('rfaReversal.running'), false);
  h.prime('B');
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
});

test('start fails closed without all risk settings', () => {
  const h = harness({ rfaMarketTarget: '' });
  assert.equal(h.run('rfaReversal.running'), false);
  h.prime('A');
  assert.equal(h.sent.length, 0);
});

test('trend uses closed candles and refuses stale candle data', () => {
  const h = harness();
  h.run(`rfaMarketControl = candles => ({bias: candles.at(-1).epoch === 9900 ? 'bullish' : 'bearish'})`);
  assert.equal(h.run("rfaClosedTrend(rfaMarketState.A, 10000)"), 'bullish');
  assert.equal(h.run("rfaClosedTrend(rfaMarketState.A, 10200)"), null);
});

test('a disconnected public feed cancels a pending proposal before buy', () => {
  const h = harness();
  h.prime('A');
  const proposal = h.sent.find(x => x.proposal);
  h.run('rfaConnected = false');
  h.pending[proposal.req_id]({ id: 'proposal', ask_price: 1 });
  assert.equal(h.sent.filter(x => x.buy).length, 0);
  assert.equal(h.run('rfaReversal.running'), false);
});

test('a trigger that disappears while a proposal is pending is not bought', () => {
  const h = harness();
  const a = h.prime('A');
  const proposal = h.sent.find(x => x.proposal);
  h.tick('A', a);
  h.pending[proposal.req_id]({ id: 'proposal', ask_price: 1 });
  assert.equal(h.sent.filter(x => x.buy).length, 0);
  assert.equal(h.run('rfaReversal.running'), true);
  assert.equal(h.run("rfaReversalMarket('A').slot.tradeInFlight"), false);
});

test('a rejected proposal stops rather than retrying automatically', () => {
  const h = harness();
  h.prime('A');
  const proposal = h.sent.find(x => x.proposal);
  h.pending[proposal.req_id](null, { message: 'Rejected' });
  assert.equal(h.run('rfaReversal.running'), false);
  h.prime('B');
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
});

test('stale ticks clear the sample and cannot place orders', () => {
  const h = harness();
  h.run("rfaOnTick('A', 100, 9900)");
  assert.equal(h.run('rfaMarketState.A.sampleResult'), null);
  assert.equal(h.sent.length, 0);
});
