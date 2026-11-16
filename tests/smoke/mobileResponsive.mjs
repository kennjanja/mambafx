// Start an isolated Chrome with remote debugging and serve the app locally first.
// MFX_CDP_URL and MFX_PREVIEW_URL may override the default localhost ports.
import assert from "node:assert/strict";

const cdp = process.env.MFX_CDP_URL || "http://127.0.0.1:19352";
const preview = process.env.MFX_PREVIEW_URL || "http://127.0.0.1:18871/";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(preview).hostname)) {
  throw new Error("Responsive smoke tests require a local preview");
}
const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let next = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const [resolve, reject] = pending.get(message.id);
  pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, [resolve, reject]);
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: preview });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate("document.readyState === 'complete' && typeof showPage === 'function' && !!document.getElementById('mfxBot')");
    if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "application did not load");
  await new Promise(resolve => setTimeout(resolve, 2000));

  const nav = await evaluate(`(() => {
    const toggle = document.getElementById('mobileNavToggle');
    const nav = document.getElementById('pageNavigation');
    const before = getComputedStyle(nav).display;
    toggle.click();
    const open = getComputedStyle(nav).display;
    const expanded = toggle.getAttribute('aria-expanded');
    document.getElementById('navSuperMathes').click();
    return {before,open,expanded,closed:getComputedStyle(nav).display,
      collapsed:toggle.getAttribute('aria-expanded'),
      selected:document.querySelector('.page.active').id,
      label:document.getElementById('mobileNavLabel').textContent};
  })()`);
  assert.equal(nav.before, "none");
  assert.notEqual(nav.open, "none");
  assert.equal(nav.expanded, "true");
  assert.equal(nav.closed, "none");
  assert.equal(nav.collapsed, "false");
  assert.equal(nav.selected, "page-supermathes");
  assert.match(nav.label, /Super Mathes/);

  let tradingReady = false;
  for (let i = 0; i < 30 && !tradingReady; i++) {
    tradingReady = await evaluate("!!document.querySelector('#page-supermathes .sm-trading-nav')");
    if (!tradingReady) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(tradingReady, "Super Mathes dashboard did not load");
  const trading = await evaluate(`(() => {
    [...document.querySelectorAll('#page-supermathes .sm-trading-nav button')]
      .find(button => button.textContent === 'Trading Dashboard').click();
    const form=document.querySelector('#page-supermathes .sm-trading-form');
    return {visible:!!form && form.getClientRects().length > 0,
      controls:[...form.querySelectorAll('button')].map(button => button.textContent.trim())};
  })()`);
  assert.ok(trading.visible);
  assert.ok(trading.controls.includes("Start trading"));
  assert.ok(trading.controls.includes("Stop trading"));

  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
  const repositioned = await evaluate(`(() => {
    const bots=['mfxBot','dabBot'].map(id => document.getElementById(id));
    for (const bot of bots) Object.assign(bot.style,{left:'1200px',top:'1200px',right:'auto',bottom:'auto'});
    window.dispatchEvent(new Event('resize'));
    for (const id of ['mfxMinBtn','dabMinBtn']) document.getElementById(id).click();
    const rects=bots.map(bot => bot.getBoundingClientRect().toJSON());
    for (const id of ['mfxMinBtn','dabMinBtn']) document.getElementById(id).click();
    for (const bot of bots) Object.assign(bot.style,{left:'',top:'',right:'',bottom:''});
    return rects;
  })()`);
  for (const rect of repositioned) {
    assert.ok(rect.left >= 0 && rect.right <= 320 && rect.top >= 0 && rect.bottom <= 800,
      "restored floating widgets must remain visible when expanded");
  }

  for (const width of [320, 360, 390, 700]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: true });
    for (const page of ["live", "accounts", "grid", "digits", "supermathes", "candles", "sossow", "bazu"]) {
      const state = await evaluate(`(() => {
        showPage(${JSON.stringify(page)});
        const active=document.querySelector('.page.active');
        return {viewport:innerWidth, document:document.documentElement.scrollWidth,
          width:active.clientWidth, content:active.scrollWidth,
          overflow:[...active.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth+3 && e.getBoundingClientRect().width > 0)
            .slice(0,8).map(e => ({tag:e.tagName,id:e.id,cls:String(e.className),width:e.clientWidth,scroll:e.scrollWidth,style:getComputedStyle(e).overflowX}))};
      })()`);
      assert.equal(state.document, state.viewport, `${page} at ${width}px overflows the document`);
      assert.ok(state.content <= state.width + 2, `${page} at ${width}px needs whole-page horizontal scrolling: ${JSON.stringify(state)}`);
    }
    const widgets = await evaluate(`['mfxBot','dabBot'].map(id => {
      const e=document.getElementById(id), r=e.getBoundingClientRect();
      return {min:e.classList.contains('minimised'),left:r.left,right:r.right,top:r.top,bottom:r.bottom};
    })`);
    for (const widget of widgets) {
      assert.ok(widget.min, `widget should start collapsed on a phone`);
      assert.ok(widget.left >= 0 && widget.right <= width && widget.top >= 0 && widget.bottom <= 800,
        `widget must remain inside the ${width}px viewport`);
    }
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  const desktop = await evaluate(`({
    nav:getComputedStyle(document.getElementById('pageNavigation')).display,
    toggle:getComputedStyle(document.getElementById('mobileNavToggle')).display,
    viewport:innerWidth,document:document.documentElement.scrollWidth
  })`);
  assert.equal(desktop.nav, "flex");
  assert.equal(desktop.toggle, "none");
  assert.ok(desktop.document <= desktop.viewport);
  console.log("Responsive navigation, dashboards and widgets passed at phone and desktop sizes.");
} finally {
  await new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.onclose = resolve;
    ws.close();
  });
  await fetch(`${cdp}/json/close/${target.id}`);
}
