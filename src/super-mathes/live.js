import { createResearchPrediction } from "./recurrence.js";
import { openResearchStore } from "./storage.js?v=2";
import { frequencyDistribution, rankDistribution, transitionDistribution } from "./models.js";
import { walkForward } from "./validation.js";
import { independentValidation } from "./independentValidation.js?v=2";

export function sourceId(endpoint, symbol, decimals) {
  if (typeof endpoint !== "string" || !endpoint || typeof symbol !== "string" || !symbol ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 20) throw new Error("Invalid feed source");
  return JSON.stringify(["deriv-public", endpoint, symbol, decimals]);
}

export function normalizeLiveTick({ endpoint, symbol, epoch, rawQuote, decimals, providerSequence }) {
  const source = sourceId(endpoint, symbol, decimals);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || typeof rawQuote !== "string" ||
      !/^-?\d+(?:\.\d+)?$/.test(rawQuote)) throw new Error("Invalid live timestamp or original quote");
  const [whole, fraction = ""] = rawQuote.split(".");
  if (fraction.length > decimals) throw new Error("Live quote exceeds source precision");
  if (providerSequence !== undefined && (!Number.isSafeInteger(providerSequence) || providerSequence < 0)) throw new Error("Invalid provider sequence");
  return { source, epoch, rawQuote, decimals, quote: whole + (decimals ? "." + fraction.padEnd(decimals, "0") : ""),
    ...(providerSequence === undefined ? {} : { providerSequence }) };
}

