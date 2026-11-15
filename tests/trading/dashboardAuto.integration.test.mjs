import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/trading/dashboardAuto.js', 'utf8');

function harness(saved = null, overrides = {}) {
  const inputs = {rfdStake:'1', rfdMultiplier:'2', rfdMarketTP:'2', rfdMarketSL:'3', rfdOverallTP:'5', rfdOverallSL:'5', ...overrides};
  const elements = Object.fromEntries(Object.entries(inputs).map(([id, value]) => [id, {value}]));
  for (const id of ['rfdStatus', 'rfdSummary', 'rfdToggle']) elements[id] = {textContent:''};
  const memory = new Map(saved ? [['mfx.dashboard-auto.session.v1', saved]] : []);
  const sent = [], sockets = [], pending = {}, recovery = new Set();
  let now = 10000;
  class Socket {
    constructor() { this.readyState = 1; sockets.push(this); }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
  }
  const ctx = vm.createContext({
    window: {}, document: {getElementById: id => elements[id] || null},
    navigator: {locks: {request: (key, options, callback) => Promise.resolve(callback({name:key}))}},
    localStorage: {getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value)},
    WebSocket: Socket, Date: {now: () => now * 1000}, console, confirm: () => true,
    setTimeout: (fn, delay) => { if (delay < 10000) fn(); return 1; }, clearTimeout(){},
    setInterval: () => 1, clearInterval(){},
    gridAuthed: true, gridLoginId: 'DEMO', gridIsVirtual: true, gridBalance: 1000, gridCurrency: 'USD',
    gridReqId: 1000, gridPending: pending, gridRecoveryRequests: recovery,
    gridWs: {readyState:1, send: text => sent.push(JSON.parse(text))},
  });
  vm.runInContext(source, ctx);
  const bot = ctx.window.MFXDashboardAuto;
  bot.noteBalance('DEMO', 1000);
  const state = () => JSON.parse(memory.get('mfx.dashboard-auto.session.v1'));
  const feed = () => sockets.at(-1);
  function message(value) { feed().onmessage({data:JSON.stringify(value)}); }
  function prime(symbol = 'R_10', bearish = false) {
    let price = 100;
    const prices = [], times = [];
    for (let i = 0; i <= 199; i++) {
      if (i) price += i <= 140 ? (i % 2 ? 1 : -1) : 1;
      prices.push(bearish ? -price : price); times.push(9800 + i);
    }
    message({echo_req:{ticks_history:symbol}, history:{prices,times}});
    const candles = Array.from({length: 120}, (_, i) => {
      const close = bearish ? 200 - i : i + 1;
      return {epoch: 2760 + i * 60, high: close + 1, low: close - 1, close};
    });
    message({echo_req:{ticks_history:symbol}, candles});
    tick(symbol, bearish ? -(price + 1) : price + 1);
  }
  function tick(symbol, price, epoch = 10000) { message({tick:{symbol, quote:price, epoch}}); }
  async function start() { await bot.toggle(); feed().onopen(); }
  function proposal() { return sent.filter(x => x.proposal).at(-1); }
  function buy(id = 123) {
    const p = proposal(); assert.ok(p);
    pending[p.req_id]({id:'quote', ask_price:p.amount}, null);
    const b = sent.filter(x => x.buy).at(-1); assert.ok(b);
    pending[b.req_id]({contract_id:id, buy_price:p.amount}, null);
    return b;
  }
  return {ctx, bot, state, sent, pending, recovery, elements, memory, feed, message, prime, tick, start, proposal, buy, setTime(value){now = value;}};
}

test('accepted trade immediately requests a second and never exceeds two in flight', async () => {
  const h = harness();
  await h.start();
  h.prime();
  assert.equal(h.proposal().contract_type, 'CALL');
  assert.equal(h.proposal().duration, 1);
  assert.equal(h.proposal().amount, 1);
  h.prime('R_25');
  assert.equal(h.sent.filter(x => x.proposal).length, 1);
  h.buy();
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  assert.equal(h.proposal().amount, 1);
  h.buy(124);
  h.tick('R_10', 160);
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  assert.equal(h.state().openTrades.length, 2);
  assert.equal(h.bot.handleContract({contract_id:123,is_sold:1,profit:-1}), true);
  assert.equal(h.proposal().amount, 2);
  assert.equal(h.proposal().underlying_symbol, 'R_10');
});

