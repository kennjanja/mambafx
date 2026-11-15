import { entropyBits, mutualInformation, validVector } from "./math.js";

export const UNIFORM = Object.freeze(Array(10).fill(0.1));

export function frequencyDistribution(digits, alpha = 1) {
  if (!Array.isArray(digits) || digits.some(d => !Number.isInteger(d) || d < 0 || d > 9) ||
      !Number.isFinite(alpha) || alpha <= 0) throw new Error("Invalid digit sequence or prior");
  const counts = Array(10).fill(alpha);
  for (const digit of digits) counts[digit]++;
  return counts.map(count => count / (digits.length + 10 * alpha));
}

export function transitionDistribution(digits, alpha = 1) {
  frequencyDistribution(digits, alpha);
  if (!digits.length) return [...UNIFORM];
  const counts = Array(10).fill(alpha), current = digits.at(-1);
  for (let i = 1; i < digits.length; i++) if (digits[i - 1] === current) counts[digits[i]]++;
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map(count => count / total);
}

export function sequenceDiagnostics(digits) {
  const frequencies = frequencyDistribution(digits);
  const transitions = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) transitions[digits[i - 1]][digits[i]]++;
  return {
    sampleSize: digits.length,
    counts: Array.from({ length: 10 }, (_, d) => digits.filter(x => x === d).length),
    smoothedFrequencies: frequencies,
    entropyBits: entropyBits(frequencies),
    transitionInformation: mutualInformation(transitions),
  };
}

export function rankDistribution(probabilities) {
  if (!Array.isArray(probabilities) || probabilities.length !== 10 || !validVector(probabilities) || probabilities.some(p => p > 1)) {
    throw new Error("Expected a normalized ten-digit distribution");
  }
  return probabilities.map((probability, digit) => ({ digit, probability }))
    .sort((a, b) => b.probability - a.probability || a.digit - b.digit);
}
