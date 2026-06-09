// padding-live-harness.mjs — live CDP-9100 verification of the v3.5.0 per-component-family density
// feature. Reuses cdp-lib.mjs. Two layers, both on the live Education (SaaS950) tab:
//
//   1. MECHANISM (always): inject the extension's OWN engine output (src/padding-control.js buildCss)
//      as a probe <style> via CDP — the exact CSS the ISOLATED content script writes — then read back
//      the representative rendered element for each tested family/dim with getComputedStyle and assert
//      it MOVED in the expected direction (roomy => bigger, compact => smaller), a screenshot is taken,
//      and removing the <style> reverts the element to its captured baseline (reversibility / safety).
//
//   2. END-TO-END via the REAL loaded extension (--e2e): performs an "Unpacked Extension Reload"
//      (chrome.developerPrivate.reload) so the v3.5.0 content script is live, reloads Education so the
//      document_start injector is present, then drives chrome.storage.local.componentDensity from the
//      extension's own popup page and asserts the SAME per-family movement + the marker through the real
//      path, then OFF => exact revert.
//
// SAFETY: read-only Epicor; every DOM mutation is inject-measure-REMOVE; storage restored to default-OFF
// on exit; never clears cookies; re-resolves page ids each run via /json/list. No secrets logged.
//
// USAGE:
//   node verify/padding-live-harness.mjs            # mechanism proof (+ opportunistic e2e if loaded)
//   node verify/padding-live-harness.mjs --e2e      # reload the unpacked ext + drive it end-to-end
//   node verify/padding-live-harness.mjs --reload-only   # just reload the unpacked extension
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { CdpClient, listPageTargets, readJson } from "./cdp-lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = argVal("--port") || process.env.PORT || "9100";
const BROWSER = `http://127.0.0.1:${PORT}`;
const EXT_ID = argVal("--ext-id") || process.env.EXT_ID || "kddnihfgodhlkhjjipdfeppjcadbmibj";
const OUT_DIR = argVal("--out-dir") || path.join(ROOT, ".output", "chrome-plugin-grid-fix");
const SHOT_DIR = path.join(ROOT, ".tmp", "padding-live");
const TAKE_SHOTS = !process.argv.includes("--no-shots");
const E2E = process.argv.includes("--e2e");
const RELOAD_ONLY = process.argv.includes("--reload-only");

function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null; }

function loadEngine() {
  const src = readFileSync(path.join(ROOT, "src", "padding-control.js"), "utf8");
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "padding-control.js" });
  return sandbox.self.__KINETIC_PADDING_CONTROL___MODULE;
}
const ENGINE = loadEngine();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Representative rendered element + metric to read back per family/dim, and the test states that drive
// them. Each state is a single family/dim adjustment (so the moved element is unambiguous) plus a
// compact case. The element may be absent in the current view -> that state is reported "skipped".
const REP = {
  grid: {
    // measure the ROW box (the visible compaction), not a single cell — the row floor is the tallest
    // cell, so the rowHeight lever's real effect shows on the <tr>.
    rowHeight: { sel: ".k-grid tbody tr.k-table-row", metric: "height" },
    cellPad: { sel: ".k-grid td.k-table-td > .ep-grid-cell", metric: "paddingLeft" },
    font: { sel: ".k-grid td.k-table-td", metric: "fontSize" }
  },
  button: {
    padding: { sel: ".k-button", metric: "paddingTop" },
    font: { sel: ".k-button", metric: "fontSize" }
  },
  textbox: {
    height: { sel: ".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner", metric: "height" },
    font: { sel: ".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner", metric: "fontSize" }
  },
  dropdown: {
    height: { sel: ".k-input-value-text", metric: "height" },
    font: { sel: ".k-input-value-text", metric: "fontSize" }
  },
  tabs: {
    padding: { sel: ".k-tabstrip-items .k-link", metric: "paddingTop" },
    font: { sel: ".k-tabstrip-items .k-link", metric: "fontSize" }
  },
  label: {
    font: { sel: "label.ep-shape-label, .k-label", metric: "fontSize" }
  },
  // Cards & layout — the white-space lever. gutter shrinks the column padding, cardPad the card body
  // padding, fieldGap the inter-field margin-bottom. All measured INSIDE a panel card.
  card: {
    gutter: { sel: ".ep-panel-card .col.col-container", metric: "paddingLeft" },
    cardPad: { sel: ".ep-panel-card .ep-content", metric: "paddingTop" },
    fieldGap: { sel: ".ep-panel-card .ep-component-top-element.ep-text-box, .ep-panel-card .ep-component-top-element.ep-date-picker", metric: "marginBottom" }
  }
};

