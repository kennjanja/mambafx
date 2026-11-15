import { createLiveResearch } from "./live.js?v=3";
import { attachDashboard } from "./dashboard.js?v=3";
import { coordinateResearch } from "./coordination.js?v=2";

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
window.addEventListener("pagehide", () => { coordinator.stop().catch(error => console.error("[super-mathes]", error)); });
window.addEventListener("pageshow", event => { if (event.persisted) coordinator = coordinateResearch(service); });
