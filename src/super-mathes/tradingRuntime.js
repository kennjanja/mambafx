import { ResearchExecution } from "./execution.js?v=4";
import { openExecutionStore } from "./executionStorage.js?v=2";
import { createExecutionOwnership } from "./executionOwnership.js?v=1";
import { createDerivExecution, toMinor } from "./derivExecution.js?v=2";
import { createDerivRequest, readAccountBalance } from "./derivRequest.js?v=1";

export const ACCOUNTING_SCALE = 8;
const UNRESOLVED = new Set(["open"]);

export function createTradingRuntime({ connection, research, fetchSession, fetchAccounts, sessionKey,
  ownership = createExecutionOwnership(), openStore = openExecutionStore,
  monotonic = () => performance.now(), wallTime = Date.now }) {
  const request = createDerivRequest(connection);
  let database, controller, accountId, connectionGeneration, authorization;
  let serverTime, serverMeasuredAt, tail = Promise.resolve(), ticking = false;
  let lastError = null, disposed = false, controlVersion = 0;

  function enqueue(action) {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  function currentAccount() {
    const a = connection.account();
    const authorized = !!authorization && a?.connected === true && a.loggedIn === true &&
      a.accountId === authorization.accountId && a.connectionGeneration === authorization.generation &&
      sessionKey() === authorization.sessionKey && monotonic() - authorization.at < 10000 &&
      monotonic() >= authorization.at;
    return { ...a, tradeAuthorized: authorized };
  }
  const broker = createDerivExecution({ request, account: currentAccount, precision: ACCOUNTING_SCALE });
  function clock() {
    const elapsed = Math.floor(monotonic() - serverMeasuredAt);
    if (!Number.isSafeInteger(serverTime) || !Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 60000) {
      throw new Error("Deriv server time is unavailable or stale");
    }
    return serverTime + elapsed;
  }
  function account() {
    const a = currentAccount();
    return { id: a.accountId, connected: a.connected, authorized: a.tradeAuthorized,
      currency: a.currency, isVirtual: a.isVirtual,
      balance: a.balance == null ? null : toMinor(a.balance, ACCOUNTING_SCALE) };
  }
  function feed() {
    const s = research.status;
    const age = wallTime() - s.lastObservationAt;
    return { source: s.activeSource, segment: s.segment, continuous: s.role === "collector" && s.state === "ready" &&
      s.pendingUpdates === 0 && Number.isSafeInteger(s.segment) && s.segment > 0 &&
      Number.isFinite(age) && age >= 0 && age < 15000 && !!s.activeSource };
  }
  async function refreshAuthorization(force = false) {
    if (controller?.running && authorization && sessionKey() !== authorization.sessionKey) {
      throw new Error("Session changed; restart trading after verification");
    }
    if (!force && authorization && currentAccount().tradeAuthorized && monotonic() - authorization.at < 5000) return;
    authorization = null;
    const before = connection.account(), key = sessionKey();
    if (!before?.connected || !before.loggedIn || !before.accountId ||
        !Number.isSafeInteger(before.connectionGeneration)) throw new Error("Connect a Deriv account first");
    const response = await fetchSession();
    if (!response.ok) throw new Error("Could not verify trade authorization");
    const data = await response.json();
    if (data?.logged_in !== true || data.trade_authorized !== true) {
      throw new Error("Trade authorization is unavailable; sign in again");
    }
    const accountsResponse = await fetchAccounts();
    if (!accountsResponse.ok) throw new Error("Could not verify account type");
    const accounts = await accountsResponse.json();
    const selected = Array.isArray(accounts?.data) && accounts.data.find(row => row.account_id === before.accountId);
    const after = connection.account();
    if (sessionKey() !== key ||
        !after?.connected || !after.loggedIn || after.accountId !== before.accountId ||
        after.connectionGeneration !== before.connectionGeneration ||
        !selected || !["demo", "real"].includes(selected.account_type) ||
        (selected.account_type === "demo") !== before.isVirtual || after.isVirtual !== before.isVirtual) {
      throw new Error("Trade authorization is unavailable; sign in again");
    }
    authorization = { accountId: before.accountId, generation: before.connectionGeneration, sessionKey: key, at: monotonic() };
  }
  async function refreshClock() {
    serverTime = await broker.serverTime();
    serverMeasuredAt = monotonic();
  }
  function checkedStore(db) {
    return {
      async load(id) {
        const state = await db.load(id);
        if (state && state.accountingScale !== ACCOUNTING_SCALE) throw new Error("Execution history has an incompatible accounting scale");
        return state;
      },
      async save(state) { await db.save({ ...state, accountingScale: ACCOUNTING_SCALE }); },
    };
  }
  async function release() {
    if (!ownership.owns()) return;
    await ownership.release(async () => {
      if (database) database.close();
      database = null;
      controller = null;
      accountId = null;
      authorization = null;
    });
  }
  async function prepare() {
    if (disposed) throw new Error("Trading runtime is closed");
    if (research.status.role !== "collector") throw new Error("Use the active Super Mathes collector tab");
    const selected = connection.account();
    if (!selected?.connected || !selected.accountId || !selected.currency || selected.balance == null) {
      throw new Error("Connect an account and wait for its balance");
    }
    if (controller && accountId === selected.accountId) return;
    if (controller) {
      if (UNRESOLVED.has(controller.state?.order?.phase)) throw new Error("Reconnect the original account to reconcile its order");
      await controller.stop("Account changed");
      await release();
    }
    await ownership.acquire();
    try {
      database = await openStore();
      const entries = await database.list();
      if (entries.some(row => row.accountingScale !== ACCOUNTING_SCALE)) {
        throw new Error("Execution history has an incompatible accounting scale");
      }
      if (entries.some(row => row.accountId !== selected.accountId && UNRESOLVED.has(row.order?.phase))) {
        throw new Error("Reconnect the account with an unresolved order");
      }
      const current = connection.account();
      if (!current?.connected || current.accountId !== selected.accountId ||
          current.connectionGeneration !== selected.connectionGeneration) throw new Error("Account changed during recovery");
      accountId = selected.accountId;
      connectionGeneration = selected.connectionGeneration;
      controller = new ResearchExecution({ store: checkedStore(database), research, now: clock,
        host: { ...broker, ownsExecution: () => ownership.owns(), account, feed,
          stakeQuantum: 10 ** (ACCOUNTING_SCALE - 2),
          verifyAuthorization: () => refreshAuthorization(true) } });
      await controller.restore(accountId);
    } catch (error) {
      await release();
      throw error;
    }
  }
  async function checkConnection() {
    const current = connection.account();
    if (!current?.connected || current.accountId !== accountId ||
        current.connectionGeneration !== connectionGeneration) {
      authorization = null;
      if (controller?.running) await controller.stop("Account disconnected or changed; restart after recovery");
      if (!current?.connected || current.accountId !== accountId) return false;
      connectionGeneration = current.connectionGeneration;
    }
    return true;
  }
  async function pulseWork() {
    if (disposed) return;
    if (research.status.role !== "collector" && controller) {
      await controller.stop("Collector ownership changed");
      await release();
    }
    await prepare();
    if (!await checkConnection()) return;
    if (!controller.running && controller.state?.order?.phase !== "open") return;
    await refreshAuthorization();
    await refreshClock();
    if (controller.state?.order?.phase === "open") await controller.reconcile();
    if (controller.running) {
      await research.checkStale();
      await controller.onTick();
    }
  }
  function verifySelection(expected) {
    const current = connection.account();
    if (!expected?.connected || typeof expected.isVirtual !== "boolean" || !expected.accountId) {
      throw new Error("Connect and select a Demo or Real account first");
    }
    if (!current?.connected || current.accountId !== expected.accountId ||
        current.isVirtual !== expected.isVirtual || current.connectionGeneration !== expected.connectionGeneration) {
      throw new Error("Account selection changed; review the account and start again");
    }
  }
  return {
    start(config, expected = connection.account()) {
      const version = controlVersion;
      const selection = expected && { ...expected };
      return enqueue(async () => {
        verifySelection(selection);
        await prepare();
        if (!await checkConnection()) throw new Error("Reconnect the original account");
        await refreshAuthorization();
        await readAccountBalance(request, connection.account);
        await refreshClock();
        await research.checkStale();
        verifySelection(selection);
        if (version !== controlVersion || disposed) throw new Error("Start cancelled");
        await controller.start(config);
        if (version !== controlVersion || disposed) {
          await controller.stop("Start cancelled");
          throw new Error("Start cancelled");
        }
        lastError = null;
      });
    },
    stop() {
      controlVersion++;
      controller?.requestStop();
      return enqueue(async () => {
        if (!controller || !ownership.owns()) throw new Error("Use the active collector tab to stop trading");
        await controller.stop();
      });
    },
    closeCycle() {
      return enqueue(async () => {
        if (!controller || !ownership.owns()) throw new Error("Use the active collector tab");
        await controller.closeCycle();
      });
    },
    pulse() {
      if (ticking || disposed) return Promise.resolve();
      ticking = true;
      const version = controlVersion;
      return enqueue(async () => {
        try {
          if (version === controlVersion) await pulseWork();
          lastError = null;
        } catch (error) {
          lastError = error.message;
          if (controller?.running) await controller.stop(error.message);
          throw error;
        }
      }).finally(() => { ticking = false; });
    },
    snapshot() {
      return { owned: ownership.owns(), running: controller?.running === true,
        state: controller?.state ? { ...structuredClone(controller.state), accountingScale: ACCOUNTING_SCALE } : null,
        error: lastError };
    },
    async readHistory(id) {
      if (!id) return null;
      const db = await openStore();
      try { return await db.load(id); } finally { db.close(); }
    },
    dispose() {
      controlVersion++;
      controller?.requestStop();
      disposed = true;
      return enqueue(async () => {
        if (controller) await controller.stop(controller.state?.order?.phase === "open" ?
          "Page closed; reconcile the open contract before restarting" : "Page closed; trading stopped");
        await release();
      });
    },
  };
}