const STATES = [
  { name: "grid-rowHeight-roomy", family: "grid", dim: "rowHeight", factor: 1.6, dir: "up" },
  { name: "grid-cellPad-compact", family: "grid", dim: "cellPad", factor: 0.4, dir: "down" },
  { name: "grid-cellPad-roomy", family: "grid", dim: "cellPad", factor: 1.8, dir: "up" },
  { name: "grid-font-roomy", family: "grid", dim: "font", factor: 1.3, dir: "up" },
  { name: "button-padding-roomy", family: "button", dim: "padding", factor: 1.6, dir: "up" },
  { name: "button-font-roomy", family: "button", dim: "font", factor: 1.4, dir: "up" },
  { name: "textbox-height-roomy", family: "textbox", dim: "height", factor: 1.4, dir: "up" },
  { name: "dropdown-height-roomy", family: "dropdown", dim: "height", factor: 1.4, dir: "up" },
  { name: "tabs-padding-roomy", family: "tabs", dim: "padding", factor: 1.6, dir: "up" },
  { name: "label-font-roomy", family: "label", dim: "font", factor: 1.3, dir: "up" },
  { name: "grid-rowHeight-compact", family: "grid", dim: "rowHeight", factor: 0.7, dir: "down" },
  { name: "card-gutter-compact", family: "card", dim: "gutter", factor: 0.3, dir: "down" },
  { name: "card-cardPad-compact", family: "card", dim: "cardPad", factor: 0.3, dir: "down" },
  { name: "card-fieldGap-compact", family: "card", dim: "fieldGap", factor: 0.3, dir: "down" }
];
const cdOf = (s) => ({ componentDensity: { [s.family]: { [s.dim]: s.factor } } });
const num = (v) => { const m = String(v == null ? "" : v).match(/-?\d*\.?\d+/); return m ? parseFloat(m[0]) : null; };

// Build a getComputedStyle reader for the union of representative selectors + the marker/style state.
const REP_SELS = (() => { const out = {}; for (const f in REP) { for (const d in REP[f]) { out[f + "." + d] = REP[f][d]; } } return out; })();
const READ = `(()=>{
  const px=(v)=>{const m=String(v==null?'':v).match(/-?\\d*\\.?\\d+/);return m?+m[0]:null;};
  const reps=${JSON.stringify(REP_SELS)};
  const out={};
  for(const k in reps){ const r=reps[k]; let el=null; try{el=document.querySelector(r.sel);}catch(e){}
    if(!el){ out[k]=null; continue; } const s=getComputedStyle(el);
    out[k]={height:px(s.height), fontSize:px(s.fontSize), paddingTop:px(s.paddingTop), paddingLeft:px(s.paddingLeft), marginBottom:px(s.marginBottom)}; }
  const styleEl=document.getElementById('kinetic-padding-control');
  let marker=null; try{marker=JSON.parse(document.documentElement.dataset.kineticPaddingControl||'null');}catch(e){}
  return { reps:out, styleElPresent:!!styleEl, probePresent:!!document.getElementById('kinetic-padding-probe'), marker, title:document.title, href:location.href };
})()`;

// Inject the engine's buildCss under a DISTINCT probe id so it never collides with a running content
// script's #kinetic-padding-control (whose reassert would race to remove it). Same CSS bytes.
function injectExpr(css) {
  return `(()=>{ var id='kinetic-padding-probe'; var el=document.getElementById(id);
    if(!el){ el=document.createElement('style'); el.id=id; el.setAttribute('data-kinetic-grid-fix','padding-probe'); }
    var head=document.head||document.getElementsByTagName('head')[0]||document.documentElement; head.appendChild(el);
    el.textContent=${JSON.stringify(css)}; return { applied:true, len:el.textContent.length }; })()`;
}
const REMOVE_EXPR = `(()=>{ var el=document.getElementById('kinetic-padding-probe'); if(el&&el.parentNode){ el.parentNode.removeChild(el); return {removed:true}; } return {removed:false}; })()`;

