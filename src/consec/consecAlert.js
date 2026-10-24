// Consecutive-tick alert bot: watches a fixed list of volatility indices on the public Deriv feed and warns
// (amber blink + beeps) at WARN consecutive same-direction ticks and signals (green blink + spoken reversal
// advice) at SIGNAL. It never places trades. Unchanged-price ticks are ignored.

export const WARN = 6;
export const SIGNAL = 10;
export const MARKETS = [
  ["R_10", "Volatility 10 (10%) Index", "2 Seconds"],
  ["R_25", "Volatility 25 (25%) Index", "2 Seconds"],
  ["R_50", "Volatility 50 (50%) Index", "2 Seconds"],
  ["R_75", "Volatility 75 (75%) Index", "2 Seconds"],
  ["R_100", "Volatility 100 (100%) Index", "2 Seconds"],
  ["1HZ10V", "Volatility 10 (1s) Index", "1 Second"],
  ["1HZ25V", "Volatility 25 (1s) Index", "1 Second"],
  ["1HZ50V", "Volatility 50 (1s) Index", "1 Second"],
  ["1HZ75V", "Volatility 75 (1s) Index", "1 Second"],
  ["1HZ100V", "Volatility 100 (1s) Index", "1 Second"],
  ["1HZ15V", "Volatility 15 (1s) Index", "1 Second"],
  ["1HZ30V", "Volatility 30 (1s) Index", "1 Second"],
];

export function createRun() { return { last: null, dir: 0, len: 0 }; }

// Feeds one price; returns the updated run { dir: 1|-1|0, len }.
export function feed(run, price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return run;
  if (run.last !== null && p !== run.last) {
    const d = p > run.last ? 1 : -1;
    if (d === run.dir) run.len++; else { run.dir = d; run.len = 1; }
  }
  run.last = p;
  return run;
}

