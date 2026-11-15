import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('index.html', 'utf8');
const start = html.indexOf('let gridWs = null, gridAuthed = false, gridPing = null;');
const end = html.indexOf('function tradeSignalExecutionBlockReason()', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

function harness(){
  let now = 0;
  const updates = [], diagnostics = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(){ this.readyState = 0; this.messages = []; this.closed = false; }
    send(value){ this.messages.push(JSON.parse(value)); }
    close(){ this.closed = true; this.readyState = 3; }
  }
  const ctx = vm.createContext({
    WebSocket: Socket, Date: { now: () => now },
    document: { hidden: false, addEventListener(){} },
    window: { addEventListener(){}, mfxAuthFetch: async () => ({ ok: true, json: async () => ({url:'wss://example.test'}) }) },
    console, localStorage: { setItem(){} },
    setInterval: () => 1, clearInterval(){}, setTimeout: () => 1, clearTimeout(){},
    $: id => id === 'gridAcctPick' ? {value:'account'} : null,
    gridDiag: text => diagnostics.push(text), gridConnState(){}, gridSet(){}, alert(){},
    BACKEND_URL: 'https://example.test', ACCTID_KEY: 'test',
    rfaTrades: [], rfaReversal: {running:false, accountId:'account', markets:{}},
    rfaOpenContracts: {}, rfaReversalAnyInFlight: () => false,
    rfaReversalSyncStatus(){}, rfaRenderAll(){},
    gridUpdateContract: c => updates.push(c),
  });
  vm.runInContext(source, ctx);
  const run = text => vm.runInContext(text, ctx);
  return { ctx, run, updates, diagnostics, time(value){now=value;} };
}

test('heartbeat waits for an actual unanswered probe rather than an old message timestamp', () => {
  const h = harness();
  h.run('gridWs = new WebSocket(); gridWs.readyState=1; gridAuthed=true');
  h.time(1000); h.run('gridHeartbeatTick()');
  h.time(6000); h.run('gridHeartbeatTick()');
  h.time(11000); h.run('gridHeartbeatTick()');
  h.time(16000); h.run('gridHeartbeatTick()');
  assert.equal(h.run('gridWs.closed'), false);
  h.time(21000); h.run('gridHeartbeatTick()');
  assert.equal(h.run('gridWs.closed'), true);
});

test('background and throttled timers start a fresh probe instead of disconnecting', () => {
  const h = harness();
  h.run('gridWs = new WebSocket(); gridWs.readyState=1; gridAuthed=true');
  h.time(1000); h.run('gridHeartbeatTick()');
  h.time(90000); h.run('gridHeartbeatTick()');
  assert.equal(h.run('gridWs.closed'), false);
  h.run('document.hidden = true');
  h.time(120000); h.run('gridHeartbeatTick()');
  assert.equal(h.run('gridWs.messages.length'), 3);
  h.run('document.hidden = false');
  h.time(150000); h.run('gridHeartbeatTick()');
  assert.equal(h.run('gridWs.closed'), false);
});

test('disconnect cancels an outstanding credential request without opening a socket', async () => {
  const h = harness();
  let resolve;
  h.ctx.window.mfxAuthFetch = () => new Promise(r => { resolve = r; });
  h.run('gridLoggedIn = true');
  const pending = h.run('gridConnect()');
  h.run('gridDisconnect()');
  resolve({ok:true, json:async () => ({url:'wss://example.test'})});
  await pending;
  assert.equal(h.run('gridWs'), null);
  assert.equal(h.run('gridWantConn'), false);
});

test('late callbacks from an old socket cannot tear down its replacement', async () => {
  const h = harness();
  h.run('gridLoggedIn = true');
  await h.run('gridConnect()');
  const old = h.run('gridWs');
  const oldClose = old.onclose;
  h.run('gridDisconnect()');
  await h.run('gridConnect()');
  const current = h.run('gridWs');
  oldClose({code:1006});
  assert.equal(h.run('gridWs'), current);
  assert.equal(h.run('gridConnecting'), true);
});

test('reconnect queries unresolved Rise/Fall contracts once and routes the response', () => {
  const h = harness();
  h.run("gridWs = new WebSocket(); gridWs.readyState=1; rfaOpenContracts['123']={status:'open'}; gridRecoverRfaContracts('account')");
  const request = h.run('gridWs.messages[0]');
  assert.equal(request.contract_id, 123);
  h.ctx.request = request;
  h.run("gridHandleMsg({msg_type:'proposal_open_contract',req_id:request.req_id,proposal_open_contract:{contract_id:123,is_sold:1}})");
  assert.equal(h.updates.length, 1);
  assert.equal(h.run('gridRecoveryRequests.size'), 0);
});

test('a late recovery response cannot settle a contract twice', () => {
  const h = harness();
  h.run("gridWs = new WebSocket(); gridWs.readyState=1; rfaOpenContracts['123']={status:'open'}; gridRecoverRfaContracts('account')");
  h.ctx.request = h.run('gridWs.messages[0]');
  h.run("delete rfaOpenContracts['123']; gridHandleMsg({msg_type:'proposal_open_contract',req_id:request.req_id,proposal_open_contract:{contract_id:123,is_sold:1}})");
  assert.equal(h.updates.length, 0);
});

test('reconciliation errors remain visible and do not clear open contracts', () => {
  const h = harness();
  h.run("gridWs = new WebSocket(); gridWs.readyState=1; rfaOpenContracts['123']={status:'open'}; gridRecoverRfaContracts('account')");
  h.ctx.request = h.run('gridWs.messages[0]');
  h.run("gridHandleMsg({req_id:request.req_id,error:{message:'unavailable'}})");
  assert.equal(h.run("rfaOpenContracts['123'].status"), 'open');
  assert.ok(h.diagnostics.some(x => x && x.includes('unavailable')));
});

test('dashboard contracts route to their independent handler before generic settlement', () => {
  const h = harness();
  const handled = [];
  h.ctx.window.MFXDashboardAuto = {handleContract: c => { handled.push(c.contract_id); return true; }};
  h.run("gridHandleMsg({msg_type:'proposal_open_contract',proposal_open_contract:{contract_id:456,is_sold:1}})");
  assert.deepEqual(handled, [456]);
  assert.equal(h.updates.length, 0);
});