async function connect(target) { const c = new CdpClient(target); await c.connect(); return c; }
async function screenshot(client, label) {
  if (!TAKE_SHOTS) return null;
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    await client.send("Page.enable").catch(() => {});
    const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(SHOT_DIR, `${label}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return path.relative(ROOT, file);
  } catch (e) { return null; }
}

// Did the representative metric move the right way? Returns {moved, before, after, skipped}.
function moved(state, baseline, after) {
  const key = state.family + "." + state.dim;
  const metric = REP[state.family][state.dim].metric;
  const b = baseline.reps[key]; const a = after.reps[key];
  if (!b || !a || b[metric] == null || a[metric] == null) return { skipped: true };
  const before = b[metric]; const now = a[metric];
  const ok = state.dir === "up" ? now > before + 0.5 : now < before - 0.5;
  return { moved: ok, before, after: now };
}

// =====================================================================================================
// MECHANISM: inject engine css -> measure rep -> assert moved -> remove -> assert exact revert.
// =====================================================================================================
async function runMechanism(client, state, baseline, shots) {
  const css = ENGINE.buildCss(cdOf(state));
  const result = { name: state.name, ruleCount: ENGINE.ruleCount(cdOf(state)), checks: [], pass: true };

  await client.evaluate(injectExpr(css));
  await sleep(70);
  const applied = await client.evaluate(READ);

  const mv = moved(state, baseline, applied);
  if (mv.skipped) {
    result.skipped = true;
    result.checks.push({ label: `rep element absent in this view (${REP[state.family][state.dim].sel}) — token CSS still emitted`, ok: true });
  } else {
    result.checks.push({ label: `rep ${state.family}.${state.dim} moves ${state.dir} (${mv.before} -> ${mv.after})`, ok: mv.moved });
    if (!mv.moved) result.pass = false;
  }
  if (shots) result.shot = await screenshot(client, `edu-${state.name}`);

  await client.evaluate(REMOVE_EXPR);
  await sleep(70);
  const reverted = await client.evaluate(READ);
  const key = state.family + "." + state.dim; const metric = REP[state.family][state.dim].metric;
  let revOk = !reverted.probePresent;
  if (!mv.skipped && baseline.reps[key] && reverted.reps[key]) {
    revOk = revOk && Math.abs(num(baseline.reps[key][metric]) - num(reverted.reps[key][metric])) < 0.5;
  }
  result.checks.push({ label: "exact revert to baseline (rep restored + probe removed)", ok: revOk });
  if (!revOk) result.pass = false;
  return result;
}

// =====================================================================================================
// Extension discovery + Unpacked Extension Reload (chrome.developerPrivate).
// =====================================================================================================
async function browserCdp() {
  const ver = await readJson(`${BROWSER}/json/version`);
  const c = new CdpClient({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl });
  await c.connect();
  return c;
}
async function withExtensionsTab(bc, fn) {
  const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" });
  await sleep(1000);
  try {
    const list = await readJson(`${BROWSER}/json/list`);
    const t = list.find((x) => x.id === targetId);
    if (!t) throw new Error("could not open chrome://extensions");
    const pc = new CdpClient(t); await pc.connect();
    const out = await fn(pc);
    pc.close();
    return out;
  } finally {
    await bc.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}
async function findExtension(pc) {
  const items = await pc.evaluate(`(async()=>{ const a=await new Promise(r=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},r));
    return a.map(i=>({id:i.id,name:i.name,version:i.version})); })()`);
  if (!Array.isArray(items)) return null;
  return items.find((i) => i.id === EXT_ID) || items.find((i) => /Kinetic Grid/i.test(i.name) || /Kinetic UI Fixes/i.test(i.name)) || null;
}
async function reloadExtension(pc, extId) {
  return pc.evaluate(`(async()=>{ try{ await new Promise((res,rej)=>chrome.developerPrivate.reload(${JSON.stringify(extId)},{failQuietly:false},()=>{ var e=chrome.runtime.lastError; e?rej(new Error(e.message)):res(); })); return {reloaded:true}; }catch(e){ return {reloaded:false,err:String(e)}; } })()`);
}
async function openExtPage(bc, extId, sub) {
  const url = `chrome-extension://${extId}/${sub}`;
  const { targetId } = await bc.send("Target.createTarget", { url });
  await sleep(700);
  const list = await readJson(`${BROWSER}/json/list`);
  const t = list.find((x) => x.id === targetId);
  if (!t) throw new Error("could not open extension page " + url);
  const c = new CdpClient(t); await c.connect();
  return { client: c, targetId };
}
async function setDensityVia(drv, componentDensity) {
  const lit = JSON.stringify({ componentDensity });
  return drv.evaluate(`(async()=>{ await new Promise(r=>chrome.storage.local.set(${lit}, r)); return true; })()`);
}
async function reloadEducationAndWait(eduTarget) {
  let c = new CdpClient(eduTarget); await c.connect();
  await c.send("Page.enable").catch(() => {});
  await c.send("Page.reload", {});
  c.close();
  // Wait for the marker (content script @ document_start) AND for the Angular app to actually paint
  // its Kendo chrome (a .k-button exists) — the marker lands long before the SPA renders the view.
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    try {
      c = new CdpClient(eduTarget); await c.connect();
      const s = await c.evaluate(READ);
      const rendered = await c.evaluate(`(()=>{try{return document.querySelectorAll('.k-button').length;}catch(e){return 0;}})()`);
      if (s.marker !== undefined && rendered > 0) return { client: c, settledMarker: s.marker };
      c.close();
    } catch (e) { /* still reloading */ }
  }
  c = new CdpClient(eduTarget); await c.connect();
  return { client: c, settledMarker: (await c.evaluate(READ)).marker };
}

