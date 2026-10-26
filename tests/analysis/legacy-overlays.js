// Frozen snapshot of the inline implementations that lived in index.html before extraction.
// Parity oracle for overlays.parity.test.mjs. Do not edit.
function msdSafeMax(arr, ...extra){
  let m = extra.length ? Math.max(...extra) : -Infinity;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v > m) m = v; }
  return m;
}
function msdSafeMin(arr, ...extra){
  let m = extra.length ? Math.min(...extra) : Infinity;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v < m) m = v; }
  return m;
}

function findSwings(arr, lb = 2){
  const highs = [], lows = [];
  for (let i = lb; i < arr.length - lb; i++){
    let isHigh = true, isLow = true;
    for (let j = i - lb; j <= i + lb; j++){
      if (j === i) continue;
      if (arr[j].high >= arr[i].high) isHigh = false;
      if (arr[j].low <= arr[i].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: arr[i].high });
    if (isLow) lows.push({ i, price: arr[i].low });
  }
  return { highs, lows };
}

function clusterLevels(points, range, tol = 0.012){
  const used = new Array(points.length).fill(false);
  const out = [];
  for (let a = 0; a < points.length; a++){
    if (used[a]) continue;
    let sum = points[a].price, n = 1, lastI = points[a].i;
    used[a] = true;
    for (let b = a + 1; b < points.length; b++){
      if (used[b]) continue;
      if (Math.abs(points[b].price - points[a].price) <= range * tol){
        sum += points[b].price; n++; used[b] = true;
        lastI = Math.max(lastI, points[b].i);
      }
    }
    out.push({ price: sum / n, touches: n, lastI });
  }
  // strongest first
  return out.sort((x, y) => y.touches - x.touches);
}

function computeSR(arr){
  if (arr.length < 8) return { support: [], resistance: [] };
  const range = msdSafeMax(arr.map(c => c.high)) - msdSafeMin(arr.map(c => c.low)) || 1;
  const { highs, lows } = findSwings(arr, 2);
  const last = arr[arr.length - 1].close;
  const resAll = clusterLevels(highs, range).filter(l => l.price >= last);
  const supAll = clusterLevels(lows, range).filter(l => l.price <= last);
  return { resistance: resAll.slice(0, 3), support: supAll.slice(0, 3) };
}

function computeZones(arr){
  if (arr.length < 6) return { demand: [], supply: [] };
  const bodies = arr.map(c => Math.abs(c.close - c.open));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length || 1;
  const demand = [], supply = [];
  for (let i = 1; i < arr.length - 1; i++){
    const c = arr[i];
    const body = Math.abs(c.close - c.open);
    if (body < avgBody * 1.6) continue;           // not an impulse
    const origin = arr[i - 1];                     // basing candle before impulse
    const zTop = Math.max(origin.open, origin.close, c.open);
    const zBot = Math.min(origin.open, origin.close, c.open);
    if (c.close > c.open){                          // bullish impulse -> demand below
      demand.push({ top: zTop, bot: zBot, fromI: i - 1 });
    } else {                                        // bearish impulse -> supply above
      supply.push({ top: zTop, bot: zBot, fromI: i - 1 });
    }
  }
  // keep the most recent few of each, avoid overlap clutter
  const trim = list => list.slice(-3);
  return { demand: trim(demand), supply: trim(supply) };
}

function computeFVG(arr){
  const gaps = [];
  for (let i = 1; i < arr.length - 1; i++){
    const a = arr[i - 1], c = arr[i + 1];
    let gap = null;
    if (a.high < c.low){
      gap = { top: c.low, bot: a.high, fromI: i, dir: 1 };
    } else if (a.low > c.high){
      gap = { top: a.low, bot: c.high, fromI: i, dir: -1 };
    }
    if (!gap) continue;
    // check mitigation by any candle AFTER the 3-candle pattern
    let mitigated = false;
    for (let j = i + 2; j < arr.length; j++){
      if (gap.dir === 1 && arr[j].low <= gap.top){ mitigated = true; break; }
      if (gap.dir === -1 && arr[j].high >= gap.bot){ mitigated = true; break; }
    }
    if (!mitigated) gaps.push(gap);
  }
  return gaps.slice(-5); // most recent unmitigated gaps
}

