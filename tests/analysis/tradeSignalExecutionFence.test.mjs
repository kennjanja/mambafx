import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const grid = html.slice(html.indexOf('function tradeSignalExecutionBlockReason(){'), html.indexOf('function gridVolatilityAbove100('));
const bridgeStart = html.indexOf('window.tsBotPlaceTrade = function(');
const bridge = html.slice(bridgeStart, html.indexOf('// =====================================================================', bridgeStart));
assert.ok(grid.includes('function gridPlaceTrade(') && bridge.includes('window.tsBotPlaceTrade'));

function harness() {
  const sent = [], pending = {}, window = { dispatchEvent() {} };
  const context = vm.createContext({
    window, WebSocket: { OPEN: 1 }, gridWs: { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) },
    gridAuthed: true, gridLoginId: 'demo', gridIsVirtual: true, gridOpenContracts: {}, gridPending: pending,
    gridReqId: 0, gridTrades: [], gridCurrency: 'USD', SYMBOL: 'R_10',
    $: () => ({ value: '1' }), gridMultStrat: () => ({}), gridMult: () => ({ getNext: () => 1 }),
    renderGridTrades() {}, gridDiag() {}, alert() {}, CustomEvent: class {},
  });
  vm.runInContext(grid + '\n' + bridge, context);
  return { context, sent, pending, window };
}

test('Trade Signal bridge and direct grid entry fail closed without sending requests', () => {
  const { context, sent, window } = harness();
  for (const source of ['ts-manual', 'ts-auto']) {
    const result = window.tsBotPlaceTrade({ symbol: 'R_10', dir: 1, holdSec: 60 }, source, 1, 'demo', 'signal');
    assert.equal(result.ok, false);
    assert.match(result.error, /identity and lifecycle eligibility/);
    assert.equal(context.gridPlaceTrade(1, source, { symbol: 'R_10' }), false);
  }
  assert.equal(window.tsBotPlaceTrade({}, 'manual').ok, false);
  assert.deepEqual(sent, []);
});

test('ordinary Trading Grid path continues to send its proposal and buy to the mocked socket', () => {
  const { context, sent, pending } = harness();
  assert.equal(context.gridPlaceTrade(1, 'manual'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].proposal, 1);
  pending[sent[0].req_id]({ id: 'mock-proposal', ask_price: 1 }, null);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].buy, 'mock-proposal');
});
