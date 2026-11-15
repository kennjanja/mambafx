import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionOwnership } from "../../src/super-mathes/executionOwnership.js";

function fakeLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    },
  };
}

test("only one tab owns execution and the lock remains held until writes drain", async () => {
  const locks = fakeLocks(), a = createExecutionOwnership({ locks }), b = createExecutionOwnership({ locks });
  await a.acquire();
  await assert.rejects(b.acquire(), /Another tab/);
  let finish;
  const released = a.release(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(a.owns(), true);
  await assert.rejects(b.acquire(), /Another tab/);
  finish();
  await released;
  assert.equal(a.owns(), false);
  await b.acquire();
  await b.release(async () => {});
});

test("drain errors keep ownership rather than allowing a conflicting executor", async () => {
  const locks = fakeLocks(), a = createExecutionOwnership({ locks }), b = createExecutionOwnership({ locks });
  await a.acquire();
  await assert.rejects(a.release(async () => { throw new Error("write failed"); }), /write failed/);
  assert.equal(a.owns(), true);
  await assert.rejects(b.acquire(), /Another tab/);
  await a.release(async () => {});
  await b.acquire();
  await b.release(async () => {});
});

test("unsupported browsers and simultaneous acquire calls fail closed", async () => {
  await assert.rejects(createExecutionOwnership({ locks: null }).acquire(), /Web Locks/);
  const a = createExecutionOwnership({ locks: fakeLocks() });
  const first = a.acquire();
  await assert.rejects(a.acquire(), /already active/);
  await first;
  await a.release(async () => {});
});