function computeOrderBlocks(arr){
  if (arr.length < 6) return { bull: [], bear: [] };
  const bodies = arr.map(c => Math.abs(c.close - c.open));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length || 1;
  const bull = [], bear = [];
  for (let i = 2; i < arr.length - 1; i++){
    const c = arr[i];
    const body = Math.abs(c.close - c.open);
    if (body < avgBody * 1.7) continue;             // need an impulse
    if (c.close > c.open){
      // bullish impulse -> find last bearish candle before it
      for (let k = i - 1; k >= 0 && k >= i - 3; k--){
        if (arr[k].close < arr[k].open){
          const ob = { top: arr[k].high, bot: arr[k].low, fromI: k, dir: 1 };
          // unmitigated if no later candle closed back below the block bottom
          let mit = false;
          for (let j = i + 1; j < arr.length; j++){ if (arr[j].low < ob.bot){ mit = true; break; } }
          if (!mit) bull.push(ob);
          break;
        }
      }
    } else {
      // bearish impulse -> find last bullish candle before it
      for (let k = i - 1; k >= 0 && k >= i - 3; k--){
        if (arr[k].close > arr[k].open){
          const ob = { top: arr[k].high, bot: arr[k].low, fromI: k, dir: -1 };
          let mit = false;
          for (let j = i + 1; j < arr.length; j++){ if (arr[j].high > ob.top){ mit = true; break; } }
          if (!mit) bear.push(ob);
          break;
        }
      }
    }
  }
  return { bull: bull.slice(-2), bear: bear.slice(-2) };
}

function computeLiquidity(arr){
  if (arr.length < 8) return { buy: [], sell: [] };
  const range = msdSafeMax(arr.map(c => c.high)) - msdSafeMin(arr.map(c => c.low)) || 1;
  const { highs, lows } = findSwings(arr, 2);
  // only levels touched by 2+ pivots count as liquidity
  const buy = clusterLevels(highs, range, 0.008).filter(l => l.touches >= 2).slice(0, 3);
  const sell = clusterLevels(lows, range, 0.008).filter(l => l.touches >= 2).slice(0, 3);
  return { buy, sell };
}

function computeStructure(arr){
  if (arr.length < 10) return [];
  const { highs, lows } = findSwings(arr, 2);
  const events = [];
  // merge swings in index order with type
  const swings = [...highs.map(h => ({ ...h, t: "H" })), ...lows.map(l => ({ ...l, t: "L" }))]
    .sort((a, b) => a.i - b.i);
  let lastHigh = null, lastLow = null, trend = 0; // 1 up, -1 down
  for (let s = 0; s < swings.length; s++){
    const sw = swings[s];
    if (sw.t === "H"){
      if (lastHigh && sw.price > lastHigh.price){
        const kind = trend === -1 ? "CHoCH" : "BOS";
        events.push({ i: sw.i, price: sw.price, dir: 1, kind });
        trend = 1;
      }
      lastHigh = sw;
    } else {
      if (lastLow && sw.price < lastLow.price){
        const kind = trend === 1 ? "CHoCH" : "BOS";
        events.push({ i: sw.i, price: sw.price, dir: -1, kind });
        trend = -1;
      }
      lastLow = sw;
    }
  }
  return events.slice(-3); // most recent structure events
}

function computeEquilibrium(arr){
  if (arr.length < 5) return null;
  const hi = msdSafeMax(arr.map(c => c.high));
  const lo = msdSafeMin(arr.map(c => c.low));
  const eq = (hi + lo) / 2;
  const last = arr[arr.length - 1].close;
  return { hi, lo, eq, zone: last > eq ? "PREMIUM" : "DISCOUNT", last };
}

function computeOTE(arr){
  if (arr.length < 8) return null;
  const { highs, lows } = findSwings(arr, 2);
  if (!highs.length || !lows.length) return null;
  const lastH = highs[highs.length - 1];
  const lastL = lows[lows.length - 1];
  const range = lastH.price - lastL.price;
  if (range <= 0) return null;
  if (lastH.i > lastL.i){
    // up-leg low->high : OTE measured down from the high (long zone)
    return { dir: 1, top: lastH.price - range * 0.62, bot: lastH.price - range * 0.79,
             sweet: lastH.price - range * 0.705, fromI: lastL.i };
  } else {
    // down-leg high->low : OTE measured up from the low (short zone)
    return { dir: -1, top: lastL.price + range * 0.79, bot: lastL.price + range * 0.62,
             sweet: lastL.price + range * 0.705, fromI: lastH.i };
  }
}

