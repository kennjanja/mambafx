// The lock is held for the complete execution and durable-write lifetime.
export function createExecutionOwnership({ locks = globalThis.navigator?.locks,
  name = "super-mathes-execution-v1" } = {}) {
  let owned = false, acquiring = false, releasing = false, releaseLock, request;
  return {
    owns() { return owned; },
    async acquire() {
      if (!locks) throw new Error("Web Locks are required for trading");
      if (owned || acquiring || releasing) throw new Error("Execution ownership is already active");
      acquiring = true;
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      try {
        request = locks.request(name, { mode: "exclusive", ifAvailable: true }, async lock => {
          if (!lock) { resolveReady(false); return; }
          owned = true;
          const held = new Promise(resolve => { releaseLock = resolve; });
          resolveReady(true);
          try { await held; }
          finally { owned = false; releaseLock = null; }
        });
        request.catch(rejectReady);
        const acquired = await ready;
        if (!acquired) {
          await request;
          throw new Error("Another tab owns Super Mathes execution");
        }
      } finally { acquiring = false; }
    },
    async release(drain) {
      if (!owned || releasing || typeof drain !== "function") throw new Error("Execution ownership cannot be released");
      releasing = true;
      try {
        await drain();
        releaseLock();
        await request;
      } finally { releasing = false; }
    },
  };
}
