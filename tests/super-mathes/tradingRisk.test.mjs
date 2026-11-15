import test from "node:test";
import assert from "node:assert/strict";
import { accountDay, assessTradeRisk } from "../../src/super-mathes/tradingRisk.js";

function fixture() {
  return {
    config: { baseStake: 100, maximumStake: 1000, maximumExposure: 3000, cycleLoss: 2000, sessionLoss: 5000,
      cycleTarget: 1000, sessionTarget: 2000, dailyTarget: 3000, maxAttempts: 0,
      martingale: false, multiplierNumerator: 2, multiplierDenominator: 1 },
    account: { id: "VRTC1", isVirtual: true, connected: true, authorized: true, balance: 10000, currency: "USD" },
    session: { accountId: "VRTC1", isVirtual: true, currency: "USD", pnl: 0, dailyPnl: 0 },
    cycle: { source: "feed", pnl: 0, staked: 0, attempts: 0, losses: 0, unresolved: false },
    feed: { source: "feed", continuous: true },
  };
}

test("requires the selected authenticated account and continuous source", () => {
  const f = fixture();
  assert.deepEqual(assessTradeRisk(f), { allowed: true, stake: 100 });
  f.account.isVirtual = false;
  assert.match(assessTradeRisk(f).reason, /Account/);
  f.account.isVirtual = true; f.account.id = "CR1";
  assert.match(assessTradeRisk(f).reason, /Account/);
  f.account.id = "VRTC1"; f.feed.continuous = false;
  assert.match(assessTradeRisk(f).reason, /continuity/);
  f.feed.continuous = true; f.cycle.unresolved = true;
  assert.match(assessTradeRisk(f).reason, /unresolved/);
  f.cycle.unresolved = undefined;
  assert.match(assessTradeRisk(f).reason, /unresolved/);
  f.cycle.unresolved = false;
  f.account = { ...f.account, id: "CR1", isVirtual: false };
  f.session = { ...f.session, accountId: "CR1", isVirtual: false };
  assert.equal(assessTradeRisk(f).allowed, true);
});

test("martingale advances only with confirmed losses and stops at stake or exposure limits", () => {
  const f = fixture();
  f.config.martingale = true; f.cycle.losses = 2; f.cycle.attempts = 2; f.cycle.staked = 300;
  assert.equal(assessTradeRisk(f).stake, 400);
  f.config.maximumStake = 399;
  assert.match(assessTradeRisk(f).reason, /Maximum stake/);
  f.config.maximumStake = 1000; f.config.maximumExposure = 699;
  assert.match(assessTradeRisk(f).reason, /exposure/);
  f.config.maximumExposure = 3000; f.cycle.unresolved = true;
  assert.equal(assessTradeRisk(f).allowed, false);
});

test("limits include worst-case loss on the next contract", () => {
  const f = fixture();
  f.session.pnl = -4950;
  assert.match(assessTradeRisk(f).reason, /session stop loss/);
  f.session.pnl = 0; f.cycle.pnl = -1950;
  assert.match(assessTradeRisk(f).reason, /cycle stop loss/);
  f.cycle.pnl = 0; f.session.dailyPnl = 3000;
  assert.match(assessTradeRisk(f).reason, /Profit target/);
  f.session.dailyPnl = 0; f.account.balance = 99;
  assert.match(assessTradeRisk(f).reason, /balance/);
  f.account.balance = 10000; f.config.maxAttempts = 2; f.cycle.attempts = 2;
  assert.match(assessTradeRisk(f).reason, /attempts/);
});

test("account-local day follows time zone and daylight-saving transitions", () => {
  assert.equal(accountDay(Date.parse("2026-03-08T04:30:00Z"), "America/New_York"), "2026-03-07");
  assert.equal(accountDay(Date.parse("2026-03-08T05:30:00Z"), "America/New_York"), "2026-03-08");
  assert.throws(() => accountDay(Date.now(), "not-a-zone"), RangeError);
});