function computeTrendline(arr){
  if (arr.length < 10) return [];
  const { highs, lows } = findSwings(arr, 3);
  const out = [];
  if (lows.length >= 2){
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    if (b.price > a.price && b.i > a.i) out.push({ i1:a.i, p1:a.price, i2:b.i, p2:b.price, kind:"up" });
  }
  if (highs.length >= 2){
    const a = highs[highs.length - 2], b = highs[highs.length - 1];
    if (b.price < a.price && b.i > a.i) out.push({ i1:a.i, p1:a.price, i2:b.i, p2:b.price, kind:"down" });
  }
  return out;
}

function computeAMD(arr){
  if (arr.length < 25) return null;
  const N = arr.length;
  const look = Math.min(60, N - 4);            // search recent window
  const seg = arr.slice(N - look);
  const ranges = seg.map(c => c.high - c.low);
  const avgRange = ranges.reduce((a,b)=>a+b,0) / ranges.length || 1;
  // find the longest recent quiet base (consolidation) ending before the last few candles
  let best = null;
  for (let end = seg.length - 4; end >= 8; end--){
    let s = end;
    let bandHi = seg[end].high, bandLo = seg[end].low;
    while (s > 0){
      const nHi = Math.max(bandHi, seg[s-1].high);
      const nLo = Math.min(bandLo, seg[s-1].low);
      if ((nHi - nLo) > avgRange * 3.2) break;   // band too wide → not accumulation
      bandHi = nHi; bandLo = nLo; s--;
    }
    const len = end - s + 1;
    if (len >= 5){ best = { s, end, hi: bandHi, lo: bandLo, len }; break; }
  }
  if (!best) return null;
  const baseOffset = N - look;                 // map seg index → global index
  const acc = { i0: baseOffset + best.s, i1: baseOffset + best.end, hi: best.hi, lo: best.lo };
  // manipulation: a candle after the base that wicks beyond the band but closes back inside
  let manip = null;
  for (let i = best.end + 1; i < seg.length; i++){
    const c = seg[i];
    const pokeUp   = c.high > best.hi && c.close < best.hi;
    const pokeDown = c.low  < best.lo && c.close > best.lo;
    if (pokeUp || pokeDown){
      manip = { i: baseOffset + i, price: pokeUp ? c.high : c.low, dir: pokeUp ? -1 : 1 };
      break;
    }
  }
  // distribution: net displacement from end of base to last candle
  const last = arr[N - 1];
  const mid = (best.hi + best.lo) / 2;
  const dist = { i: acc.i1, toI: N - 1, dir: last.close >= mid ? 1 : -1, from: mid, to: last.close };
  return { acc, manip, dist };
}

function computeVolumeProfile(arr, bins = 24){
  if (arr.length < 5) return null;
  const hi = msdSafeMax(arr.map(c => c.high));
  const lo = msdSafeMin(arr.map(c => c.low));
  const range = hi - lo || 1;
  const buckets = new Array(bins).fill(0);
  arr.forEach(c => {
    const b0 = Math.floor(((c.low - lo) / range) * (bins - 1));
    const b1 = Math.floor(((c.high - lo) / range) * (bins - 1));
    for (let b = Math.max(0, b0); b <= Math.min(bins - 1, b1); b++) buckets[b]++;
  });
  const max = msdSafeMax(buckets, 1);
  let pocIdx = 0; buckets.forEach((v, i) => { if (v > buckets[pocIdx]) pocIdx = i; });
  const pocPrice = lo + (pocIdx + 0.5) / bins * range;
  return { hi, lo, range, buckets, max, bins, pocPrice };
}

export { findSwings, clusterLevels, computeSR, computeZones, computeFVG, computeOrderBlocks, computeLiquidity, computeStructure, computeEquilibrium, computeOTE, computeTrendline, computeAMD, computeVolumeProfile };