test('overall profit and loss limits stop with the actual P/L and cannot restart', async () => {
  for (const pnl of [5, -5]) {
    const h = harness();
    await h.start(); h.prime(); h.buy();
    h.bot.handleContract({contract_id:123,is_sold:1,profit:pnl});
    assert.match(h.elements.rfdStatus.textContent, pnl > 0 ? /Overall take profit reached: 5.00/ : /Overall stop loss reached: -5.00/);
    await h.bot.toggle();
    assert.match(h.elements.rfdStatus.textContent, /reset to start a new session/);
  }
});

test('market limit waits for the other trade and assigns its result to the original market', async () => {
  const h = harness(null, {rfdMarketTP:'1', rfdOverallTP:'10'});
  await h.start(); h.prime(); h.buy();
  h.buy(124);
  h.bot.handleContract({contract_id:124,is_sold:1,profit:1.2});
  assert.equal(h.state().active, 'R_10');
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  h.prime('R_25');
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-0.5});
  assert.equal(h.state().active, null);
  assert.equal(h.state().total, 0.7);
  assert.equal(h.state().nextStake, 1);
  assert.match(h.elements.rfdStatus.textContent, /Market take profit reached.*final market P\/L: 0.70/);
  h.tick('R_25', 160);
  assert.equal(h.proposal().underlying_symbol, 'R_25');
});

test('continues in the original direction even if the signal reverses', async () => {
  const h = harness(null, {rfdMarketTP:'4', rfdMarketSL:'8', rfdOverallSL:'20'});
  await h.start(); h.prime('R_10', true); h.buy(); h.buy(124);
  let price = -160;
  for (let i = 0; i < 100; i++) h.tick('R_10', ++price);
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  assert.equal(h.sent.filter(x => x.proposal).length, 3);
  assert.equal(h.proposal().contract_type, 'PUT');
  assert.equal(h.proposal().amount, 2);
  h.buy(125);
  h.bot.handleContract({contract_id:124,is_sold:1,profit:1});
  assert.equal(h.sent.filter(x => x.proposal).length, 4);
  assert.equal(h.proposal().contract_type, 'PUT');
  assert.equal(h.proposal().amount, 1);
});

test('does not place a replacement with stale market data', async () => {
  const h = harness();
  await h.start(); h.prime(); h.buy(); h.buy(124);
  h.setTime(10020);
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  h.tick('R_10', 100, 10020);
  assert.equal(h.sent.filter(x => x.proposal).length, 3);
  assert.equal(h.proposal().contract_type, 'CALL');
  assert.equal(h.proposal().amount, 2);
});

test('recovered settlement while stopped never starts another trade', async () => {
  const h = harness();
  await h.start(); h.prime(); h.buy();
  await h.bot.toggle();
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  assert.equal(h.state().trade, null);
  assert.equal(h.state().direction, 'RISE');
});

test('preserves the locked direction after restart', async () => {
  const h = harness();
  await h.start(); h.prime(); h.buy();
  await h.bot.toggle();
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  const reloaded = harness(JSON.stringify(h.state()));
  await reloaded.start();
  reloaded.tick('R_10', 100);
  assert.equal(reloaded.proposal().contract_type, 'CALL');
  assert.equal(reloaded.proposal().amount, 2);
});

test('disconnected pending buy is persisted as unknown and blocks restart', async () => {
  const h = harness();
  await h.start(); h.prime();
  const p = h.proposal();
  h.pending[p.req_id]({id:'quote', ask_price:1});
  h.bot.interrupted();
  assert.equal(h.state().trade.phase, 'unknown');
  await h.bot.toggle();
  assert.match(h.elements.rfdStatus.textContent, /reconcile/);
  const reload = harness(JSON.stringify(h.state()));
  await reload.bot.toggle();
  assert.match(reload.elements.rfdStatus.textContent, /reconcile/);
});

test('known contracts recover after restart and settle exactly once', async () => {
  const h = harness();
  await h.start(); h.prime(); h.buy();
  const saved = JSON.stringify(h.state());
  h.bot.interrupted();
  const reload = harness(saved);
  await new Promise(resolve => setImmediate(resolve));
  const request = reload.sent.find(x => x.proposal_open_contract);
  assert.equal(request.contract_id, 123);
  reload.pending[request.req_id]({contract_id:123, is_sold:1, profit:0.8}, null);
  assert.equal(reload.state().total, 0.8);
  assert.equal(reload.bot.handleContract({contract_id:123,is_sold:1,profit:0.8}), false);
  assert.equal(reload.state().total, 0.8);
});