export function levelOf(len) { return len >= SIGNAL ? "signal" : len >= WARN ? "warn" : "idle"; }
// The advised trade is the reversal of the run.
export const adviceOf = (dir) => (dir > 0 ? "sell" : "buy");

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const runs = {}, spoken = {}, beeped = {};
  let ws = null, timer = null, ctx = null, soundOn = true, started = false;
  const $ = (id) => document.getElementById(id);

  const audio = () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); } catch (_) {} return ctx; };
  const beep = (freq, dur, at = 0) => {
    const c = soundOn && audio(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = freq; o.type = "square"; g.gain.value = 0.08;
    o.connect(g); g.connect(c.destination);
    const t = c.currentTime + at; o.start(t); o.stop(t + dur);
  };
  const speak = (text) => {
    if (!soundOn || !window.speechSynthesis) return;
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch (_) {}
  };

  const build = () => {
    const host = $("ouConsecHost"); if (!host || host.dataset.built) return;
    host.dataset.built = "1";
    host.innerHTML = `
      <style>
        .cs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:10px}
        .cs-card{background:#0a0e17;border:1px solid var(--line);border-radius:10px;padding:10px}
        .cs-card .n{font-weight:700;font-size:13px}.cs-card .s{font-size:10px;color:var(--muted)}
        .cs-card .r{font-size:22px;font-weight:800;margin:6px 0 2px}.cs-card .a{font-size:12px;min-height:16px}
        .cs-warn{border-color:#ffb020;animation:csAmber .6s infinite}.cs-signal{border-color:#22c55e;animation:csGreen .5s infinite}
        @keyframes csAmber{0%,100%{background:#0a0e17}50%{background:#7a5200}}
        @keyframes csGreen{0%,100%{background:#0a0e17}50%{background:#0f6b32}}
      </style>
      <div class="grid-card" style="margin-bottom:14px">
        <h2>⬆⬇ Consecutive Tick Prediction Bot</h2>
        <div class="gc-sub">Detects continuous rises or falls of ticks on the volatility indices below. At <b>${WARN}</b> consecutive ticks the market blinks <b style="color:#ffb020">amber</b> with a warning beep. At <b>${SIGNAL}</b> it blinks <b style="color:#22c55e">green</b> and announces the trade to place: <b>Sell</b> after a run of rises, <b>Buy</b> after a run of falls (the reversal). Unchanged ticks are ignored. This bot only alerts; it does not place trades.</div>
        <div style="display:flex;gap:14px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="csSound" checked> Sound alerts</label>
          <button class="gc-btn" id="csTest" type="button">🔔 Test sound</button>
          <span id="csConn" class="gc-sub">connecting…</span>
        </div>
        <div class="cs-grid" id="csGrid"></div>
      </div>`;
    $("csGrid").innerHTML = MARKETS.map(([s, n, f]) => `<div class="cs-card" id="cs_${s}"><div class="n">${n}</div><div class="s">${f}</div><div class="r" id="csR_${s}">—</div><div class="a" id="csA_${s}">waiting for ticks…</div></div>`).join("");
    $("csSound").addEventListener("change", (e) => { soundOn = e.target.checked; if (soundOn) audio(); });
    $("csTest").addEventListener("click", () => { audio(); beep(880, 0.15); beep(880, 0.15, 0.25); speak("Place trade sell on the volatility"); });
  };

  const paint = (sym) => {
    const run = runs[sym], card = $("cs_" + sym); if (!card) return;
    const lvl = levelOf(run.len), word = run.dir > 0 ? "rise" : "fall";
    card.className = "cs-card" + (lvl === "warn" ? " cs-warn" : lvl === "signal" ? " cs-signal" : "");
    $("csR_" + sym).innerHTML = run.len ? `<span style="color:${run.dir > 0 ? "#22c55e" : "#ef4444"}">${run.dir > 0 ? "▲" : "▼"} ${run.len}</span>` : "—";
    $("csA_" + sym).innerHTML = lvl === "signal" ? `<b style="color:#22c55e">Place trade: ${adviceOf(run.dir).toUpperCase()}</b> (${run.len} ${word}s)`
      : lvl === "warn" ? `<b style="color:#ffb020">Warning: ${run.len} consecutive ${word}s</b>`
      : run.len ? `${run.len} consecutive ${word}${run.len > 1 ? "s" : ""}` : "no run";
  };

  const onTick = (sym, price) => {
    const run = runs[sym] || (runs[sym] = createRun());
    const before = run.len, beforeDir = run.dir;
    feed(run, price);
    const lvl = levelOf(run.len);
    if (run.len < WARN || run.dir !== beforeDir || run.len < before) { spoken[sym] = false; beeped[sym] = false; }
    if (lvl === "warn" && !beeped[sym]) { beeped[sym] = true; beep(660, 0.2); beep(660, 0.2, 0.3); }
    if (lvl === "signal" && !spoken[sym]) {
      spoken[sym] = true; beep(1000, 0.25); beep(1200, 0.25, 0.3);
      const m = MARKETS.find((x) => x[0] === sym);
      speak(`Place trade ${adviceOf(run.dir)} on ${m ? m[1].replace(/\(.*?\)/g, "") : sym}`);
    }
    paint(sym);
  };

  const connect = () => {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public"); } catch (_) { timer = setTimeout(connect, 3000); return; }
    ws.onopen = () => {
      const c = $("csConn"); if (c) c.textContent = "● live";
      MARKETS.forEach(([s], i) => setTimeout(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ticks: s, subscribe: 1 })); }, i * 120));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.msg_type === "tick" && m.tick) { try { onTick(m.tick.symbol, m.tick.quote); } catch (e) { console.warn("consec tick", e); } }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      ws = null; const c = $("csConn"); if (c) c.textContent = "reconnecting…";
      Object.keys(runs).forEach((s) => { runs[s] = createRun(); paint(s); }); // a feed gap must not extend a run
      if (started) timer = setTimeout(connect, 3000);
    };
  };

  window.CONSEC = { start() { build(); started = true; connect(); }, stop() { started = false; clearTimeout(timer); if (ws) { try { ws.close(); } catch (_) {} } } };
}