export function createLiveResearch({ openStore = openResearchStore, report = error => console.error("[super-mathes]", error),
  autoRecover = true, now = Date.now, staleMs = 15000,
  runValidation = async (rows, options) => independentValidation(rows, options) } = {}) {
  if (!Number.isSafeInteger(staleMs) || staleMs < 1000) throw new Error("Invalid stale-feed threshold");
  const status = { state: "starting", lastError: null, activeSource: null };
  let activeSource = null, lastEpoch = null, intervals = [], fatal = null, arrival = 0, lastArrivalAt = null;
  const ready = openStore().then(async store => {
    if (autoRecover) await store.interruptAll("Application restarted; continuity is unknown");
    status.state = "ready";
    return store;
  }).catch(error => {
    fatal = error;
    status.state = "failed";
    status.lastError = String(error);
    report(error);
    throw error;
  });
  let queue = ready.then(() => undefined, () => undefined);
  function enqueue(action) {
    const result = queue.then(async () => {
      if (fatal) throw fatal;
      return action(await ready);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  function fail(error) {
    status.lastError = String(error);
    report(error);
  }
  function fatalError(error) {
    fatal = error;
    status.state = "failed";
    fail(error);
  }
  function reset() { activeSource = null; status.activeSource = null; lastEpoch = null; intervals = []; }
  async function stopStale(store) {
    if (activeSource && lastArrivalAt !== null && now() - lastArrivalAt >= staleMs) {
      await store.interrupt(activeSource, "Feed stale; continuity unknown");
      status.lastError = "Feed stale; continuity unknown";
      reset();
      return true;
    }
    return false;
  }

  return {
    status,
    recover() {
      return enqueue(async store => {
        await store.interruptAll("Collector changed; continuity is unknown");
        reset();
      });
    },
    checkStale() {
      return enqueue(async store => {
        try { return await stopStale(store); }
        catch (error) { fatalError(error); throw error; }
      });
    },
    ingest(input) {
      arrival++;
      const receivedAt = now(), previousArrival = lastArrivalAt;
      lastArrivalAt = receivedAt;
      let tick, invalid;
      try { tick = normalizeLiveTick(input); } catch (error) { invalid = error; }
      return enqueue(async store => {
        if (invalid) {
          if (activeSource) {
            try { await store.interrupt(activeSource, "Invalid live observation"); } catch (error) { fatalError(error); throw error; }
          }
          reset();
          fail(invalid);
          throw invalid;
        }
        try {
          if (activeSource && activeSource !== tick.source) {
            await store.interrupt(activeSource, "Feed source changed");
            reset();
          }
          activeSource = tick.source;
          status.activeSource = tick.source;
          let discontinuity = false;
          if (previousArrival !== null && (receivedAt < previousArrival || receivedAt - previousArrival >= staleMs)) discontinuity = true;
          if (lastEpoch !== null && tick.epoch > lastEpoch) {
            const gap = tick.epoch - lastEpoch;
            if (intervals.length >= 20) {
              const sorted = [...intervals].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
              discontinuity = discontinuity || gap > median * 3;
            }
            intervals.push(gap);
            if (intervals.length > 200) intervals.shift();
          }
          const result = await store.append({ ...tick, receivedAt }, { discontinuity });
          if (result.duplicate) {
            reset();
            fail(new Error("Repeated timestamp; continuity cannot be proven"));
          } else {
            lastEpoch = tick.epoch;
          }
          return result;
        } catch (error) {
          try { await store.interrupt(tick.source, "Rejected live observation"); }
          catch (storageError) { fatalError(storageError); throw storageError; }
          reset();
          fail(error);
          throw error;
        }
      });
    },
    interrupt(reason) {
      arrival++;
      return enqueue(async store => {
        if (!activeSource) return;
        try { await store.interrupt(activeSource, reason); }
        catch (error) { fatalError(error); throw error; }
        status.lastError = reason;
        reset();
      });
    },
    createPrediction(input, expectedSequence) {
      const frozen = createResearchPrediction(input).prediction;
      const createdAt = Date.now();
      return enqueue(async store => {
        try { await stopStale(store); } catch (error) { fatalError(error); throw error; }
        if (activeSource !== frozen.source) throw new Error("Prediction source is not the active feed");
        return store.createPrediction({ ...frozen, hazards: frozen.recurrence.hazards }, expectedSequence, createdAt);
      });
    },
    createModelPrediction(windowSize = 1000, model = "frequency") {
      if (!Number.isInteger(windowSize) || windowSize < 20 || windowSize > 10000) throw new Error("Window must be between 20 and 10000");
      if (!["frequency", "markov"].includes(model)) throw new Error("Invalid research model");
      return enqueue(async store => {
        try { await stopStale(store); } catch (error) { fatalError(error); throw error; }
        const source = activeSource, token = arrival;
        if (!source) throw new Error("No active feed");
        const state = await store.getSource(source);
        const rows = await store.list("observations", source, windowSize);
        const digits = rows.filter(row => row.segment === state.segment && row.sequence <= state.lastSeq).reverse().map(row => row.digit);
        if (digits.length < 20) throw new Error("At least 20 consecutive observations are required");
        const probabilities = model === "frequency" ? frequencyDistribution(digits) : transitionDistribution(digits);
        const ranking = rankDistribution(probabilities);
        if (ranking[0].probability === ranking[1].probability) throw new Error("Top digits are tied; no digit selected");
        if (arrival !== token || activeSource !== source) throw new Error("Feed advanced while preparing prediction; try again");
        const selectedDigit = ranking[0].digit;
        const input = {
          id: crypto.randomUUID(), source, timestamp: state.lastEpoch, selectedDigit, probabilities,
          hazards: Array(5).fill(probabilities[selectedDigit]), model: model === "frequency" ? "smoothed-frequency" : "smoothed-first-order-markov",
          assumptions: `Research only; ${digits.length} consecutive observations, alpha=1; constant independent-draw hazard assumed, not established.`,
        };
        return store.createPrediction(input, state.lastSeq, Date.now());
      });
    },
    benchmark(windowSize = 1000, warmup = 100, model = "frequency") {
      if (!Number.isInteger(windowSize) || windowSize < 20 || windowSize > 10000 ||
          !Number.isInteger(warmup) || warmup < 1 || warmup >= windowSize) throw new Error("Invalid benchmark settings");
      return enqueue(async store => {
        const source = activeSource;
        if (!source) throw new Error("No active feed");
        const state = await store.getSource(source);
        const rows = await store.list("observations", source, windowSize);
        const digits = rows.filter(row => row.segment === state.segment && row.sequence <= state.lastSeq).reverse().map(row => row.digit);
        const result = walkForward(digits, { warmup, model });
        const report = { id: crypto.randomUUID(), source, createdAt: Date.now(), segment: state.segment,
          throughSequence: state.lastSeq, model, warmup, sampleSize: digits.length, result };
        await store.saveReport(report);
        return report;
      });
    },
    async validateIndependent(source, warmup = 500, windowSize = 1000) {
      if (typeof source !== "string" || !source) throw new Error("Choose a source to validate");
      const snapshot = await enqueue(async store => {
        const state = await store.getSource(source);
        if (!state) throw new Error("Source not found");
        const rows = await store.list("observations", source, 10000);
        return {
          state,
          rows: rows.filter(row => row.segment === state.segment && row.sequence <= state.lastSeq).reverse(),
        };
      });
      const result = await runValidation(snapshot.rows, { warmup, windowSize });
      const record = {
        id: crypto.randomUUID(), kind: "independent-validation", source, createdAt: now(),
        segment: snapshot.state.segment, throughSequence: snapshot.state.lastSeq,
        fromSequence: snapshot.rows[0]?.sequence ?? null, sampleSize: snapshot.rows.length, result,
      };
      await enqueue(store => store.saveReport(record));
      return record;
    },
    importHistorical(name, inputs) {
      if (typeof name !== "string" || !name.trim() || !Array.isArray(inputs) || !inputs.length || inputs.length > 10000) {
        throw new Error("Historical import requires a source name and 1-10000 observations");
      }
      const source = JSON.stringify(["historical", name]);
      const rows = inputs.map(input => {
        const normalized = normalizeLiveTick({ ...input, endpoint: "historical", symbol: name });
        return { ...normalized, source };
      });
      if (rows.some(row => row.decimals !== rows[0].decimals)) throw new Error("Historical source precision must be consistent");
      if (rows.some((row, i) => i > 0 && row.epoch <= rows[i - 1].epoch)) throw new Error("Historical observations must be strictly ordered");
      return enqueue(async store => {
        let imported = 0;
        for (const row of rows) if (!(await store.append(row, { historical: true })).duplicate) imported++;
        return { source, imported };
      });
    },
    getSetting(key) { return enqueue(store => store.setting(key)); },
    setSetting(key, value) {
      if (!(key === "model" && ["frequency", "markov"].includes(value)) &&
          !(["windowSize", "warmup"].includes(key) && Number.isInteger(value) && value >= 1 && value <= 10000)) throw new Error("Invalid research setting");
      return enqueue(store => store.setting(key, value));
    },
    getSource(source) { return enqueue(store => store.getSource(source)); },
    listSources() { return enqueue(store => store.listSources()); },
    getPrediction(id) { return enqueue(store => store.getPrediction(id)); },
    listObservations(source, limit) { return enqueue(store => store.list("observations", source, limit)); },
    listPredictions(source, limit) { return enqueue(store => store.list("predictions", source, limit)); },
    listReports(source, limit) { return enqueue(store => store.list("reports", source, limit)); },
    listIntervals(source, limit) { return enqueue(store => store.list("intervals", source, limit)); },
  };
}