test('recovers two open contracts independently and only once in either order', async () => {
  const h = harness(null, {rfdMarketTP:'10', rfdMarketSL:'10', rfdOverallTP:'20', rfdOverallSL:'20'});
  await h.start(); h.prime(); h.buy(); h.buy(124);
  const reload = harness(JSON.stringify(h.state()));
  await new Promise(resolve => setImmediate(resolve));
  const requests = reload.sent.filter(x => x.proposal_open_contract);
  assert.deepEqual(requests.map(x => x.contract_id).sort(), [123, 124]);
  reload.pending[requests[1].req_id]({contract_id:124,is_sold:1,profit:-1}, null);
  assert.equal(reload.state().openTrades.length, 1);
  assert.equal(reload.bot.handleContract({contract_id:124,is_sold:1,profit:-1}), false);
  reload.pending[requests[0].req_id]({contract_id:123,is_sold:1,profit:0.8}, null);
  assert.equal(reload.state().openTrades.length, 0);
  assert.ok(Math.abs(reload.state().total + 0.2) < 1e-9);
  assert.equal(reload.sent.filter(x => x.proposal).length, 0);
});

test('overall stop is latched even if another outstanding win reverses the P/L', async () => {
  const h = harness(null, {rfdOverallSL:'1', rfdMarketSL:'10'});
  await h.start(); h.prime(); h.buy(); h.buy(124);
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  assert.match(h.elements.rfdStatus.textContent, /Overall stop loss reached/);
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  h.bot.handleContract({contract_id:124,is_sold:1,profit:2});
  assert.equal(h.state().total, 1);
  assert.match(h.elements.rfdStatus.textContent, /Overall stop loss reached.*final P\/L: 1.00/);
  await h.bot.toggle();
  assert.match(h.elements.rfdStatus.textContent, /reset to start a new session/);
});

test('a limit reached while a buy is pending waits for its acceptance and settlement', async () => {
  const h = harness(null, {rfdMarketSL:'1', rfdOverallSL:'10'});
  await h.start(); h.prime(); h.buy();
  const proposal = h.proposal();
  h.pending[proposal.req_id]({id:'quote2',ask_price:1}, null);
  const buy = h.sent.filter(x => x.buy).at(-1);
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  assert.equal(h.state().active, 'R_10');
  assert.ok(h.state().closingMarket);
  h.pending[buy.req_id]({contract_id:124,buy_price:1}, null);
  assert.equal(h.sent.filter(x => x.proposal).length, 2);
  h.bot.handleContract({contract_id:124,is_sold:1,profit:-1});
  assert.equal(h.state().active, null);
  assert.match(h.elements.rfdStatus.textContent, /final market P\/L: -2.00/);
});

test('a settlement cancels an unaccepted proposal and reprices from the latest result', async () => {
  const h = harness();
  await h.start(); h.prime(); h.buy();
  const old = h.proposal(), callback = h.pending[old.req_id];
  h.bot.handleContract({contract_id:123,is_sold:1,profit:-1});
  assert.notEqual(h.proposal().req_id, old.req_id);
  assert.equal(h.proposal().amount, 2);
  callback({id:'old',ask_price:1}, null);
  assert.equal(h.sent.filter(x => x.buy).length, 1);
});

test('rejects short earlier window and stale prices or candles', () => {
  const h = harness();
  const now = 10000;
  const candles = Array.from({length:60}, (_, i) => ({epoch: 6420+i*60, high:i+2, low:i, close:i+1}));
  const ticks = Array.from({length:180}, (_, i) => ({time:9821+i, price:i < 120 ? 100 + i%2 : 100 + i - 120}));
  assert.equal(h.bot.signal(ticks.slice(-120), candles, now), null);
  assert.equal(h.bot.signal(ticks, candles, now + 11), null);
  assert.equal(h.bot.signal(ticks, candles.slice(0, 56), now), null);
});

