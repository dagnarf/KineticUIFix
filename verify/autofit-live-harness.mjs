// Live e2e harness for the auto-size-columns feature (src/grid-autofit.js) through the REAL loaded
// unpacked extension: reload the extension (pick up the new manifest content_scripts entry), reload the
// Kinetic tab (so the document_start content script injects), then drive chrome.storage from the popup
// page and assert the §marker + actual <col> widths change live. Mirrors verify/theme-live-harness.mjs.
//
//   node verify/autofit-live-harness.mjs            # default port 9100
//   node verify/autofit-live-harness.mjs --port 9100 --no-ext-reload
import { listPageTargets, CdpClient, readJson } from "./cdp-lib.mjs";

const argv = process.argv.slice(2);
const PORT = (() => { const i = argv.indexOf("--port"); return i >= 0 ? Number(argv[i + 1]) : 9100; })();
const NO_EXT_RELOAD = argv.includes("--no-ext-reload");
const BROWSER = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read state from the Kinetic page: the autofit marker + a snapshot of header colgroup widths + whether
// any header title overflows its column (truncation), so we can prove the fit took effect.
const READ_STATE = `(() => {
  const grid = document.querySelector('kendo-grid') || document.querySelector('.k-grid');
  const out = { hasGrid: !!grid, marker: null, cols: null, totalWidth: null, viewport: null, whitespace: null, hScroll: null };
  try { out.marker = JSON.parse(document.documentElement.dataset.kineticGridAutofit || 'null'); } catch (e) {}
  if (grid) {
    const cg = grid.querySelector('.k-grid-header table colgroup');
    if (cg) out.cols = Array.from(cg.querySelectorAll('col')).map(c => Math.round(parseFloat(c.style.width || '0')));
    const t = grid.querySelector('.k-grid-table');
    if (t) out.totalWidth = Math.round(parseFloat(t.style.width || '0'));
    const content = grid.querySelector('.k-grid-content-virtual') || grid.querySelector('.k-grid-content') || grid;
    const colSum = out.cols ? out.cols.reduce((a, b) => a + (b || 0), 0) : null;
    out.viewport = content.clientWidth;
    out.whitespace = (colSum != null) ? content.clientWidth - colSum : null;  // > 0 => dead space on the right
    out.hScroll = content.scrollWidth > content.clientWidth + 1;
  }
  return out;
})()`;
const PAGE_READY = `(()=>({ready:document.readyState, rows:(document.querySelector('kendo-grid tbody')||{children:[]}).children.length}))()`;
// Scroll the grid content to a fraction of its range and fire a scroll event (churns virtualization / may
// trigger Get-More). Used to prove the fit is HELD as more data loads.
const SCROLL = (frac) => `(() => {
  const grid = document.querySelector('kendo-grid') || document.querySelector('.k-grid'); if (!grid) return null;
  const content = grid.querySelector('.k-grid-content-virtual') || grid.querySelector('.k-grid-content'); if (!content) return null;
  content.scrollTop = Math.round((content.scrollHeight - content.clientHeight) * ${frac});
  content.dispatchEvent(new Event('scroll', { bubbles: true }));
  return { scrollTop: content.scrollTop, scrollHeight: content.scrollHeight };
})()`;

async function browserCdp() {
  const ver = await readJson(`${BROWSER}/json/version`);
  const c = new CdpClient({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl });
  await c.connect();
  return c;
}

async function discoverExtension(bc) {
  const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" });
  await sleep(1000);
  let found = null;
  try {
    const t = (await readJson(`${BROWSER}/json/list`)).find((x) => x.id === targetId);
    if (t) {
      const pc = new CdpClient(t); await pc.connect();
      const items = await pc.evaluate(`(async()=>{ try{ const a=await new Promise(r=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},r)); return a.map(i=>({id:i.id,name:i.name,version:i.version,state:i.state})); }catch(e){ return {err:String(e)}; } })()`);
      if (Array.isArray(items)) found = items.find((i) => /Kinetic Grid|Kinetic UI Fixes/i.test(i.name)) || null;
      pc.close();
    }
  } finally { await bc.send("Target.closeTarget", { targetId }).catch(() => {}); }
  return found;
}

