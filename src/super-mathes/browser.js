import { createLiveResearch } from "./live.js?v=3";
import { attachDashboard } from "./dashboard.js?v=3";
import { coordinateResearch } from "./coordination.js?v=3";
import { attachTradingDashboard } from "./tradingDashboard.js?v=3";
import { createDerivRequest, readAccountBalance } from "./derivRequest.js?v=1";
import { createTradingRuntime } from "./tradingRuntime.js?v=2";

function runValidation(observations, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./validationWorker.js?v=3", import.meta.url), { type: "module" });
    worker.onmessage = event => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || "Validation worker failed")); };
    worker.postMessage({ observations, options });
  });
}

const service = createLiveResearch({ autoRecover: false, runValidation });
let coordinator = coordinateResearch(service);
window.SuperMathes = new Proxy({}, {
  get(_target, key) {
    const value = coordinator[key];
    return typeof value === "function" ? (...args) => coordinator[key](...args) : value;
  },
});
attachDashboard(window.SuperMathes);
const connection = window.MFXDerivConnection;
const request = createDerivRequest(connection);
function newRuntime() {
  return createTradingRuntime({ connection, research: window.SuperMathes,
    fetchSession: () => window.mfxAuthFetch("/me/session"),
    fetchAccounts: () => window.mfxAuthFetch("/me/accounts"),
    sessionKey: () => localStorage.getItem("mfx_session_token") });
}
let runtime = newRuntime(), closing = Promise.resolve();
const runtimeProxy = new Proxy({}, {
  get(_target, key) {
    const value = runtime[key];
    return typeof value === "function" ? (...args) => runtime[key](...args) : value;
  },
});
attachTradingDashboard(window.SuperMathes, connection.account, () => readAccountBalance(request, connection.account), runtimeProxy);
setInterval(() => { runtime.pulse().catch(() => {}); }, 1500);
window.addEventListener("pagehide", () => {
  closing = runtime.dispose();
  closing.catch(error => console.error("[super-mathes trading]", error));
  coordinator.stop().catch(error => console.error("[super-mathes]", error));
});
window.addEventListener("pageshow", event => {
  if (event.persisted) {
    coordinator = coordinateResearch(service);
    closing.then(() => { runtime = newRuntime(); }).catch(error => console.error("[super-mathes trading]", error));
  }
});
