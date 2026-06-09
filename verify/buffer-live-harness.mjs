// Live e2e for the bigger-scroll-buffer feature through the REAL extension in DEBUGGER (M1) mode.
// Grants the optional debugger permission (via a user-gesture eval in the popup), enables grid fixes in
// debugger mode + the scroll buffer, reloads the Kinetic tab (background re-fetches + rewrites main.js with
// the hook + baked config), then measures rendered-row count + blank frames on a fast scroll, buffer
// OFF vs ON. Falls back gracefully if the debugger permission can't be granted headlessly.
//   node verify/buffer-live-harness.mjs
import { listPageTargets, CdpClient, readJson } from "./cdp-lib.mjs";
const BROWSER = "http://127.0.0.1:9100";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function bcdp() { const v = await readJson(`${BROWSER}/json/version`); const c = new CdpClient({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }); await c.connect(); return c; }
async function findExt(bc) { const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" }); await sleep(900); let f = null; try { const t = (await readJson(`${BROWSER}/json/list`)).find(x => x.id === targetId); const pc = new CdpClient(t); await pc.connect(); const items = await pc.evaluate(`(async()=>{const a=await new Promise(r=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true},r));return a.map(i=>({id:i.id,name:i.name}));})()`); f = items.find(i => /Kinetic Grid|Kinetic UI Fixes/i.test(i.name)); pc.close(); } finally { await bc.send("Target.closeTarget", { targetId }).catch(() => {}); } return f; }
async function reloadExt(bc, id) { const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" }); await sleep(700); try { const t = (await readJson(`${BROWSER}/json/list`)).find(x => x.id === targetId); const pc = new CdpClient(t); await pc.connect(); await pc.evaluate(`(async()=>{await new Promise(r=>chrome.developerPrivate.reload(${JSON.stringify(id)},{failQuietly:false},r));return true;})()`); pc.close(); } finally { await bc.send("Target.closeTarget", { targetId }).catch(() => {}); } await sleep(1500); }
async function openPopup(bc, id) { const { targetId } = await bc.send("Target.createTarget", { url: `chrome-extension://${id}/popup/popup.html` }); await sleep(700); const t = (await readJson(`${BROWSER}/json/list`)).find(x => x.id === targetId); const c = new CdpClient(t); await c.connect(); return c; }
async function setStore(c, o) { return c.evaluate(`(async()=>{await new Promise(r=>chrome.storage.local.set(${JSON.stringify(o)},r));return true;})()`); }

const MARK = `(()=>{var m=window.__KINETIC_GRID_FIX__;return m?{applied:m.applied,mode:m.mode,lastWindow:m.lastWindow,scrollBuffer:m.scrollBuffer===true,bufferWindow:m.bufferWindow,naturalWindow:m.naturalWindow,corrections:m.corrections}:null;})()`;
// Count REAL data rows (not the loading/norecords placeholder).
const DATAROWS = `(()=>{const g=document.querySelector('kendo-grid');if(!g)return 0;const tb=g.querySelector('.k-grid-content tbody')||g.querySelector('.k-grid-content-virtual tbody');if(!tb)return 0;let n=0;for(const r of tb.children){const cls=' '+(r.className||'')+' ';if(cls.indexOf(' k-table-row ')>=0||cls.indexOf(' k-master-row ')>=0)n++;}return n;})()`;
// Stepped full-scroll probe — assumes the grid already has data rows. Kendo lazily GROWS the rendered DOM
// window toward `take` as you scroll, so we step through the whole grid and capture the MAX rendered rows
// (the true buffered window) plus how many sampled frames are near-blank (the symptom). A measurement
// right after a single nudge under-reads the window (it hasn't expanded yet) — that was the earlier bug.
const SCROLLPROBE = `new Promise(res=>{const g=document.querySelector('kendo-grid');const c=g.querySelector('.k-grid-content');const tb=g.querySelector('.k-grid-content tbody');const inView=()=>{const cr=c.getBoundingClientRect();let n=0;for(const r of tb.children){const rr=r.getBoundingClientRect();if(rr.bottom>cr.top&&rr.top<cr.bottom)n++;}return n;};const max=Math.max(0,c.scrollHeight-c.clientHeight);const step=Math.max(c.clientHeight*0.9, Math.round(max/22));let i=0,maxRows=0;const views=[];const iv=setInterval(()=>{c.scrollTop=Math.min(max,i*step);c.dispatchEvent(new Event('scroll'));maxRows=Math.max(maxRows,tb.children.length);views.push(inView());i++;if(i>24){clearInterval(iv);c.scrollTop=0;res({maxRendered:maxRows,minInView:Math.min(...views),blankFrames:views.filter(x=>x<=8).length,frames:views.length,scrollH:c.scrollHeight,clientH:c.clientHeight});}},110);})`;

// Reload + wait until the grid has REAL data rows (debugger mode re-fetches the big bundle, so this can
// take a while; the tab is backgrounded by the popup/extensions tabs so its timers are throttled).
async function reloadTab(edu) {
  let c = new CdpClient(edu); await c.connect(); await c.send("Page.enable").catch(()=>{}); await c.send("Page.reload", {}); c.close();
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    try {
      c = new CdpClient(edu); await c.connect();
      await c.send("Page.bringToFront").catch(()=>{});
      const rows = await c.evaluate(DATAROWS);
      if (rows > 10) { await sleep(800); return c; }
      c.close();
    } catch (e) { /* still loading */ }
  }
  c = new CdpClient(edu); await c.connect(); await c.send("Page.bringToFront").catch(()=>{}); return c;
}

const bc = await bcdp();
const ext = await findExt(bc); console.log("ext:", ext && ext.id);
await reloadExt(bc, ext.id);
const popup = await openPopup(bc, ext.id);
// Try to grant debugger with a user gesture.
const granted = await popup.evaluate(`(async()=>{try{return await new Promise(r=>chrome.permissions.request({permissions:['debugger']},g=>r(g===true)));}catch(e){return 'ERR:'+e;}})()`, { userGesture: true });
console.log("debugger grant attempt:", granted);
const has = await popup.evaluate(`(async()=>await new Promise(r=>chrome.permissions.contains({permissions:['debugger']},r)))()`);
console.log("debugger granted now:", has);
if (has !== true) {
  console.log("\nCannot grant debugger headlessly — open the popup, switch Mechanism to 'Debugger', approve the Chrome dialog, then re-run. The buffer is a debugger-mode feature.");
  popup.close(); bc.close(); process.exit(2);
}

const edu = (await listPageTargets(BROWSER)).find(p => /epicorsaas\.com/.test(p.url));
// Baseline: grid fixes ON, debugger mode, buffer OFF.
await setStore(popup, { gridFixEnabled: true, gridFixMode: "debugger", gridScrollBufferEnabled: false, gridAutoSizeEnabled: false });
await sleep(600);
let c = await reloadTab(edu);
const mOff = await c.evaluate(MARK);
const sOff = await c.evaluate(SCROLLPROBE);
console.log("\n[buffer OFF] marker:", JSON.stringify(mOff));
console.log("[buffer OFF] scroll:", JSON.stringify(sOff));
c.close();
// Buffer ON.
await setStore(popup, { gridScrollBufferEnabled: true });
await sleep(700);
c = await reloadTab(edu);
const mOn = await c.evaluate(MARK);
const sOn = await c.evaluate(SCROLLPROBE);
console.log("\n[buffer ON] marker:", JSON.stringify(mOn));
console.log("[buffer ON] scroll:", JSON.stringify(sOn));
c.close();
// Reset to defaults.
await setStore(popup, { gridFixEnabled: false, gridScrollBufferEnabled: false, gridFixMode: "runtime" });
popup.close(); bc.close();
// Verdict rests on the directly-measurable, dataset-robust mechanism: the hook grows `take` AND Kendo
// renders a substantially larger DOM window (which is what keeps a fast fling populated). blankFrames is
// informational only — it's noisy (depends on the dataset size, which differs across reloads, and on the
// scroll step size; small steps never exceed even the natural window, so they don't stress the buffer).
const hookFired = !!(mOn && mOn.scrollBuffer === true && mOn.bufferWindow > mOn.naturalWindow);
const biggerWindow = !!(sOn && sOff && sOn.maxRendered > sOff.maxRendered * 1.5);
console.log("\nsummary:", JSON.stringify({ hookFired, biggerWindow, offMaxRendered: sOff && sOff.maxRendered, onMaxRendered: sOn && sOn.maxRendered, bufferWindow: mOn && mOn.bufferWindow, naturalWindow: mOn && mOn.naturalWindow, blankFramesOff: sOff && sOff.blankFrames, blankFramesOn: sOn && sOn.blankFrames, note: "blankFrames is noisy/informational" }));
const pass = hookFired && biggerWindow;
console.log("\n" + (pass ? "BUFFER LIVE PASS ✅ (hook grew the window; Kendo rendered a ~" + Math.round((sOn.maxRendered / Math.max(1, sOff.maxRendered)) * 10) / 10 + "x larger DOM buffer)" : "BUFFER LIVE INCONCLUSIVE — see summary above"));
process.exit(pass ? 0 : 1);
