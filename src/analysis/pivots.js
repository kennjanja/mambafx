// Swing/internal pivots with explicit confirmation.
// A pivot at index p with window n is only *confirmed* at bar p+n, once n bars to its right exist.
// Provisional pivots are candidates in the unconfirmed tail and may disappear or move.

function isPivot(candles, p, left, right, type, strict) {
  const key = type === 'high' ? 'high' : 'low';
  const v = candles[p][key];
  for (let k = 1; k <= left; k++) {
    const o = candles[p - k][key];
    if (type === 'high' ? o >= v : o <= v) return false; // strict on the left breaks plateau ties
  }
  for (let k = 1; k <= right; k++) {
    const o = candles[p + k][key];
    if (strict ? (type === 'high' ? o >= v : o <= v) : (type === 'high' ? o > v : o < v)) return false;
  }
  return true;
}

// strict=true also rejects ties on the right side (the mtf/ fractal definition used by Bazu).
export function detectPivots(candles, window, strict = false) {
  const n = Math.max(1, window | 0);
  const confirmed = [];
  for (let p = n; p + n < candles.length; p++) {
    for (const type of ['high', 'low']) {
      if (isPivot(candles, p, n, n, type, strict)) {
        confirmed.push({
          type, index: p, epoch: candles[p].epoch, price: candles[p][type],
          window: n, confirmedIndex: p + n, confirmedEpoch: candles[p + n].epoch, status: 'confirmed',
        });
      }
    }
  }
  confirmed.sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.index - b.index);
  classifyPivots(confirmed);

  // Provisional: pivots whose right window is not complete yet (last n bars).
  const provisional = [];
  const last = candles.length - 1;
  for (let p = Math.max(n, last - n + 1); p <= last; p++) {
    const right = last - p;
    for (const type of ['high', 'low']) {
      if (isPivot(candles, p, n, right, type, strict)) {
        provisional.push({
          type, index: p, epoch: candles[p].epoch, price: candles[p][type],
          window: n, confirmedIndex: null, confirmedEpoch: null, status: 'provisional',
        });
      }
    }
  }
  return { confirmed, provisional };
}

// Label HH/LH for highs and HL/LL for lows vs the previous confirmed pivot of the same type.
export function classifyPivots(pivots) {
  const prev = { high: null, low: null };
  for (const pv of pivots) {
    const p = prev[pv.type];
    if (!p) pv.label = null;
    else if (pv.type === 'high') pv.label = pv.price > p.price ? 'HH' : pv.price < p.price ? 'LH' : 'EQH';
    else pv.label = pv.price < p.price ? 'LL' : pv.price > p.price ? 'HL' : 'EQL';
    prev[pv.type] = pv;
  }
  return pivots;
}
