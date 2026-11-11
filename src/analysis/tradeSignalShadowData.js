// Read-only primitives for a future shadow selector. A contracts_for range is
// indicative only; an account-specific proposal is needed to verify a contract.

const UNIT_SECONDS = Object.freeze({ s: 1, m: 60, h: 3600, d: 86400 });

export function contractDurationSeconds(value) {
  const match = typeof value === 'string' && /^([1-9]\d*)([smhd])$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2]];
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function indicativeDurationRange(contracts, direction, durationSec) {
  if (!Array.isArray(contracts)) throw new TypeError('Contract specifications must be an array');
  if (direction !== 1 && direction !== -1) throw new RangeError('Direction must be 1 or -1');
  if (!Number.isSafeInteger(durationSec) || durationSec <= 0) throw new RangeError('Duration must be a positive whole number of seconds');
  const type = direction === 1 ? 'CALL' : 'PUT';
  const relevant = contracts.filter((contract) => contract && contract.contract_type === type && contract.contract_category === 'callput');
  const parsed = relevant.filter((contract) => contract.expiry_type !== 'tick').map((contract) => ({
    min: contractDurationSeconds(contract.min_contract_duration),
    max: contractDurationSeconds(contract.max_contract_duration),
    expiryType: contract.expiry_type,
  }));
  const ranges = parsed.filter((range) => range.min !== null && range.max !== null && range.min <= range.max);
  const match = ranges.find((range) => durationSec >= range.min && durationSec <= range.max);
  if (match) return { status: 'in-indicative-range', range: match, reason: 'In public specification range; an account-specific proposal is still required.' };
  if (ranges.length !== parsed.length) return { status: 'unknown', reason: 'A seconds-based public range could not be interpreted.' };
  if (!ranges.length) return { status: 'unknown', reason: 'No usable seconds-based public range for this direction.' };
  return { status: 'outside-indicative-range', ranges, reason: 'Outside the public seconds-based ranges for this direction.' };
}

// The first bucket is excluded because a bounded tick-history response may
// begin midway through it. Missing buckets are not invented or forward-filled.
export function aggregateClosedTicks(history, granularitySec, asOfSec) {
  if (!history || !Array.isArray(history.times) || !Array.isArray(history.prices) || history.times.length !== history.prices.length) {
    throw new TypeError('Tick times and prices must be equal-length arrays');
  }
  if (!Number.isSafeInteger(granularitySec) || granularitySec <= 0 || !Number.isSafeInteger(asOfSec) || asOfSec < 0) {
    throw new RangeError('Granularity and as-of time must be whole seconds');
  }
  const buckets = new Map();
  let firstBucket = null, previousTime = -1;
  for (let i = 0; i < history.times.length; i++) {
    const time = history.times[i];
    if (!Number.isSafeInteger(time) || time < 0 || time < previousTime) {
      throw new RangeError(`Invalid or unordered tick at index ${i}`);
    }
    previousTime = time;
    if (time > asOfSec) continue;
    const price = Number(history.prices[i]);
    if (!Number.isFinite(price) || price <= 0) throw new RangeError(`Invalid tick price at index ${i}`);
    const epoch = Math.floor(time / granularitySec) * granularitySec;
    if (firstBucket === null) firstBucket = epoch;
    if (epoch === firstBucket || epoch + granularitySec > asOfSec) continue;
    const candle = buckets.get(epoch);
    if (!candle) buckets.set(epoch, { epoch, open: price, high: price, low: price, close: price });
    else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
    }
  }
  const candles = [...buckets.values()];
  let lastGap = -1;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].epoch - candles[i - 1].epoch !== granularitySec) lastGap = i;
  }
  const tail = lastGap < 0 ? candles : candles.slice(lastGap);
  const lastClosedBucketEnd = tail.length ? tail[tail.length - 1].epoch + granularitySec : null;
  return {
    candles: tail,
    discardedBeforeLastGap: lastGap < 0 ? 0 : lastGap,
    sampleTicks: history.times.length,
    firstBucketExcluded: firstBucket,
    lastClosedBucketEnd,
    isCurrent: lastClosedBucketEnd === Math.floor(asOfSec / granularitySec) * granularitySec,
    limitation: 'Bounded tick sample; missing buckets are not fabricated and feed completeness is not guaranteed.',
  };
}