test('excludes equal ticks and requires at least 56 percent and a greater than 0.3 point increase', () => {
  const h = harness();
  const candles = Array.from({length:60}, (_, i) => ({epoch: 6420+i*60, high:i+2, low:i, close:i+1}));
  function ticksFor(currentRise, currentFall, currentEqual, priorRise) {
    const directions = Array(40).fill(1)
      .concat(Array(60).fill(1).map((_, i) => i < priorRise ? 1 : -1))
      .concat(Array(currentEqual).fill(0), Array(currentFall).fill(-1), Array(currentRise).fill(1));
    let price = 100;
    return [{time:9800, price}].concat(directions.map((d, i) => ({time:9801+i, price:price += d})));
  }
  assert.equal(h.bot.signal(ticksFor(56,44,0,20), candles, 10000), 'RISE');
  assert.equal(h.bot.signal(ticksFor(55,45,0,20), candles, 10000), null);
  assert.equal(h.bot.signal(ticksFor(56,44,0,56), candles, 10000), null);
  assert.equal(h.bot.signal(ticksFor(28,22,50,20), candles, 10000), 'RISE');
});

test('a stopped or disconnected pending proposal cannot submit a buy', async () => {
  for (const disconnect of [false, true]) {
    const h = harness();
    await h.start(); h.prime();
    const p = h.proposal(), callback = h.pending[p.req_id];
    if (disconnect) h.bot.interrupted(); else await h.bot.toggle();
    callback({id:'quote', ask_price:1}, null);
    assert.equal(h.sent.filter(x => x.buy).length, 0);
    assert.equal(h.state().trade, null);
  }
});

test('a signal that disappears while the proposal is pending cannot be bought', async () => {
  const h = harness();
  await h.start(); h.prime();
  const p = h.proposal();
  let price = 160;
  for (let i = 0; i < 100; i++) h.tick('R_10', --price);
  h.pending[p.req_id]({id:'quote', ask_price:1}, null);
  assert.equal(h.sent.filter(x => x.buy).length, 0);
  assert.equal(h.state().trade, null);
  assert.match(h.elements.rfdStatus.textContent, /signal or connection changed/);
});

test('ambiguous settlement leaves the contract unresolved and blocks trading', async () => {
  const h = harness();
  await h.start(); h.prime(); h.buy();
  h.bot.handleContract({contract_id:123,is_sold:1,profit:0});
  assert.equal(h.state().openTrades[0].phase, 'open');
  assert.match(h.elements.rfdStatus.textContent, /outcome unavailable/);
  await h.bot.toggle();
  assert.match(h.elements.rfdStatus.textContent, /reconcile/);
});

test('requires a current account balance before starting or buying', async () => {
  const h = harness();
  h.bot.noteBalance('OTHER', 1000);
  await h.bot.toggle();
  assert.match(h.elements.rfdStatus.textContent, /balance/);
  h.bot.noteBalance('DEMO', 1000);
  await h.start(); h.prime();
  h.bot.noteBalance('OTHER', 1000);
  const p = h.proposal();
  h.pending[p.req_id]({id:'quote',ask_price:1}, null);
  assert.equal(h.sent.filter(x => x.buy).length, 0);
  assert.match(h.elements.rfdStatus.textContent, /balance/);
});

test('a reload while buy confirmation is pending remains unknown', async () => {
  const h = harness();
  await h.start(); h.prime();
  h.pending[h.proposal().req_id]({id:'quote', ask_price:1});
  assert.equal(h.state().trade.phase, 'buy_pending');
  const reloaded = harness(JSON.stringify(h.state()));
  await reloaded.bot.toggle();
  assert.match(reloaded.elements.rfdStatus.textContent, /reconcile/);
  assert.equal(reloaded.sent.filter(x => x.buy).length, 0);
});

test('proposal rejection stops and never sends an order', async () => {
  const h = harness();
  await h.start(); h.prime();
  h.pending[h.proposal().req_id](null, {message:'market closed'});
  assert.match(h.elements.rfdStatus.textContent, /market closed/);
  assert.equal(h.state().trade, null);
  assert.equal(h.sent.filter(x => x.buy).length, 0);
});

test('unknown-buy reset requires reconnecting to the original account', async () => {
  const h = harness();
  await h.start(); h.prime();
  h.pending[h.proposal().req_id]({id:'quote', ask_price:1});
  h.bot.interrupted();
  h.ctx.gridLoginId = 'OTHER';
  await h.bot.reset();
  assert.equal(h.state().trade.phase, 'unknown');
  assert.match(h.elements.rfdStatus.textContent, /original account DEMO/);
});
