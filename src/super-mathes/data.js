import { extractDigit } from "./math.js";

// Each ledger represents one explicitly identified digit-generating source.
export class SequenceLedger {
  #observations = [];

  constructor(source) {
    if (typeof source !== "string" || !source.trim()) throw new Error("A source identifier is required");
    Object.defineProperty(this, "source", { value: source, enumerable: true });
  }

  append({ source, epoch, quote, decimals }) {
    if (source !== this.source) throw new Error("Observation source does not match the ledger");
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isInteger(decimals) || decimals < 0) {
      throw new Error("Invalid observation timestamp or precision");
    }
    if (typeof quote !== "string") throw new Error("Quote must preserve its original precision");
    const digit = extractDigit(quote, decimals);
    if (digit === null) throw new Error("Invalid quote or precision");
    const previous = this.#observations.at(-1);
    if (previous && epoch <= previous.epoch) {
      if (epoch === previous.epoch && quote === previous.quote && decimals === previous.decimals) return null;
      throw new Error("Conflicting or out-of-order observation");
    }
    const observation = Object.freeze({ source, epoch, quote, decimals, digit });
    this.#observations.push(observation);
    return observation;
  }

  snapshot() {
    return this.#observations.map(o => ({ ...o }));
  }

  static fromSnapshot(source, observations) {
    if (!Array.isArray(observations)) throw new Error("Expected an observation array");
    const ledger = new SequenceLedger(source);
    for (const observation of observations) {
      const saved = ledger.append(observation);
      if (!saved || saved.digit !== observation.digit) throw new Error("Duplicate or corrupt stored observation");
    }
    return ledger;
  }
}
