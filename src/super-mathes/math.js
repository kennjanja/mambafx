export function extractDigit(quote, decimals) {
  if (typeof quote !== "string" || !/^-?\d+(?:\.\d+)?$/.test(quote) ||
      !Number.isInteger(decimals) || decimals < 0) return null;
  const parts = quote.split(".");
  const fraction = parts[1] || "";
  if (fraction.length !== decimals) return null;
  return Number(decimals ? fraction[decimals - 1] : parts[0].at(-1));
}

export function validVector(vector) {
  return Array.isArray(vector) && vector.length === 10 &&
    vector.every(p => Number.isFinite(p) && p >= 0 && p <= 1) &&
    Math.abs(vector.reduce((sum, p) => sum + p, 0) - 1) <= 1e-9;
}

export function entropyBits(vector) {
  return vector.reduce((sum, p) => p > 0 ? sum - p * Math.log2(p) : sum, 0);
}

export function mutualInformation(table, minimum = 500) {
  const rows = table.map(row => row.reduce((sum, n) => sum + n, 0));
  const cols = table[0].map((_, j) => table.reduce((sum, row) => sum + row[j], 0));
  const n = rows.reduce((sum, count) => sum + count, 0);
  if (n < minimum) return { status: "insufficient", n, needed: minimum };
  let mi = 0;
  for (let i = 0; i < table.length; i++) {
    for (let j = 0; j < cols.length; j++) {
      const count = table[i][j];
      if (count) mi += count / n * Math.log2(count * n / (rows[i] * cols[j]));
    }
  }
  return { status: "ok", n, miBits: mi, interpretation: "Descriptive estimate only; no significance test or predictive claim." };
}

export const logLoss = (vector, digit) => -Math.log(Math.max(vector[digit], 1e-12));
export const brier = (vector, digit) => vector.reduce((sum, p, i) => sum + (p - Number(i === digit)) ** 2, 0);
