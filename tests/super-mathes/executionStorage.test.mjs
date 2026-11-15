import test from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDB } from "../support/fakeIndexedDB.js";
import { openExecutionStore } from "../../src/super-mathes/executionStorage.js";

test("execution records survive reopening and remain separated by account", async () => {
  const fake = installFakeIndexedDB();
  try {
    const store = await openExecutionStore();
    await store.save({ accountId: "VRTC1", order: { phase: "unknown" }, session: { pnl: -10 } });
    await store.save({ accountId: "CR1", order: null, session: { pnl: 20 } });
    store.close();
    const reopened = await openExecutionStore();
    assert.equal((await reopened.load("VRTC1")).order.phase, "unknown");
    assert.equal((await reopened.load("CR1")).session.pnl, 20);
    assert.equal(await reopened.load("missing"), undefined);
    reopened.close();
  } finally { fake.teardown(); }
});