// =====================================================================================================
// Main
// =====================================================================================================
async function main() {
  const pages = await listPageTargets(BROWSER);
  const edu = pages.find((p) => /SaaS950/i.test(p.url) || /centralusdtedu00\.epicorsaas/i.test(p.url));
  if (!edu) { console.error("FATAL: no Education (SaaS950) tab on port " + PORT); process.exit(2); }

  const report = { engineVersion: ENGINE.version, families: ENGINE.FAMILIES.map((f) => f.key), port: Number(PORT),
    mechanism: [], e2e: null, reload: null, overallPass: true };

  // ---- Unpacked Extension Reload ----
  let extId = null;
  if (E2E || RELOAD_ONLY) {
    const bc = await browserCdp();
    try {
      const ext = await withExtensionsTab(bc, async (pc) => {
        const found = await findExtension(pc);
        if (!found) return { err: "extension not found (Load unpacked apps/kinetic-grid-fix-extension/)" };
        const r = await reloadExtension(pc, found.id);
        await sleep(800);
        const after = await findExtension(pc);
        return { before: found, reload: r, after };
      });
      report.reload = ext;
      if (ext && ext.after) { extId = ext.after.id; }
      console.log("Reloaded unpacked extension:", ext && ext.before ? `${ext.before.version} -> ${ext.after.version}` : JSON.stringify(ext));
    } finally { bc.close(); }
    if (RELOAD_ONLY) { console.log(JSON.stringify(report.reload, null, 2)); process.exit(report.reload && report.reload.after ? 0 : 1); }
  }

  // ---- MECHANISM proof (skipped under --e2e: the loaded content script owns the real <style>; the e2e
  //      path is the rigorous proof there). ----
  if (!E2E) {
    const eduClient = await connect(edu);
    try {
      const baseline = await eduClient.evaluate(READ);
      report.baselineTitle = baseline.title;
      if (TAKE_SHOTS) report.baselineShot = await screenshot(eduClient, "edu-baseline");
      for (const st of STATES) {
        const r = await runMechanism(eduClient, st, baseline, TAKE_SHOTS);
        report.mechanism.push(r);
        if (!r.pass) report.overallPass = false;
      }
      const fin = await eduClient.evaluate(READ);
      report.mechanismCleanExit = !fin.probePresent;
      if (!report.mechanismCleanExit) report.overallPass = false;
    } finally { eduClient.close(); }
  }

  // ---- END-TO-END through the reloaded extension ----
  if (E2E) {
    const bc = await browserCdp();
    let driver = null;
    try {
      if (!extId) { report.e2e = { ran: false, reason: "extension id not resolved" }; }
      else {
        const { client: eduC, settledMarker } = await reloadEducationAndWait(edu);
        const e2e = { ran: true, contentScriptPresent: !!(settledMarker && settledMarker.version), settledMarker, modes: [] };
        driver = await openExtPage(bc, extId, "popup/popup.html");
        await setDensityVia(driver.client, {});
        await sleep(500);
        const base = await eduC.evaluate(READ);
        for (const st of STATES) {
          await setDensityVia(driver.client, cdOf(st).componentDensity);
          await sleep(1400); // content-script debounce (~90ms) + storage roundtrip + apply + settle
          const s = await eduC.evaluate(READ);
          const mv = moved(st, base, s);
          const activeOk = !!(s.marker && s.marker.active === true && Array.isArray(s.marker.adjustments) && s.marker.adjustments.length >= 1);
          const pass = activeOk && (mv.skipped || mv.moved);
          e2e.modes.push({ name: st.name, pass, skipped: !!mv.skipped, marker: s.marker, move: mv });
          if (TAKE_SHOTS) await screenshot(eduC, `edu-e2e-${st.name}`);
          if (!pass) report.overallPass = false;
        }
        // OFF -> exact revert
        await setDensityVia(driver.client, {});
        await sleep(1400);
        const off = await eduC.evaluate(READ);
        const offOk = !off.styleElPresent && !!(off.marker && off.marker.active === false);
        e2e.offRevert = { pass: offOk, styleElPresent: off.styleElPresent, markerActive: off.marker ? off.marker.active : null };
        if (!offOk) report.overallPass = false;
        report.e2e = e2e;
        eduC.close();
      }
    } finally {
      if (driver) { try { await setDensityVia(driver.client, {}); } catch (e) {} try { driver.client.close(); } catch (e) {} try { await bc.send("Target.closeTarget", { targetId: driver.targetId }); } catch (e) {} }
      bc.close();
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "padding-verification.json"), JSON.stringify(report, null, 2) + "\n");

  console.log("\n========== PADDING-CONTROL LIVE VERIFICATION (per-family v" + report.engineVersion + ") ==========");
  console.log("families:", report.families.join(", "), "| view:", report.baselineTitle || "(e2e)");
  if (report.mechanism.length) {
    console.log("\nMechanism (engine CSS injected via CDP under a distinct probe id):");
    for (const m of report.mechanism) {
      const tag = m.skipped ? "SKIP" : (m.pass ? "PASS" : "FAIL");
      console.log(`  [${tag}] ${m.name} (${m.ruleCount} rules)`);
      for (const c of m.checks) console.log(`        ${c.ok ? "ok " : "XX "} ${c.label}`);
    }
    console.log(`  [${report.mechanismCleanExit ? "PASS" : "FAIL"}] clean exit (no probe left behind)`);
  }
  if (report.reload) console.log("\nUnpacked reload:", JSON.stringify(report.reload.before && report.reload.after ? { from: report.reload.before.version, to: report.reload.after.version } : report.reload));
  if (report.e2e) {
    if (report.e2e.ran) {
      console.log("\nEnd-to-end via reloaded extension (content script present:", report.e2e.contentScriptPresent, "):");
      for (const m of report.e2e.modes) console.log(`  [${m.skipped ? "SKIP" : (m.pass ? "PASS" : "FAIL")}] ${m.name} (marker active=${m.marker ? m.marker.active : null}, adj=${m.marker && m.marker.adjustments ? m.marker.adjustments.length : 0})`);
      console.log(`  [${report.e2e.offRevert && report.e2e.offRevert.pass ? "PASS" : "FAIL"}] OFF -> exact revert (no style, marker active:false)`);
    } else { console.log("\nEnd-to-end: SKIPPED — " + report.e2e.reason); }
  }
  console.log("\nOVERALL:", report.overallPass ? "PASS ✅" : "FAIL ❌");
  console.log("Artifact:", path.relative(ROOT, path.join(OUT_DIR, "padding-verification.json")));
  console.log("=======================================================\n");
  process.exit(report.overallPass ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e && e.stack ? e.stack : e); process.exit(2); });
