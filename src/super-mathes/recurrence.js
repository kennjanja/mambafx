import { validVector } from "./math.js";

// The supplied hazards are frozen before outcomes: h[n] is P(hit at n+1 | all earlier misses).
export function recurrenceProbabilities(hazards) {
  if (!Array.isArray(hazards) || hazards.length !== 5 ||
      hazards.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error("Expected five valid conditional hazards");
  let survival = 1;
  const within = [], exact = [];
  for (const hazard of hazards) {
    exact.push(survival * hazard);
    survival *= 1 - hazard;
    within.push(1 - survival);
  }
  return { hazards: [...hazards], within, exact, notWithinFive: survival };
}

export function createResearchPrediction({ id, source, timestamp, probabilities, selectedDigit, hazards, model, assumptions, evidence }) {
  if (typeof id !== "string" || !id || typeof source !== "string" || !source ||
      !Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isInteger(selectedDigit) ||
      selectedDigit < 0 || selectedDigit > 9 || !Array.isArray(probabilities) ||
      probabilities.length !== 10 || !validVector(probabilities) || probabilities.some(p => p > 1) ||
      typeof model !== "string" || !model || typeof assumptions !== "string" || !assumptions) {
    throw new Error("Invalid research prediction");
  }
  if (!Array.isArray(hazards) || hazards[0] !== probabilities[selectedDigit]) {
    throw new Error("Immediate hazard must match the selected digit probability");
  }
  const recurrence = recurrenceProbabilities(hazards);
  let frozenEvidence;
  if (evidence !== undefined) {
    const { frequency, markov, frequencyWeight, minimumTransitions, transitions, observations, frequencyLeader, markovLeader, versions } = evidence;
    if (![frequency, markov].every(v => Array.isArray(v) && v.length === 10 && validVector(v) && v.every(p => p <= 1)) ||
        !Number.isFinite(frequencyWeight) || frequencyWeight <= 0 || frequencyWeight >= 1 ||
        !Number.isInteger(minimumTransitions) || minimumTransitions < 1 || !Number.isInteger(transitions) ||
        transitions < minimumTransitions || !Number.isInteger(observations) || observations < 20 ||
        ![frequencyLeader, markovLeader].every(d => d === null || Number.isInteger(d) && d >= 0 && d <= 9) ||
        !versions || !["frequency", "markov", "combination"].every(k => typeof versions[k] === "string" && versions[k])) {
      throw new Error("Invalid combined model evidence");
    }
    if (probabilities.some((p, i) => Math.abs(p - (frequencyWeight * frequency[i] + (1 - frequencyWeight) * markov[i])) > 1e-12)) {
      throw new Error("Combined distribution does not match model evidence");
    }
    frozenEvidence = Object.freeze({ frequency: Object.freeze([...frequency]), markov: Object.freeze([...markov]), frequencyWeight,
      minimumTransitions, transitions, observations, frequencyLeader, markovLeader, versions: Object.freeze({ ...versions }) });
  }
  const prediction = Object.freeze({
    id, source, timestamp, selectedDigit, probabilities: Object.freeze([...probabilities]),
    recurrence: Object.freeze({
      hazards: Object.freeze(recurrence.hazards), within: Object.freeze(recurrence.within),
      exact: Object.freeze(recurrence.exact), notWithinFive: recurrence.notWithinFive,
    }),
    model, assumptions, ...(frozenEvidence ? { evidence: frozenEvidence } : {}),
  });
  return Object.freeze({ prediction, observations: Object.freeze([]), appearancePosition: null, status: "Pending Immediate Outcome" });
}

export function observePrediction(record, observation) {
  if (record.observations.length >= 5 || record.status === "Unscorable") {
    throw new Error("Prediction is already finalized");
  }
  if (observation.source !== record.prediction.source || !Number.isSafeInteger(observation.epoch) ||
      observation.epoch <= (record.observations.at(-1)?.epoch ?? record.prediction.timestamp) ||
      !Number.isInteger(observation.digit) || observation.digit < 0 || observation.digit > 9) {
    throw new Error("Invalid, duplicate, or out-of-order prediction observation");
  }
  const observationRecord = { source: observation.source, epoch: observation.epoch, digit: observation.digit };
  if (observation.sequence !== undefined) observationRecord.sequence = observation.sequence;
  const observations = Object.freeze([...record.observations, Object.freeze(observationRecord)]);
  const position = observations.length;
  const hit = observation.digit === record.prediction.selectedDigit;
  const firstAppearance = record.appearancePosition ?? (hit ? position : null);
  const status = firstAppearance !== null ? (firstAppearance === 1 ? "Immediate Hit" : `Appeared Within ${firstAppearance} Observations`) :
    (position === 1 ? "Immediate Miss" : position === 5 ? "Not Appeared Within 5 Observations" : "Recurrence Tracking");
  return Object.freeze({ prediction: record.prediction, observations, appearancePosition: firstAppearance, status });
}

export function markUnscorable(record) {
  if (record.observations.length >= 5 || record.status === "Unscorable") throw new Error("Prediction is already finalized");
  return Object.freeze({ ...record, status: "Unscorable" });
}