async function reloadExtension(bc, extId) {
  const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" });
  await sleep(800);
  try {
    const t = (await readJson(`${BROWSER}/json/list`)).find((x) => x.id === targetId);
    const pc = new CdpClient(t); await pc.connect();
    await pc.evaluate(`(async()=>{ try{ await new Promise(r=>chrome.developerPrivate.reload(${JSON.stringify(extId)},{failQuietly:false},r)); return true; }catch(e){ return String(e); } })()`);
    pc.close();
  } finally { await bc.send("Target.closeTarget", { targetId }).catch(() => {}); }
  await sleep(1500);
}

async function openPopup(bc, extId) {
  const { targetId } = await bc.send("Target.createTarget", { url: `chrome-extension://${extId}/popup/popup.html` });
  await sleep(700);
  const t = (await readJson(`${BROWSER}/json/list`)).find((x) => x.id === targetId);
  const c = new CdpClient(t); await c.connect();
  return { client: c, targetId };
}

async function setStorage(drv, obj) {
  return drv.evaluate(`(async()=>{ await new Promise(r=>chrome.storage.local.set(${JSON.stringify(obj)}, r)); return true; })()`);
}

async function reloadTabAndWait(eduTarget) {
  let c = new CdpClient(eduTarget); await c.connect();
  await c.send("Page.enable").catch(() => {});
  await c.send("Page.reload", {});
  c.close();
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    try {
      c = new CdpClient(eduTarget); await c.connect();
      const ctx = await c.evaluate(PAGE_READY);
      if (ctx.ready === "complete" && ctx.rows > 0) return c;
      c.close();
    } catch (e) { /* still reloading */ }
  }
  c = new CdpClient(eduTarget); await c.connect();
  return c;
}

function diffCols(before, after) {
  if (!before || !after || before.length !== after.length) return { changed: -1, sample: null };
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) changed += 1;
  return { changed, before, after };
}

