export function createRiseFallSample(){
  const prices = [];
  return {
    reset(){ prices.length = 0; },
    observe(price){
      if (!Number.isFinite(price)) return null;
      prices.push(price);
      if (prices.length > 51) prices.shift();
      if (prices.length < 51) return null;
      const count = (start) => {
        let rise = 0, fall = 0;
        for (let i = start + 1; i < start + 50; i++){
          if (prices[i] > prices[i - 1]) rise++;
          else if (prices[i] < prices[i - 1]) fall++;
        }
        return { rise, fall };
      };
      const previous = count(0), current = count(1);
      return {
        risePercent: current.rise * 100 / 49,
        fallPercent: current.fall * 100 / 49,
        riseIncreasing: current.rise > previous.rise,
        fallIncreasing: current.fall > previous.fall,
      };
    },
  };
}

export function riseFallDirection(sample, trend){
  if (!sample) return null;
  if (sample.risePercent > 56 && sample.riseIncreasing && trend === 'bullish') return 'RISE';
  if (sample.fallPercent > 56 && sample.fallIncreasing && trend === 'bearish') return 'FALL';
  return null;
}

export function discoverVolatilityMarkets(rows){
  if (!Array.isArray(rows)) throw new TypeError('Expected active_symbols array');
  const found = new Map();
  for (const row of rows){
    if (!row || row.is_trading_suspended || row.exchange_is_open === 0) continue;
    const symbol = String(row.underlying_symbol || row.symbol || '');
    const name = String(row.underlying_symbol_name || row.display_name || row.name || '');
    const standardSymbol = /^(R_\d+|1HZ\d+V)$/i.test(symbol);
    const standardName = /^volatility\s+\d+(?:\s*\(1s\))?(?:\s+index)?$/i.test(name.trim());
    if (!/^[a-z0-9_]+$/i.test(symbol) || !(standardName || (!name && standardSymbol))) continue;
    if (row.market && row.market !== 'synthetic_index') continue;
    found.set(symbol, { symbol, name: name || symbol });
  }
  return [...found.values()];
}

if (typeof window !== 'undefined') window.MFXRiseFallSignal = { createRiseFallSample, riseFallDirection, discoverVolatilityMarkets };
