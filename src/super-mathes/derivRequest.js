// Requests use the existing authenticated socket and never reconnect or retry a buy.
export function createDerivRequest({ socket, nextRequestId, account, timeoutMs = 10000 }) {
  if (typeof socket !== "function" || typeof nextRequestId !== "function" || typeof account !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid Deriv request transport");
  return function request(payload, expectedType) {
    const ws = socket(), current = account();
    const original = current && { connected: current.connected, accountId: current.accountId,
      isVirtual: current.isVirtual, currency: current.currency };
    const readingBalance = expectedType === "balance" && payload?.balance === 1 && Object.keys(payload).length === 1;
    if (!ws || ws.readyState !== 1 || !original?.connected || !original.accountId ||
        typeof original.isVirtual !== "boolean" || (!readingBalance && !original.currency)) {
      return Promise.reject(new Error("Authenticated Deriv account is unavailable"));
    }

    if (!payload || typeof payload !== "object" || "req_id" in payload || typeof expectedType !== "string") {
      return Promise.reject(new Error("Invalid Deriv request"));
    }
    const id = nextRequestId();
    if (!Number.isSafeInteger(id) || id < 1) return Promise.reject(new Error("Invalid request identifier"));
    return new Promise((resolve, reject) => {
      let timer;
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onClose);
      }
      function fail(error) { cleanup(); reject(error); }
      function onClose() { fail(new Error("Deriv connection interrupted")); }
      function onMessage(event) {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.req_id !== id) return;
        const current = account();
        if (socket() !== ws || !current?.connected || current.accountId !== original.accountId ||
            current.isVirtual !== original.isVirtual || (!readingBalance && current.currency !== original.currency)) {
          fail(new Error("Deriv account changed during request"));
          return;
        }
        if (message.error) {
          const error = new Error("Deriv rejected the request");
          error.code = typeof message.error.code === "string" ? message.error.code : "DerivError";
          fail(error);
          return;
        }
        if (message.msg_type !== expectedType || message[expectedType] == null) {
          fail(new Error("Deriv response is incomplete"));
          return;
        }
        cleanup();
        resolve(message[expectedType]);
      }
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onClose);
      timer = setTimeout(() => fail(new Error("Deriv request timed out")), timeoutMs);
      try { ws.send(JSON.stringify({ ...payload, req_id: id })); }
      catch { fail(new Error("Deriv request could not be sent")); }
    });
  };
}

export async function readAccountBalance(request, account) {
  const original = account();
  if (!original?.connected || !original.accountId || typeof original.isVirtual !== "boolean") throw new Error("Connect an account first");
  const accountId = original.accountId, isVirtual = original.isVirtual;
  const result = await request({ balance: 1 }, "balance");
  const current = account();
  if (!current?.connected || current.accountId !== accountId || current.isVirtual !== isVirtual ||
      result.loginid !== accountId || typeof result.currency !== "string" ||
      !/^[a-zA-Z0-9]{2,20}$/.test(result.currency) ||
      (current.currency != null && current.currency !== result.currency) ||
      typeof result.balance !== "number" || !Number.isFinite(result.balance) || result.balance < 0) {
    throw new Error("Account balance could not be verified");
  }
  return { accountId, currency: result.currency, balance: result.balance };
}
