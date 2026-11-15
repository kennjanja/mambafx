import test from "node:test";
import assert from "node:assert/strict";
import { createDerivExecution, toMajor, toMinor } from "../../src/super-mathes/derivExecution.js";

test("amounts are converted exactly and unsupported precision is rejected", () => {
  assert.equal(toMinor("10.50", 2), 1050);
  assert.equal(toMinor("-0.01", 2), -1);
  assert.equal(toMajor(1050, 2), 10.5);
  assert.throws(() => toMinor("0.001", 2), /scale/);
  assert.equal(toMinor(1e-8, 8), 1);
  assert.equal(toMajor(1, 8), 1e-8);
  assert.throws(() => toMajor(100, null), /scale/);
});

test("the Deriv adapter rejects sub-cent stakes before making a request", async () => {
  let requests = 0;
  const adapter = createDerivExecution({ request: async () => { requests++; }, account: () => ({}), precision: 8 });
  await assert.rejects(adapter.proposal({ source: "unused", digit: 3, stake: 100100000, durationTicks: 1 }), /Invalid contract parameters/);
  assert.equal(requests, 0);
});

test("Deriv Digit Matches proposal, purchase and confirmed settlement use the original order", async () => {
  const sent = [], source = JSON.stringify(["deriv-public", "public", "R_100", 2]);
  const state = { connected: true, accountId: "VRTC1", currency: "USD", isVirtual: true, connectionGeneration: 1, tradeAuthorized: true };
  const request = async (payload, type) => {
    sent.push(payload);
    if (type === "balance") return { loginid: "VRTC1", currency: "USD", balance: 100 };
    if (type === "active_symbols") return [{ underlying_symbol: "R_100", exchange_is_open: 1, is_trading_suspended: 0 }];
    if (type === "proposal") return { id: "proposal", ask_price: 1 };
    if (type === "buy") return { contract_id: 123, transaction_id: 456, buy_price: 1 };
    return { contract_id: 123, contract_type: "DIGITMATCH", currency: "USD", underlying_symbol: "R_100",
      barrier: "3", buy_price: "1.00", transaction_ids: { buy: 456 }, is_sold: 1, status: "won",
      profit: "8.00", sell_price: "9.00", date_settlement: 1700000000 };
  };
  const adapter = createDerivExecution({ request, account: () => state, precision: 2 });
  assert.deepEqual(await adapter.proposal({ source, digit: 3, stake: 100, durationTicks: 1 }), { id: "proposal", askPrice: 100 });
  assert.deepEqual(sent[0], { balance: 1 });
  assert.deepEqual(sent[1], { active_symbols: "brief", contract_type: ["DIGITMATCH"] });
  assert.deepEqual(sent[2], { proposal: 1, amount: 1, basis: "stake", contract_type: "DIGITMATCH",
    currency: "USD", duration: 1, duration_unit: "t", underlying_symbol: "R_100", barrier: "3" });
  assert.deepEqual(await adapter.buy("proposal", 100), { contractId: "123", transactionId: "456", buyPrice: 100 });
  assert.deepEqual(sent[3], { buy: "proposal", price: 1 });
  await assert.rejects(adapter.buy("proposal", 100), /authorization or original proposal/);
  const order = { source, digit: 3, stake: 100, currency: "USD", transactionId: "456" };
  assert.deepEqual(await adapter.contract("123", order), { contractId: "123", status: "won", profit: 800, payout: 900, settledAt: 1700000000000 });
  await assert.rejects(adapter.contract("123", { ...order, digit: 4 }), /do not match/);
  await assert.rejects(adapter.contract("123", { ...order, transactionId: "999" }), /do not match/);
});

test("a purchase requires trade authorization, the original connection and exact quoted price", async () => {
  const state = { connected: true, accountId: "VRTC1", currency: "USD", isVirtual: true, connectionGeneration: 1, tradeAuthorized: false };
  const source = JSON.stringify(["deriv-public", "public", "R_100", 2]);
  const sent = [];
  const request = async (payload, type) => {
    sent.push(payload);
    if (type === "balance") return { loginid: "VRTC1", currency: "USD", balance: 100 };
    if (type === "active_symbols") return [{ underlying_symbol: "R_100", exchange_is_open: 1, is_trading_suspended: 0 }];
    if (type === "proposal") return { id: "proposal", ask_price: 1 };
    throw new Error("Buy must not be sent");
  };
  const adapter = createDerivExecution({ request, account: () => state, precision: 2 });
  await adapter.proposal({ source, digit: 3, stake: 100, durationTicks: 1 });
  await assert.rejects(adapter.buy("proposal", 100), /authorization/);
  state.tradeAuthorized = true;
  await assert.rejects(adapter.buy("proposal", 101), /authorization or original proposal/);
  state.connectionGeneration++;
  await assert.rejects(adapter.buy("proposal", 100), /authorization or original proposal/);
  assert.equal(sent.filter(row => row.buy).length, 0);
});

test("closed or suspended markets and account changes prevent a proposal", async () => {
  for (const reason of ["closed", "suspended", "account"]) {
    const state = { connected: true, accountId: "VRTC1", currency: "USD", isVirtual: true, connectionGeneration: 1 };
    const sent = [];
    const request = async (payload, type) => {
      sent.push(payload);
      if (type === "balance") return { loginid: "VRTC1", currency: "USD", balance: 100 };
      if (type === "active_symbols") {
        if (reason === "account") state.accountId = "CR1";
        return [{ underlying_symbol: "R_100", exchange_is_open: reason === "closed" ? 0 : 1,
          is_trading_suspended: reason === "suspended" ? 1 : 0 }];
      }
      throw new Error("Proposal must not be sent");
    };
    const adapter = createDerivExecution({ request, account: () => state, precision: 2 });
    await assert.rejects(adapter.proposal({ source: JSON.stringify(["deriv-public", "public", "R_100", 2]),
      digit: 3, stake: 100, durationTicks: 1 }), /available trading symbol|Account changed/);
    assert.equal(sent.filter(row => row.proposal).length, 0);
  }
});

test("server time is requested only when explicitly needed", async () => {
  const sent = [];
  const adapter = createDerivExecution({
    request: async (payload, type) => { sent.push({ payload, type }); return 1700000000; },
    account: () => null, precision: 2,
  });
  assert.equal(sent.length, 0);
  assert.equal(await adapter.serverTime(), 1700000000000);
  assert.deepEqual(sent, [{ payload: { time: 1 }, type: "time" }]);
});
