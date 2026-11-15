import { validVector } from "../ldpe/engine.js";

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

export function createResearchPrediction({ id, source, timestamp, probabilities, selectedDigit, hazards, model, assumptions }) {
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
  const prediction = Object.freeze({
    id, source, timestamp, selectedDigit, probabilities: Object.freeze([...probabilities]),
    recurrence: Object.freeze({
      hazards: Object.freeze(recurrence.hazards), within: Object.freeze(recurrence.within),
      exact: Object.freeze(recurrence.exact), notWithinFive: recurrence.notWithinFive,
    }),
    model, assumptions,
  });
  return Object.freeze({ prediction, observations: Object.freeze([]), appearancePosition: null, status: "Pending Immediate Outcome" });
}

export function observePrediction(record, observation) {
  if (record.appearancePosition !== null || record.observations.length >= 5 || record.status === "Unscorable") {
    throw new Error("Prediction is already finalized");
  }
  if (observation.source !== record.prediction.source || !Number.isSafeInteger(observation.epoch) ||
      observation.epoch <= (record.observations.at(-1)?.epoch ?? record.prediction.timestamp) ||
      !Number.isInteger(observation.digit) || observation.digit < 0 || observation.digit > 9) {
    throw new Error("Invalid, duplicate, or out-of-order prediction observation");
  }
  const observations = Object.freeze([...record.observations, Object.freeze({ source: observation.source, epoch: observation.epoch, digit: observation.digit })]);
  const position = observations.length;
  const hit = observation.digit === record.prediction.selectedDigit;
  const status = hit ? (position === 1 ? "Immediate Hit" : `Appeared Within ${position} Observations`) :
    (position === 1 ? "Immediate Miss" : position === 5 ? "Not Appeared Within 5 Observations" : "Recurrence Tracking");
  return Object.freeze({ prediction: record.prediction, observations, appearancePosition: hit ? position : null, status });
}

export function markUnscorable(record) {
  if (record.appearancePosition !== null || record.observations.length >= 5) throw new Error("Prediction is already finalized");
  return Object.freeze({ ...record, status: "Unscorable" });
}
