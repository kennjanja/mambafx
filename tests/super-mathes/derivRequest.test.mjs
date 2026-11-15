import test from "node:test";
import assert from "node:assert/strict";
import { createDerivRequest, readAccountBalance } from "../../src/super-mathes/derivRequest.js";

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
function harness() {
  const ws = new Socket(), state = { connected: true, accountId: "VRTC1", currency: "USD", isVirtual: true };
  let id = 0;
  const request = createDerivRequest({ socket: () => ws, account: () => state, nextRequestId: () => ++id, timeoutMs: 20 });
  return { ws, state, request };
}

test("authenticated requests resolve only their matching response", async () => {
  const { ws, request } = harness();
  const pending = request({ proposal: 1 }, "proposal");
  ws.message({ req_id: 999, msg_type: "proposal", proposal: { id: "other" } });
  ws.message({ req_id: ws.sent[0].req_id, msg_type: "proposal", proposal: { id: "p" } });
  assert.deepEqual(await pending, { id: "p" });
});

test("disconnection, timeout and account changes reject without retrying a buy", async () => {
  for (const interruption of ["close", "timeout", "account"]) {
    const { ws, state, request } = harness();
    const pending = request({ buy: "proposal", price: 1 }, "buy");
    if (interruption === "close") ws.dispatchEvent(new Event("close"));
    if (interruption === "account") {
      state.accountId = "CR1";
      ws.message({ req_id: ws.sent[0].req_id, msg_type: "buy", buy: { contract_id: 1 } });
    }
    await assert.rejects(pending, /interrupted|timed out|account changed/);
    assert.equal(ws.sent.length, 1);
  }
});

test("broker errors and incomplete replies never resolve as successful purchases", async () => {
  const { ws, request } = harness();
  const rejected = request({ buy: "p", price: 1 }, "buy");
  ws.message({ req_id: 1, error: { code: "InvalidContractProposal", message: "private details" } });
  await assert.rejects(rejected, error => error.code === "InvalidContractProposal" && !error.message.includes("private"));
  const incomplete = request({ buy: "p", price: 1 }, "buy");
  ws.message({ req_id: 2, msg_type: "buy" });
  await assert.rejects(incomplete, /incomplete/);
});

test("balance is accepted only for the selected authenticated account and currency", async () => {
  const { ws, state, request } = harness();
  const first = readAccountBalance(request, () => state);
  ws.message({ req_id: 1, msg_type: "balance", balance: { loginid: "VRTC1", currency: "USD", balance: 100 } });
  assert.deepEqual(await first, { accountId: "VRTC1", currency: "USD", balance: 100 });
  const wrong = readAccountBalance(request, () => state);
  ws.message({ req_id: 2, msg_type: "balance", balance: { loginid: "CR2", currency: "USD", balance: 100 } });
  await assert.rejects(wrong, /could not be verified/);
});

test("balance response establishes the currency when account metadata is not yet available", async () => {
  const { ws, state, request } = harness();
  state.currency = null;
  const pending = readAccountBalance(request, () => state);
  state.currency = "USD";
  ws.message({ req_id: 1, msg_type: "balance", balance: { loginid: "VRTC1", currency: "USD", balance: 10 } });
  assert.deepEqual(await pending, { accountId: "VRTC1", currency: "USD", balance: 10 });
});
