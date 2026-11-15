(function () {
  'use strict';
  const MARKETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];
  const KEY = 'mfx.dashboard-auto.session.v1';
  const LOCK = 'mfx.dashboard-auto.session.v1';
  const WINDOW = 100;
  const $ = id => document.getElementById(id);
  const finite = value => Number.isFinite(value);
  const empty = () => ({account: null, config: null, total: 0, marketPnl: 0, active: null, direction: null, lastMarket: null, nextStake: null, trade: null, openTrades: [], closingMarket: null, wins: 0, losses: 0});
  let state = empty(), running = false, feed = null, feedReady = false, data = {}, status = 'Stopped.';
  let releaseLock = null, lockHeld = false, lockRequested = false, requestTimer = null, feedPing = null, balanceAccount = null;
  const recoveryRequests = new Map();
  let storageError = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object' || !finite(saved.total) || !finite(saved.marketPnl) ||
            !finite(saved.wins) || !finite(saved.losses) || !('trade' in saved) ||
            (saved.trade && (!saved.config || !['proposal', 'buy_pending', 'unknown', 'open'].includes(saved.trade.phase)))) throw new Error('Invalid saved session');
        if (saved.openTrades == null) saved.openTrades = [];
        if (!Array.isArray(saved.openTrades) || saved.openTrades.length > 2 ||
            saved.openTrades.some(t => !t || t.phase !== 'open' || !t.contractId) ||
            new Set(saved.openTrades.map(t => String(t.contractId))).size !== saved.openTrades.length) throw new Error('Invalid open trades');
        if (saved.trade && saved.trade.phase === 'open') { saved.openTrades.push(saved.trade); saved.trade = null; }
        if (saved.openTrades.length + (saved.trade ? 1 : 0) > 2) throw new Error('Too many outstanding trades');
        state = saved;
        if (!state.direction) state.direction = state.trade && state.trade.phase !== 'proposal' ? state.trade.direction : null;
        if (!state.direction && state.openTrades.length) state.direction = state.openTrades[0].direction;
        if (state.trade && state.trade.phase === 'proposal') state.trade = null;
        if (state.trade && state.trade.phase === 'buy_pending') state.trade.phase = 'unknown';
        status = state.trade || state.openTrades.length ? 'Stopped — interrupted trades require reconciliation.' : 'Stopped — previous session restored.';
      }
    } catch (e) { storageError = e.message; status = 'Stopped — cannot read session storage: ' + e.message; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) { storageError = e.message; running = false; status = 'Stopped — cannot save session: ' + e.message; render(); return false; }
  }
  function render() {
    const text = $( 'rfdStatus'), summary = $('rfdSummary'), button = $('rfdToggle');
    if (text) text.textContent = status;
    if (summary) summary.textContent = 'Account: ' + (state.account || 'not connected') + ' | Market: ' + (state.active || 'scanning') + ' | Direction: ' + (state.direction || '—') + ' | Market P/L: ' + state.marketPnl.toFixed(2) + ' | Overall P/L: ' + state.total.toFixed(2) + ' | Wins: ' + state.wins + ' | Losses: ' + state.losses + ' | Open: ' + state.openTrades.length + ' / 2' + (state.trade ? ' | Pending: ' + state.trade.phase : '');
    if (button) button.textContent = running ? 'Stop dashboard bot' : 'Start dashboard bot';
  }
  function release() {
    if (releaseLock) releaseLock();
    releaseLock = null;
    lockHeld = false;
  }
  function stop(message) {
    running = false;
    if (state.trade && state.trade.phase === 'proposal') {
      delete gridPending[state.trade.request]; clearTimeout(requestTimer); state.trade = null;
      save();
    }
    status = storageError ? 'Stopped — session storage unavailable: ' + storageError : message;
    if (feed) { const old = feed; feed = null; old.close(); }
    feedReady = false;
    clearInterval(feedPing);
    if (!state.trade && !state.openTrades.length) release();
    render();
  }
  async function lock() {
    if (lockHeld) return true;
    if (lockRequested) return false;
    if (!navigator.locks || !navigator.locks.request) { status = 'Stopped — browser session locking is unavailable.'; render(); return false; }
    lockRequested = true;
    return new Promise(resolve => {
      navigator.locks.request(LOCK, { ifAvailable: true }, held => {
        lockRequested = false;
        if (!held) { status = 'Stopped — this bot is active in another tab.'; render(); resolve(false); return; }
        lockHeld = true;
        resolve(true);
        return new Promise(done => { releaseLock = done; });
      }).catch(e => { lockRequested = false; status = 'Stopped — cannot lock session: ' + e.message; render(); resolve(false); });
    });
  }
  function config() {
    const ids = ['rfdStake', 'rfdMultiplier', 'rfdMarketTP', 'rfdMarketSL', 'rfdOverallTP', 'rfdOverallSL'];
    const values = ids.map(id => Number($(id).value));
    if (values.some(v => !finite(v) || v <= 0) || values[0] < 0.35 || values[1] < 1 || values[1] > 10) return null;
    return { stake: values[0], multiplier: values[1], marketTP: values[2], marketSL: values[3], overallTP: values[4], overallSL: values[5] };
  }
  function limit() {
    if (!state.config) return null;
    if (state.total >= state.config.overallTP - 1e-9) return 'Overall take profit reached: ' + state.total.toFixed(2);
    if (state.total <= -state.config.overallSL + 1e-9) return 'Overall stop loss reached: ' + state.total.toFixed(2);
    return null;
  }
  function finishMarket() {
    if (!state.closingMarket || state.trade || state.openTrades.length) return null;
    const message = state.closingMarket + '; final market P/L: ' + state.marketPnl.toFixed(2) + '; scanning another market.';
    state.lastMarket = state.active; state.active = null; state.direction = null;
    state.marketPnl = 0; state.nextStake = state.config.stake; state.closingMarket = null;
    return message;
  }
  function trend(candles, epoch) {
    const c = candles.filter(x => x.epoch + 60 <= epoch);
    if (c.length < 56 || epoch - (c[c.length - 1].epoch + 60) > 120) return null;
    let e20 = c[0].close, e50 = c[0].close, tr = [c[0].high - c[0].low], ema = [e20];
    for (let i = 1; i < c.length; i++) {
      const p = c[i], prev = c[i - 1];
      e20 = p.close * (2 / 21) + e20 * (19 / 21);
      e50 = p.close * (2 / 51) + e50 * (49 / 51);
      ema.push(e20);
      tr.push(Math.max(p.high - p.low, Math.abs(p.high - prev.close), Math.abs(p.low - prev.close)));
    }
    const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14 || 1e-9;
    const slope = (e20 - ema[ema.length - 4]) / 3 / atr;
    return e20 > e50 && slope > 0.08 ? 'RISE' : e20 < e50 && slope < -0.08 ? 'FALL' : null;
  }
  function signal(ticks, candles, now) {
    if (ticks.length < WINDOW + 1) return null;
    const last = ticks[ticks.length - 1];
    if (!finite(last.time) || Math.abs(now - last.time) > 10) return null;
    let earlier = ticks.length;
    while (earlier > 0 && ticks[earlier - 1].time > last.time - 60) earlier--;
    if (earlier < WINDOW + 1) return null;
    function percent(end) {
      let rise = 0, fall = 0;
      for (let i = end - WINDOW; i < end; i++) {
        if (ticks[i].price > ticks[i - 1].price) rise++;
        else if (ticks[i].price < ticks[i - 1].price) fall++;
      }
      return rise + fall ? 100 * rise / (rise + fall) : null;
    }
    const current = percent(ticks.length), previous = percent(earlier), direction = trend(candles, last.time);
    if (current === null || previous === null) return null;
    if (direction === 'RISE' && current >= 56 && current - previous > 0.3) return direction;
    if (direction === 'FALL' && 100 - current >= 56 && previous - current > 0.3) return direction;
    return null;
  }
  function validSignal(symbol, direction) {
    const d = data[symbol];
    return !!d && signal(d.ticks, d.candles, Date.now() / 1000) === direction;
  }
  function freshTick(symbol) {
    const ticks = data[symbol] && data[symbol].ticks;
    const last = ticks && ticks[ticks.length - 1];
    return !!last && finite(last.time) && Math.abs(Date.now() / 1000 - last.time) <= 10;
  }
  function openFeed() {
    data = Object.fromEntries(MARKETS.map(s => [s, {ticks: [], candles: []}]));
    let socket;
    try { socket = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public'); }
    catch (e) { stop('Stopped — market feed failed: ' + e.message); return; }
    feed = socket;
    socket.onopen = () => {
      if (feed !== socket) return;
      feedReady = true;
      status = 'Scanning — waiting for complete tick windows and closed candles.';
      render();
      MARKETS.forEach((s, i) => setTimeout(() => {
        if (feed !== socket || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ticks_history: s, count: 500, end: 'latest', style: 'ticks', subscribe: 1, req_id: i + 1}));
          socket.send(JSON.stringify({ticks_history: s, count: 120, end: 'latest', style: 'candles', granularity: 60, subscribe: 1, req_id: i + 101}));
        } catch (e) { stop('Stopped — market feed request failed: ' + e.message); }
      }, i * 150));
      feedPing = setInterval(() => { if (feed === socket && socket.readyState === 1) socket.send(JSON.stringify({ping: 1})); }, 25000);
    };
    socket.onmessage = event => {
      if (feed !== socket) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { stop('Stopped — invalid market feed response.'); return; }
      if (msg.error) { stop('Stopped — market feed error: ' + (msg.error.message || msg.error.code)); return; }
      const sym = msg.echo_req && msg.echo_req.ticks_history || (msg.tick && (msg.tick.symbol || msg.tick.underlying_symbol)) || (msg.ohlc && msg.ohlc.symbol);
      const d = data[sym];
      if (!d) return;
      if (msg.history) {
        const prices = msg.history.prices, times = msg.history.times;
        if (!Array.isArray(prices) || !Array.isArray(times) || prices.length !== times.length) { stop('Stopped — invalid tick history for ' + sym); return; }
        d.ticks = prices.map((price, i) => ({price: Number(price), time: Number(times[i])}));
        if (d.ticks.some((x, i) => !finite(x.price) || !finite(x.time) || (i && x.time < d.ticks[i - 1].time))) { stop('Stopped — invalid tick history for ' + sym); return; }
        for (let i = d.ticks.length - 1; i > 0; i--) {
          if (d.ticks[i].time - d.ticks[i - 1].time > 10) { d.ticks = d.ticks.slice(i); break; }
        }
      } else if (msg.candles) {
        if (!Array.isArray(msg.candles)) { stop('Stopped — invalid candle history for ' + sym); return; }
        d.candles = msg.candles.map(c => ({epoch: +c.epoch, high: +c.high, low: +c.low, close: +c.close}));
        if (d.candles.some((c, i) => !finite(c.epoch) || !finite(c.high) || !finite(c.low) || !finite(c.close) || (i && c.epoch <= d.candles[i - 1].epoch))) { stop('Stopped — invalid candle history for ' + sym); return; }
      } else if (msg.ohlc) {
        const c = {epoch: +(msg.ohlc.open_time != null ? msg.ohlc.open_time : msg.ohlc.epoch), high: +msg.ohlc.high, low: +msg.ohlc.low, close: +msg.ohlc.close};
        if (![c.epoch, c.high, c.low, c.close].every(finite)) { stop('Stopped — invalid candle for ' + sym); return; }
        const last = d.candles[d.candles.length - 1];
        if (last && last.epoch === c.epoch) d.candles[d.candles.length - 1] = c;
        else if (!last || c.epoch > last.epoch) { d.candles.push(c); if (d.candles.length > 300) d.candles.shift(); }
      } else if (msg.tick) {
        const tick = {price: Number(msg.tick.quote), time: Number(msg.tick.epoch)}, prev = d.ticks[d.ticks.length - 1];
        if (!finite(tick.price) || !finite(tick.time)) { stop('Stopped — invalid tick for ' + sym); return; }
        if (prev && (tick.time < prev.time || tick.time - prev.time > 10)) d.ticks = [];
        d.ticks.push(tick);
        if (d.ticks.length > 500) d.ticks.shift();
        evaluate(sym);
      }
    };
    socket.onclose = () => { if (feed === socket) stop('Stopped — market feed disconnected. Restart after the feed is available.'); };
    socket.onerror = () => { if (feed === socket) stop('Stopped — market feed connection error.'); };
  }
  function evaluate(symbol) {
    if (!running || !feedReady || state.trade || state.openTrades.length >= 2 || state.closingMarket || (state.active && state.active !== symbol) || (!state.active && state.lastMarket === symbol)) return;
    if (!gridAuthed || !gridWs || gridWs.readyState !== 1 || gridLoginId !== state.account) { stop('Stopped — Trading Grid connection or account changed.'); return; }
    const hit = limit();
    if (hit) { stop(hit); return; }
    const initial = !state.direction;
    const direction = state.direction || signal(data[symbol].ticks, data[symbol].candles, Date.now() / 1000);
    if (!direction) return;
    if (!freshTick(symbol)) return;
    if (!state.active) { state.active = symbol; state.marketPnl = 0; state.nextStake = state.config.stake; }
    const stake = Math.round(state.nextStake * 100) / 100;
    const reserved = state.openTrades.reduce((sum, trade) => sum + trade.stake, 0);
    if (!finite(stake) || stake < 0.35 || balanceAccount !== state.account || !finite(gridBalance) || stake + reserved > gridBalance) { stop('Stopped — next stake exceeds available balance or balance is unavailable.'); return; }
    const id = ++gridReqId;
    state.trade = {phase: 'proposal', symbol, direction, stake, request: id, initial};
    if (!save()) return;
    status = 'Requesting ' + direction + ' proposal for ' + symbol;
    render();
    const socket = gridWs;
    gridPending[id] = (proposal, error) => {
      if (!state.trade || state.trade.request !== id || state.trade.phase !== 'proposal') return;
      clearTimeout(requestTimer);
      if (error || !proposal || !proposal.id || !finite(Number(proposal.ask_price)) || Number(proposal.ask_price) <= 0) {
        state.trade = null; save(); stop('Stopped — proposal rejected: ' + (error && (error.message || error.code) || 'invalid proposal')); return;
      }
      if (!running || state.closingMarket || !feedReady || gridWs !== socket || !gridAuthed || gridLoginId !== state.account || limit() || !freshTick(symbol) || (initial && !validSignal(symbol, direction))) {
        state.trade = null; save(); stop('Stopped — trade cancelled before buy because signal or connection changed.'); return;
      }
      const reservedNow = state.openTrades.reduce((sum, item) => sum + item.stake, 0);
      if (balanceAccount !== state.account || !finite(gridBalance) || Number(proposal.ask_price) + reservedNow > gridBalance) { state.trade = null; save(); stop('Stopped — proposal price exceeds available balance or balance is unavailable.'); return; }
      const buyId = ++gridReqId;
      state.direction = direction;
      state.trade.phase = 'buy_pending'; state.trade.request = buyId;
      if (!save()) return;
      gridPending[buyId] = (buy, buyError) => {
        if (!state.trade || state.trade.request !== buyId || !['buy_pending', 'unknown'].includes(state.trade.phase)) return;
        clearTimeout(requestTimer);
        if (buyError) { if (initial) state.direction = null; state.trade = null; finishMarket(); save(); stop('Stopped — buy rejected: ' + (buyError.message || buyError.code)); return; }
        if (!buy || buy.contract_id == null) { state.trade.phase = 'unknown'; save(); stop('Stopped — buy outcome unknown; reconcile with Deriv before reset.'); return; }
        const accepted = state.trade;
        accepted.phase = 'open'; accepted.contractId = String(buy.contract_id);
        if (state.openTrades.some(t => t.contractId === accepted.contractId)) { accepted.phase = 'unknown'; save(); stop('Stopped — duplicate contract identity; reconcile with Deriv.'); return; }
        if (finite(Number(buy.buy_price))) accepted.stake = Number(buy.buy_price);
        state.openTrades.push(accepted); state.trade = null;
        if (!save()) { stop(status); return; }
        if (typeof acctOnBuy === 'function') acctOnBuy(state.account, accepted.stake);
        status = 'Trade open: ' + accepted.contractId;
        render();
        recover(true);
        if (running && !state.closingMarket) evaluate(symbol);
      };
      try { socket.send(JSON.stringify({buy: proposal.id, price: Number(proposal.ask_price), req_id: buyId})); }
      catch (e) { state.trade.phase = 'unknown'; save(); stop('Stopped — buy submission uncertain; reconcile with Deriv before reset.'); return; }
      requestTimer = setTimeout(() => { if (state.trade && state.trade.request === buyId && state.trade.phase === 'buy_pending') { state.trade.phase = 'unknown'; save(); stop('Stopped — buy response timed out; reconcile with Deriv before reset.'); } }, 15000);
    };
    try { socket.send(JSON.stringify({proposal: 1, req_id: id, amount: stake, basis: 'stake', contract_type: direction === 'RISE' ? 'CALL' : 'PUT', currency: gridCurrency, duration: 1, duration_unit: 't', underlying_symbol: symbol})); }
    catch (e) { delete gridPending[id]; state.trade = null; save(); stop('Stopped — proposal could not be sent: ' + e.message); return; }
    requestTimer = setTimeout(() => { if (state.trade && state.trade.request === id && state.trade.phase === 'proposal') { delete gridPending[id]; state.trade = null; save(); stop('Stopped — proposal timed out.'); } }, 15000);
  }
  function handleContract(c) {
    const trade = state.openTrades.find(t => t.contractId === String(c.contract_id));
    if (!lockHeld || !trade || trade.phase !== 'open' || String(c.contract_id) !== trade.contractId || gridLoginId !== state.account) return false;
    if (!(c.is_sold || c.is_expired)) return true;
    const pnl = c.profit == null || c.profit === '' ? NaN : Number(c.profit);
    const reported = String(c.status || '').toLowerCase();
    if (!finite(pnl) || (pnl === 0 && reported !== 'won' && reported !== 'lost') ||
        (pnl > 0 && reported === 'lost') || (pnl < 0 && reported === 'won')) { stop('Stopped — contract outcome unavailable or inconsistent; awaiting reconciliation.'); return true; }
    state.total += pnl; state.marketPnl += pnl;
    if (pnl > 0 || (pnl === 0 && reported === 'won')) { state.wins++; state.nextStake = state.config.stake; }
    else { state.losses++; state.nextStake = trade.stake * state.config.multiplier; }
    state.openTrades = state.openTrades.filter(t => t !== trade);
    const overall = limit();
    if (!state.closingMarket && (state.marketPnl >= state.config.marketTP - 1e-9 || state.marketPnl <= -state.config.marketSL + 1e-9)) {
      const reason = state.marketPnl >= state.config.marketTP - 1e-9 ? 'Market take profit' : 'Market stop loss';
      state.closingMarket = reason + ' reached on ' + state.active + ': ' + state.marketPnl.toFixed(2);
    }
    if (overall && !state.overallStop) state.overallStop = overall;
    if (state.trade && state.trade.phase === 'proposal') {
      delete gridPending[state.trade.request]; clearTimeout(requestTimer); state.trade = null;
    }
    const closing = state.closingMarket;
    const marketDone = finishMarket();
    status = marketDone || (closing ? closing + '; waiting for outstanding trades.' : 'Settled ' + trade.symbol + ': ' + pnl.toFixed(2) + '.');
    if (!save()) { stop(status); return true; }
    if (typeof acctOnTrade === 'function') acctOnTrade(state.account, Math.max(0, trade.stake + pnl));
    if (state.overallStop) stop(state.overallStop + (state.openTrades.length || state.trade ? ' — waiting for outstanding trades.' : ' — final P/L: ' + state.total.toFixed(2)));
    else if (!running) { if (!state.trade && !state.openTrades.length) release(); render(); }
    else { render(); if (!state.closingMarket && state.active) evaluate(state.active); }
    return true;
  }
  function interrupted() {
    balanceAccount = null;
    if (!lockHeld) return;
    clearTimeout(requestTimer);
    for (const [id, timer] of recoveryRequests.values()) { clearTimeout(timer); delete gridPending[id]; gridRecoveryRequests.delete(id); }
    recoveryRequests.clear();
    if (state.trade && state.trade.phase === 'proposal') {
      delete gridPending[state.trade.request]; state.trade = null;
    } else if (state.trade && state.trade.phase === 'buy_pending') state.trade.phase = 'unknown';
    save();
    stop(state.trade || state.openTrades.length ? 'Stopped — trades interrupted; reconnect to reconcile or check Deriv before reset.' : 'Stopped — Trading Grid disconnected.');
  }
  async function recover(quiet) {
    if (!state.openTrades.length) { if (!quiet) { status = state.trade ? 'Unknown buy — check Deriv before resetting.' : 'No open dashboard trade to reconcile.'; render(); } return; }
    if (state.account !== gridLoginId || !gridAuthed || !gridWs || gridWs.readyState !== 1) { status = 'Connect the original Trading Grid account to reconcile the open trade.'; render(); return; }
    const alreadyHeld = lockHeld;
    if (!await lock()) return;
    if (!alreadyHeld) load();
    if (!state.trade && !state.openTrades.length) { release(); return; }
    if (storageError) { status = 'Cannot reconcile: session storage is unavailable or invalid.'; render(); return; }
    if (state.account !== gridLoginId || !gridAuthed || !gridWs || gridWs.readyState !== 1) return;
    for (const trade of state.openTrades) {
      const contractId = trade.contractId;
      if (recoveryRequests.has(contractId)) continue;
      const id = ++gridReqId;
      gridRecoveryRequests.add(id);
      gridPending[id] = (c, e) => {
        const request = recoveryRequests.get(contractId);
        if (request && request[0] === id) { clearTimeout(request[1]); recoveryRequests.delete(contractId); }
        gridRecoveryRequests.delete(id);
        if (e || !c || String(c.contract_id) !== contractId) { status = 'Reconciliation failed: ' + (e && (e.message || e.code) || 'invalid response'); render(); return; }
        handleContract(c);
      };
      try {
        gridWs.send(JSON.stringify({proposal_open_contract: 1, contract_id: Number(contractId), req_id: id}));
        const timer = setTimeout(() => {
          const request = recoveryRequests.get(contractId);
          if (!request || request[0] !== id) return;
          delete gridPending[id]; gridRecoveryRequests.delete(id); recoveryRequests.delete(contractId);
          status = 'Reconciliation timed out; retry with Reconcile open trade.'; render();
        }, 15000);
        recoveryRequests.set(contractId, [id, timer]);
      } catch (e) { delete gridPending[id]; gridRecoveryRequests.delete(id); status = 'Reconciliation request failed: ' + e.message; render(); }
    }
  }
  async function toggle() {
    if (running) { stop('Stopped by user' + (state.trade || state.openTrades.length ? ' — awaiting trade settlement.' : '.')); return; }
    if (storageError) { status = 'Stopped — session storage unavailable: ' + storageError; render(); return; }
    if (!await lock()) return;
    load();
    if (storageError || state.trade || state.openTrades.length) { status = storageError ? 'Stopped — session storage unavailable: ' + storageError : 'Stopped — reconcile the interrupted trades before starting.'; if (!state.trade && !state.openTrades.length) release(); render(); return; }
    if (!gridAuthed || !gridWs || gridWs.readyState !== 1 || !gridLoginId) { stop('Connect an account on Trading Grid first.'); return; }
    if (balanceAccount !== gridLoginId || !finite(gridBalance)) { stop('Wait for the connected account balance on Trading Grid.'); return; }
    if (state.account && state.account !== gridLoginId) { stop('Stopped — reset the previous session before changing accounts.'); return; }
    const settings = config();
    if (!settings) { stop('Enter a valid stake, multiplier and all four positive limits.'); return; }
    if (state.config && JSON.stringify(state.config) !== JSON.stringify(settings)) { stop('Reset the stopped session before changing its settings.'); return; }
    if (gridIsVirtual !== true && !confirm('Start automatic trading on account ' + gridLoginId + ', which is not confirmed as demo? Martingale can rapidly increase losses.')) { stop('Start cancelled.'); return; }
    state.account = gridLoginId; state.config = settings;
    finishMarket();
    const hit = state.overallStop || limit(); if (hit) { stop(hit + ' — reset to start a new session.'); return; }
    if (!save()) { stop(status); return; }
    running = true; status = 'Connecting to the market feed…'; render(); openFeed();
  }
  async function reset() {
    if (running || state.openTrades.length || (state.trade && ['proposal', 'buy_pending', 'open'].includes(state.trade.phase))) { status = 'Stop the bot and wait for the open trades to settle before resetting.'; render(); return; }
    if (!await lock()) return;
    load();
    if (storageError) { status = 'Cannot reset: session storage is unavailable or invalid.'; render(); release(); return; }
    if (state.openTrades.length || (state.trade && state.trade.phase !== 'unknown')) { status = 'Cannot reset until the open trades are reconciled.'; render(); return; }
    if (state.trade && (!gridAuthed || gridLoginId !== state.account)) { status = 'Connect the original account ' + state.account + ' before resetting the unknown buy.'; render(); return; }
    const message = state.trade ? 'The buy outcome is UNKNOWN. Check Deriv account ' + state.account + ' and confirm that all related contracts have settled. Reset discards this session and its unverified P/L. Continue?' : 'Reset the dashboard bot session and its profit/loss?';
    if (!confirm(message)) { if (!state.trade) release(); return; }
    state = empty(); if (save()) status = 'Session reset.'; release(); render();
  }
  load();
  render();
  window.MFXDashboardAuto = {toggle, reset, interrupted, recover, handleContract, signal, trend, noteBalance(account, balance) {
    balanceAccount = finite(balance) && gridAuthed && account === gridLoginId ? account : null;
  }};
  if (state.openTrades.length && gridAuthed) recover(true);
})();
