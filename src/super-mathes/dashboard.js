import { rankDistribution } from "./models.js";

export function attachDashboard(service) {
  const el = id => document.getElementById(`sm-${id}`);
  const percent = p => `${(p * 100).toFixed(2)}%`;
  let busy = false;
  const message = text => { el("message").textContent = text; };
  const windowSize = () => Number(el("window").value);
  const warmup = () => Number(el("warmup").value);

  async function render() {
    if (busy || !document.getElementById("page-supermathes").classList.contains("active")) return;
    busy = true;
    try {
      const { state, lastError, activeSource } = service.status;
      el("status").textContent = `Storage: ${state}; source: ${activeSource || "waiting"}${lastError ? `; last warning: ${lastError}` : ""}`;
      const sources = await service.listSources();
      const select = el("source"), selected = select.value;
      const keys = sources.map(s => s.source).sort();
      if (keys.join("\n") !== [...select.options].slice(1).map(o => o.value).join("\n")) {
        select.replaceChildren(new Option("Current live source", ""), ...keys.map(key => new Option(key, key)));
        select.value = keys.includes(selected) ? selected : "";
      }
      const historySource = select.value || activeSource;
      if (!historySource) {
        el("feed").textContent = "Waiting for a live source; choose a saved source to inspect its history.";
        el("prediction").textContent = "No source selected.";
        el("recurrence").textContent = "No source selected.";
        el("history").textContent = "No source selected.";
        el("reports").textContent = "No source selected.";
        return;
      }
      const [source, ticks, records, reports] = await Promise.all([
        service.getSource(historySource), service.listObservations(historySource, 12),
        service.listPredictions(historySource, 10), service.listReports(historySource, 1),
      ]);
      el("feed").textContent = `Source: ${historySource}; ${source.connected && historySource === activeSource ? "receiving" : "not active"}; sequence ${source.lastSeq}; segment ${source.segment}\n` +
        ticks.map(t => `#${t.sequence}  ${new Date(t.epoch * 1000).toISOString()}  ${t.rawQuote}  digit ${t.digit}`).join("\n");
      const latest = records[0];
      if (latest) {
        const p = latest.prediction, r = p.recurrence;
        el("prediction").textContent = `${p.model} | selected ${p.selectedDigit} | ${latest.status}\n` +
          rankDistribution(p.probabilities).map(x => `${x.digit}: ${percent(x.probability)}`).join("   ") +
          `\nOrigin sequence ${latest.originSequence}; ${p.assumptions}`;
        const immediate = latest.observations.length ? (latest.observations[0].digit === p.selectedDigit ? "hit" : "miss") : "pending";
        el("recurrence").textContent = `Original digit: ${p.selectedDigit}; immediate: ${immediate}; first appearance: ${latest.appearancePosition ?? "none yet"}\n` +
          `Outcomes: ${latest.observations.map((o, i) => `${i + 1}:${o.digit}`).join("  ") || "pending"}\n` +
          r.hazards.map((p, i) => `${i + 1}: conditional ${percent(p)} | within ${percent(r.within[i])}`).join("\n") +
          `\nNo appearance within five: ${percent(r.notWithinFive)}` +
          (latest.interruptionReason ? `\nUnscorable: ${latest.interruptionReason}` : "");
      } else {
        el("prediction").textContent = "No recorded prediction.";
        el("recurrence").textContent = "No recorded prediction.";
      }
      el("history").textContent = records.length ? records.map(r =>
        `${new Date(r.createdAt).toISOString()}  digit ${r.prediction.selectedDigit}  ${r.status}  ${r.observations.length}/5`).join("\n") : "No prediction history.";
      const report = reports[0];
      el("reports").textContent = report ? `${new Date(report.createdAt).toISOString()} | ${report.model} | ${report.result.status}\n` +
        `Training warmup ${report.warmup}; evaluated ${report.result.n} outcomes; through sequence ${report.throughSequence}\n` +
        (report.result.n ? `Top-1 ${percent(report.result.top1)}; log loss ${report.result.logLoss.toFixed(4)} (uniform ${report.result.uniformLogLoss.toFixed(4)}); Brier ${report.result.brier.toFixed(4)} (uniform ${report.result.uniformBrier.toFixed(4)})` : "Insufficient observations for a benchmark.") +
        "\nExploratory chronological evaluation, not independent validation or model promotion." : "No benchmark has been run.";
    } catch (error) {
      message(`Research error: ${error.message}`);
    } finally { busy = false; }
  }
  async function run(action, success) {
    try { await action(); message(success); await render(); }
    catch (error) { message(`Research error: ${error.message}`); }
  }
  el("save").addEventListener("click", () => run(async () => {
    const w = windowSize(), n = warmup();
    if (!Number.isInteger(w) || w < 20 || w > 10000 || !Number.isInteger(n) || n < 1 || n >= w) throw new Error("Require 20–10000 observations and a warmup smaller than the window");
    await service.setSetting("windowSize", w);
    await service.setSetting("warmup", n);
    await service.setSetting("model", el("model").value);
  }, "Research settings saved."));
  el("predict").addEventListener("click", () => run(() => service.createModelPrediction(windowSize(), el("model").value), "Research prediction recorded."));
  el("benchmark").addEventListener("click", () => run(() => service.benchmark(windowSize(), warmup(), el("model").value), "Benchmark saved."));
  Promise.all([service.getSetting("windowSize"), service.getSetting("warmup"), service.getSetting("model")]).then(([w, n, model]) => {
    if (w) el("window").value = w.value;
    if (n) el("warmup").value = n.value;
    if (model) el("model").value = model.value;
  }).catch(error => message(`Research error: ${error.message}`));
  setInterval(render, 1500);
}