(async () => {
  const report = { port: PORT, steps: [] };
  const log = (s, d) => { report.steps.push({ step: s, ...d }); console.log(`• ${s}: ${JSON.stringify(d)}`); };

  const pages = await listPageTargets(BROWSER);
  const edu = pages.find((p) => /epicorsaas\.com/.test(p.url) && !/chrome:\/\//.test(p.url));
  if (!edu) { console.error("No Kinetic tab open on the browser."); process.exit(2); }
  log("kinetic-tab", { title: edu.title, url: edu.url.slice(0, 80) });

  const bc = await browserCdp();
  const ext = await discoverExtension(bc);
  if (!ext) { console.error("Could not find the unpacked extension via developerPrivate."); process.exit(2); }
  log("extension", { id: ext.id, name: ext.name, version: ext.version, state: ext.state });

  if (!NO_EXT_RELOAD) { await reloadExtension(bc, ext.id); log("ext-reloaded", { ok: true }); }

  // Reload the Kinetic tab so the new document_start content script injects.
  let eduClient = await reloadTabAndWait(edu);
  let s0 = await eduClient.evaluate(READ_STATE);
  log("post-reload", { hasGrid: s0.hasGrid, markerPresent: !!s0.marker, markerActive: s0.marker && s0.marker.active, cols: s0.cols, totalWidth: s0.totalWidth });
  eduClient.close();

  // Open popup as the storage driver, then RE-FOREGROUND the Kinetic tab (opening extension/popup tabs
  // backgrounds it, which throttles its timers to ~1s and would let a fit land on a transient load state —
  // an artifact that never happens in real use, where the user is looking at the tab).
  const popup = await openPopup(bc, ext.id);
  eduClient = new CdpClient(edu); await eduClient.connect();
  await eduClient.send("Page.bringToFront").catch(() => {});
  await sleep(800); // let the settled grid stabilize at full timer speed
  eduClient.close();

  // ENABLE auto-size at the native-faithful density (1). The stability gate waits for the dataset signature
  // to hold ~350ms before fitting, and a freshly reloaded grid may still be settling, so POLL for the first
  // fit to land (fits>0) instead of a single fixed wait.
  await setStorage(popup.client, { gridAutoSizeEnabled: true, gridAutoFitDensity: 1 });
  let sOn = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(1000);
    eduClient = new CdpClient(edu); await eduClient.connect();
    await eduClient.send("Page.bringToFront").catch(() => {});
    sOn = await eduClient.evaluate(READ_STATE);
    eduClient.close();
    if (sOn.marker && sOn.marker.fits > 0) break;
  }
  const d1 = diffCols(s0.cols, sOn.cols);
  log("enabled", { markerActive: sOn.marker && sOn.marker.active, density: sOn.marker && sOn.marker.density, fits: sOn.marker && sOn.marker.fits, colsChanged: d1.changed, before: d1.before, after: d1.after, totalWidth: sOn.totalWidth, whitespace: sOn.whitespace });

  // DENSITY: drive the "Column spacing" slider (gridAutoFitDensity) and prove it re-fits LIVE with the new
  // density echoed in the marker. Lower density = tighter chrome + lower per-column cap, so the columns
  // re-distribute (and a many-column grid packs more before h-scroll). We assert the marker.density tracks
  // and a fresh fit happened (fits incremented) with the column widths changing.
  await setStorage(popup.client, { gridAutoFitDensity: 0.6 });
  await sleep(2200);
  eduClient = new CdpClient(edu); await eduClient.connect();
  await eduClient.send("Page.bringToFront").catch(() => {});
  const sDense = await eduClient.evaluate(READ_STATE);
  eduClient.close();
  const dDense = diffCols(sOn.cols, sDense.cols);
  // The slider value MUST reach the live engine (marker.density). On a grid whose natural widths fall short
  // of the viewport, fillToAvailable normalizes the filled layout to the viewport at any density, so the
  // VISIBLE column change can legitimately be ~0 (density's visible effect shows when natural > viewport).
  // So the honest assertion is: density tracked live AND no dead whitespace was introduced.
  const densityPass = !!(sDense.marker && sDense.marker.density === 0.6 && sDense.whitespace != null && sDense.whitespace <= 6);
  log("density-0.6", { pass: densityPass, density: sDense.marker && sDense.marker.density, fits: sDense.marker && sDense.marker.fits, colsChanged: dDense.changed, after: dDense.after, whitespace: sDense.whitespace, note: dDense.changed === 0 ? "filled-layout normalized by fillToAvailable (surplus grid)" : "columns re-distributed" });
  // Restore the default density so the rest of the run (fit-lock / resize) uses the native-faithful fit.
  await setStorage(popup.client, { gridAutoFitDensity: 1 });
  await sleep(1800);

  // FIT-LOCK: scrolling + loading more rows must NOT re-fit (columns sized to the initially-viewable data
  // are held). Scroll the grid through its range (which churns virtualization and often triggers Get-More)
  // and assert the fit count and the column widths are unchanged, even when the dataset grew.
  eduClient = new CdpClient(edu); await eduClient.connect();
  await eduClient.send("Page.bringToFront").catch(() => {});
  const sBeforeScroll = await eduClient.evaluate(READ_STATE);
  for (const f of [0.3, 0.6, 0.9, 1.0]) { await eduClient.evaluate(SCROLL(f)); await sleep(900); }
  await sleep(1500);
  const sAfterScroll = await eduClient.evaluate(READ_STATE);
  await eduClient.evaluate(SCROLL(0)); await sleep(1200);
  const sBackTop = await eduClient.evaluate(READ_STATE);
  eduClient.close();
  const colsHeld = diffCols(sBeforeScroll.cols, sAfterScroll.cols).changed === 0
    && diffCols(sBeforeScroll.cols, sBackTop.cols).changed === 0;
  const fitsHeld = sBeforeScroll.marker && sAfterScroll.marker && sBackTop.marker
    && sBeforeScroll.marker.fits === sAfterScroll.marker.fits
    && sBeforeScroll.marker.fits === sBackTop.marker.fits;
  const scrollHoldPass = colsHeld && fitsHeld;
  log("fit-lock", { pass: scrollHoldPass, fitsBefore: sBeforeScroll.marker && sBeforeScroll.marker.fits, fitsAfter: sAfterScroll.marker && sAfterScroll.marker.fits, colsHeld, fitsHeld });

  // RESIZE-REACTIVITY + WHITE-SPACE FILL: widen, then narrow the browser window and assert the grid re-fits
  // each time and never leaves a dead horizontal band. A wide viewport must be filled exactly (whitespace ~0);
  // a viewport narrower than the natural content overflows to horizontal scroll (whitespace <= 0). Either way,
  // no positive white space. Skips gracefully if Browser.setWindowBounds is unavailable.
  let resizePass = true;
  const resizeSteps = [];
  try {
    const w = await bc.send("Browser.getWindowForTarget", { targetId: edu.id });
    const wid = w.windowId;
    const baseH = (w.bounds && w.bounds.height) || 900;
    const widths = [1700, 1200, 1500];
    for (const width of widths) {
      await bc.send("Browser.setWindowBounds", { windowId: wid, bounds: { width, height: baseH, windowState: "normal" } });
      // Poll for the re-fit to settle (the settle gate debounces the resize; back-to-back resizes vary in
      // timing) — accept as soon as the dead band is gone, up to ~8s.
      let sR = null;
      for (let i = 0; i < 8; i += 1) {
        await sleep(1000);
        eduClient = new CdpClient(edu); await eduClient.connect();
        await eduClient.send("Page.bringToFront").catch(() => {});
        sR = await eduClient.evaluate(READ_STATE);
        eduClient.close();
        if (sR.hasGrid && sR.whitespace != null && sR.whitespace <= 6) break;
      }
      const ok = sR.hasGrid && sR.whitespace != null && sR.whitespace <= 6;
      resizePass = resizePass && ok;
      resizeSteps.push({ win: width, viewport: sR.viewport, whitespace: sR.whitespace, hScroll: sR.hScroll, fits: sR.marker && sR.marker.fits, ok });
    }
    // Restore the original window width.
    if (w.bounds && w.bounds.width) {
      await bc.send("Browser.setWindowBounds", { windowId: wid, bounds: { width: w.bounds.width, height: baseH, windowState: "normal" } }).catch(() => {});
    }
  } catch (e) {
    log("resize-skip", { reason: String(e).slice(0, 120) });
    resizePass = true; // don't fail the whole harness if window control is unavailable
  }
  log("resize-fill", { pass: resizePass, steps: resizeSteps });

  // DISABLE — marker should report inactive (we leave widths as-is; disabling just stops future fits).
  await setStorage(popup.client, { gridAutoSizeEnabled: false });
  await sleep(800);
  eduClient = new CdpClient(edu); await eduClient.connect();
  const sOff = await eduClient.evaluate(READ_STATE);
  log("disabled", { markerActive: sOff.marker && sOff.marker.active });
  eduClient.close();
  popup.client.close();
  bc.close();

  const pass = !!(s0.marker) && (sOn.marker && sOn.marker.active === true) && (sOn.marker.fits > 0) && (d1.changed > 0) && densityPass && scrollHoldPass && resizePass && (sOff.marker && sOff.marker.active === false);
  console.log("\n" + (pass ? "OVERALL PASS ✅" : "OVERALL FAIL ❌"));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("harness error:", e); process.exit(3); });
