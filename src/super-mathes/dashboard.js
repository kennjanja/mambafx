import { rankDistribution } from "./models.js";

function independentReport(report) {
  const result = report.result, p = result.protocol;
  const lines = [
    `${new Date(report.createdAt).toISOString()} | independent validation | ${result.status}`,
    `Source sample ${report.sampleSize}; training ${p.warmup}; model window ${p.windowSize}; test ${p.evaluatedObservations}; periods ${p.periods} × ${p.periodLength}; blocks ${p.blocks} × ${p.blockSize}; unused tail ${p.discardedTail}.`,
    p.confidenceMethod, p.note,
  ];
  if (!result.models) return lines.join("\n");
  const fmt = metric => {
    if (!metric || !metric.n) return "n=0";
    const ci = metric.confidence95 ? ` [${metric.confidence95.map(x => x.toFixed(4)).join(", ")}]` : " [CI unavailable]";
    return `${metric.observed.toFixed(4)}${ci} (n=${metric.n})`;
  };
  for (const [name, model] of Object.entries(result.models)) {
    lines.push(`\n${name}: ${["top1", "top2", "top3", "logLoss", "brier"].map(k => `${k} ${fmt(model.immediate[k])}`).join("; ")}`);
    lines.push(`Paired gain vs uniform (positive is lower loss): log ${fmt(model.immediate.uniformLogLossGain)}; Brier ${fmt(model.immediate.uniformBrierGain)}`);
    lines.push(`Paired gain vs frequency: log ${fmt(model.immediate.frequencyLogLossGain)}; Brier ${fmt(model.immediate.frequencyBrierGain)}`);
    lines.push(`Periods (top-1 / log loss / Brier): ${model.periods.map(x => `${x.top1 === null ? "n/a" : x.top1.toFixed(4)} / ${x.logLoss.toFixed(4)} / ${x.brier.toFixed(4)}`).join("; ")}`);
    lines.push("Recurrence (non-overlapping windows; observed [CI], model / uniform / frequency expected):");
    for (const [key, m] of Object.entries(model.recurrence.model)) {
      const uniform = model.recurrence.uniform[key], frequency = model.recurrence.frequency[key];
      lines.push(`${key}: ${fmt(m)}; expected ${m.predicted?.toFixed(4) ?? "—"} / ${uniform.predicted?.toFixed(4) ?? "—"} / ${frequency.predicted?.toFixed(4) ?? "—"}`);
    }
    lines.push(`Calibration bins (dependent digit-probability pairs, mean probability, observed rate): ${result.calibration[name].filter(b => b.n).map(b => `${b.n},${b.meanProbability.toFixed(3)},${b.observedRate.toFixed(3)}`).join(" | ")}`);
    lines.push(`Calibration by period: ${result.periodCalibration[name].map(bins => bins.filter(b => b.n).map(b => `${b.n},${b.meanProbability.toFixed(3)},${b.observedRate.toFixed(3)}`).join(" | ")).join(" ; ")}`);
  }
  for (const [name, metrics] of Object.entries(result.baselines)) {
    lines.push(`\n${name} baseline: ${["top1", "top2", "top3", "logLoss", "brier"].map(k => `${k} ${fmt(metrics[k])}`).join("; ")}`);
  }
  lines.push(`Mean total variation between models: ${result.meanTotalVariationBetweenModels.toFixed(4)} (descriptive, not evidence of independence).`, result.rankTiePolicy);
  return lines.join("\n");
}

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
      const { state, role, lastError, activeSource } = service.status;
      el("status").textContent = `Storage: ${state}; tab: ${role}; source: ${activeSource || "waiting"}${lastError ? `; last warning: ${lastError}` : ""}`;
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
      const [source, ticks, records, reports, intervals] = await Promise.all([
        service.getSource(historySource), service.listObservations(historySource, 12),
        service.listPredictions(historySource, 10), service.listReports(historySource, 1), service.listIntervals(historySource, 3),
      ]);
      el("feed").textContent = `Source: ${historySource}; ${source.connected && historySource === activeSource ? "receiving" : "not active"}; sequence ${source.lastSeq}; segment ${source.segment}\n` +
        ticks.map(t => `#${t.sequence}  ${new Date(t.epoch * 1000).toISOString()}  ${t.rawQuote}  digit ${t.digit}`).join("\n") +
        (intervals.length ? "\nUncertain intervals:\n" + intervals.map(i => `${i.reason}; after #${i.afterSequence}; ${i.endedAt === null ? "open" : `resumed #${i.resumedSequence}`}`).join("\n") : "");
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
      el("reports").textContent = report?.kind === "independent-validation" ? independentReport(report) : report ? `${new Date(report.createdAt).toISOString()} | ${report.model} | ${report.result.status}\n` +
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
  el("independent").addEventListener("click", () => run(
    () => service.validateIndependent(el("source").value || service.status.activeSource, Number(el("validation-warmup").value), windowSize()),
    "Independent validation report saved."));
  Promise.all([service.getSetting("windowSize"), service.getSetting("warmup"), service.getSetting("model")]).then(([w, n, model]) => {
    if (w) el("window").value = w.value;
    if (n) el("warmup").value = n.value;
    if (model) el("model").value = model.value;
  }).catch(error => message(`Research error: ${error.message}`));
  setInterval(render, 1500);
}
