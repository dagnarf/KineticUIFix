// neutral-merge-live-harness.mjs — Live CDP-9100 verification that the Surface/neutral tint now rides the
// SAME "Override colors" toggle (no separate switch) and is cleared by "Reset all to stock".
//
// WHY THIS HARNESS (vs theme-live-harness.mjs): the engine (src/theme-control.js) is unchanged by this
// merge — only the POPUP wiring changed (popup/popup.{html,js}). So this drives the REAL popup page over
// CDP (a fresh chrome-extension://<id>/popup/popup.html target, read from disk → exercises the edited
// popup.js without an extension reload), clicks the actual controls, and asserts the resulting
// chrome.storage writes flow through the ISOLATED content script to the live themed Education tab.
//
// WHAT IT PROVES:
//   STRUCTURE — popup has NO #toggle-neutral-tint; #clr-neutral lives INSIDE #color-panel; #clr-reset-all present.
//   BEHAVIOR  —
//     1. Override OFF (baseline)  : #color-panel hidden; Education neutral tokens == baseline; marker inert.
//     2. Click "Override colors"  : storage {colorOverrideEnabled:true, neutralTintEnabled:true}; panel + neutral
//                                   row visible; tint still INERT (no hex picked) → Education neutral unchanged.
//     3. Pick a neutral color     : storage.neutralTintHex set; Education marker.neutralTint=true,
//                                   neutralTokensPinned=7, active=true; the 7 --neutral-* tokens tint live.
//     4. "Reset all to stock"     : storage.neutralTintHex cleared + colorOverrideValues={}; Education neutral
//                                   tokens exact-revert to baseline; marker.neutralTint=false.
//     5. Click "Override colors"  : storage {colorOverrideEnabled:false, neutralTintEnabled:false}; panel hidden;
//        again (OFF)                Education fully inert (no <style>, marker active:false).
//
// SAFETY (§6): read-only Epicor. Only mutates THIS extension's chrome.storage.local; always restores
//   default-OFF and closes the scratch popup tab; leaves Education exactly as found. No secrets logged.
//
// USAGE:  node verify/neutral-merge-live-harness.mjs [--port 9100] [--no-shots]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { CdpClient, listPageTargets, readJson } from "./cdp-lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = argVal("--port") || process.env.PORT || "9100";
const BROWSER = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(ROOT, ".output", "chrome-plugin-grid-fix");
const SHOT_DIR = path.join(ROOT, ".tmp", "neutral-merge-live");
const TAKE_SHOTS = !process.argv.includes("--no-shots");
const TEST_HEX = "#1a73e8"; // vivid blue: deriveNeutral -> hsl(214,82%,L) per token; clearly != gray baseline

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();

// Poll an async producer until its result satisfies `ok`, or timeout — defeats the popup-debounce(120ms)
// + content-script-debounce(90ms) + apply settle race that a fixed sleep would lose to intermittently.
async function pollUntil(producer, ok, { timeoutMs = 4000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await producer();
  while (!ok(last) && Date.now() < deadline) { await sleep(stepMs); last = await producer(); }
  return last;
}

// ---- Load the real engine for expected neutral-token math + token names (no hand-copied numbers) ----
function loadEngine() {
  const src = readFileSync(path.join(ROOT, "src", "theme-control.js"), "utf8");
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "theme-control.js" });
  return sandbox.self.__KINETIC_THEME_CONTROL___MODULE;
}
const ENGINE = loadEngine();
const NEUTRAL_NAMES = ENGINE.NEUTRAL_TOKENS.map((t) => t.base);
const EXPECTED_TINT = ENGINE.deriveNeutral(TEST_HEX); // { "--neutral": "hsl(214,82%,100%)", ... }

// ---- Education page probes ------------------------------------------------------------------------
const READ_EDU = `(()=>{
  const cs=getComputedStyle(document.documentElement);
  const neutral={};
  ${JSON.stringify(NEUTRAL_NAMES)}.forEach(t=>{ neutral[t]=cs.getPropertyValue(t).trim(); });
  const styleEl=document.getElementById('kinetic-theme-control');
  let marker=null; try{ marker=JSON.parse(document.documentElement.dataset.kineticThemeControl||'null'); }catch(e){ marker=null; }
  return { neutral, styleElPresent:!!styleEl, marker, href:location.href };
})()`;

function neutralEqual(a, b) {
  const diffs = [];
  for (const k of NEUTRAL_NAMES) if (norm(a[k]) !== norm(b[k])) diffs.push({ token: k, a: a[k], b: b[k] });
  return diffs;
}
function neutralMatchesExpected(measured) {
  const diffs = [];
  for (const k of NEUTRAL_NAMES) if (norm(measured[k]) !== norm(EXPECTED_TINT[k])) diffs.push({ token: k, expected: EXPECTED_TINT[k], got: measured[k] });
  return diffs;
}

// ---- Popup driver (runs IN the popup page; dispatches the real listeners popup.js binds) ----------
// Structure probe: the merge invariants, checked against the live DOM the popup actually rendered.
const POPUP_STRUCTURE = `(()=>{
  const panel=document.getElementById('color-panel');
  const neutral=document.getElementById('clr-neutral');
  const neutralInPanel=!!(panel&&neutral&&panel.contains(neutral));
  return {
    hasOldNeutralToggle: !!document.getElementById('toggle-neutral-tint'),
    hasOldNeutralState: !!document.getElementById('toggle-neutral-tint-state'),
    hasOverrideToggle: !!document.getElementById('toggle-color-override'),
    hasColorPanel: !!panel,
    hasNeutralSwatch: !!neutral,
    neutralInsideColorPanel: neutralInPanel,
    hasResetAll: !!document.getElementById('clr-reset-all'),
    hasNeutralReset: !!document.getElementById('neutral-reset')
  };
})()`;

// Popup visibility snapshot (is the panel / neutral row actually shown to the user?).
const POPUP_VISIBLE = `(()=>{
  const panel=document.getElementById('color-panel');
  const neutralRow=(()=>{ const s=document.getElementById('clr-neutral'); return s?s.closest('.clr-row'):null; })();
  const vis=(el)=>!!(el&&!el.hidden&&el.offsetParent!==null);
  return { panelHidden: panel?panel.hidden:null, panelVisible: vis(panel), neutralRowVisible: vis(neutralRow) };
})()`;

const clickExpr = (id) => `(()=>{ const el=document.getElementById(${JSON.stringify(id)}); if(!el) return {ok:false,err:'no '+${JSON.stringify(id)}}; el.click(); return {ok:true}; })()`;
const pickNeutralExpr = (hex) => `(()=>{
  const el=document.getElementById('clr-neutral'); if(!el) return {ok:false,err:'no swatch'};
  el.value=${JSON.stringify(hex)};
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return {ok:true,value:el.value};
})()`;
// Read this extension's storage from inside the popup (it has chrome.storage access).
const READ_STORAGE = `(async()=>{ return await new Promise(r=>chrome.storage.local.get({colorOverrideEnabled:false,neutralTintEnabled:false,neutralTintHex:'',colorOverrideValues:{}}, r)); })()`;
const setStorageExpr = (obj) => `(async()=>{ await new Promise(r=>chrome.storage.local.set(${JSON.stringify(obj)}, r)); return true; })()`;

async function browserCdp() {
  const ver = await readJson(`${BROWSER}/json/version`);
  const c = new CdpClient({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl });
  await c.connect();
  return c;
}
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

const extIdOf = (url) => (/^chrome-extension:\/\/([a-p]{32})\//.exec(url || "") || [])[1] || null;

// Authoritative resolver: enumerate installed extensions by NAME via a chrome://extensions scratch tab +
// developerPrivate (works even when our extension has zero open targets / a dormant service worker).
async function discoverViaExtensionsPage(bc) {
  const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" });
  await sleep(1000);
  let id = null;
  try {
    const list = await readJson(`${BROWSER}/json/list`);
    const t = list.find((x) => x.id === targetId);
    if (t) {
      const pc = new CdpClient(t); await pc.connect();
      const items = await pc.evaluate(`(async()=>{ try{ const a=await new Promise(r=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},r)); return a.map(i=>({id:i.id,name:i.name,state:i.state})); }catch(e){ return {err:String(e)}; } })()`);
      if (Array.isArray(items)) {
        const m = items.find((i) => (/Kinetic Grid/i.test(i.name) || /Kinetic UI Fixes/i.test(i.name)) && i.state === "ENABLED")
          || items.find((i) => /Kinetic Grid/i.test(i.name) || /Kinetic UI Fixes/i.test(i.name));
        if (m) id = m.id;
      }
      pc.close();
    }
  } finally { await bc.send("Target.closeTarget", { targetId }).catch(() => {}); }
  return id;
}

// Confirm an extension id is OURS by opening its popup and looking for our merged control. Returns the id
// (and closes the scratch popup) on a hit, else null. Avoids ever binding to an unrelated extension.
async function confirmOurExtId(bc, id) {
  let targetId = null;
  try {
    ({ targetId } = await bc.send("Target.createTarget", { url: `chrome-extension://${id}/popup/popup.html` }));
    await sleep(450);
    const list = await readJson(`${BROWSER}/json/list`);
    const t = list.find((x) => x.id === targetId);
    if (!t) return null;
    const c = new CdpClient(t); await c.connect();
    const ok = await c.evaluate(`!!document.getElementById('toggle-color-override')`).catch(() => false);
    c.close();
    return ok ? id : null;
  } catch (e) { return null; } finally {
    if (targetId) { try { await bc.send("Target.closeTarget", { targetId }); } catch (e) { /* ignore */ } }
  }
}

async function main() {
  const targets = await readJson(`${BROWSER}/json/list`);
  const pages = await listPageTargets(BROWSER);
  const edu = pages.find((p) => /SaaS950/i.test(p.url) || /centralusdtedu00\.epicorsaas/i.test(p.url));
  if (!edu) { console.error("FATAL: no Education (SaaS950) tab on port " + PORT); process.exit(2); }

  const bc = await browserCdp();

  // Resolve OUR extension id robustly: first an already-open popup whose DOM has our merged override control,
  // else open each candidate extension's popup and confirm — never bind to an unrelated extension (offscreen/SW).
  let extId = null;
  const popupTargets = targets.filter((t) => /popup\/popup\.html$/.test(t.url || ""));
  for (const t of popupTargets) {
    try {
      const c = await connect(t);
      const ok = await c.evaluate(`!!document.getElementById('toggle-color-override')`).catch(() => false);
      c.close();
      if (ok) { extId = extIdOf(t.url); break; }
    } catch (e) { /* skip */ }
  }
  if (!extId) { extId = await discoverViaExtensionsPage(bc); }
  if (!extId) {
    const candidates = [...new Set(targets.map((t) => extIdOf(t.url)).filter(Boolean))];
    for (const id of candidates) { if (await confirmOurExtId(bc, id)) { extId = id; break; } }
  }
  if (!extId) { console.error("FATAL: could not resolve the extension id (is the unpacked extension loaded?)"); bc.close(); process.exit(3); }

  const report = { port: Number(PORT), engineVersion: ENGINE.version, extId, testHex: TEST_HEX, education: { url: edu.url }, steps: [], overallPass: true };
  const fail = (cond) => { if (!cond) report.overallPass = false; return cond; };

  const eduClient = await connect(edu);

  // Close any stale popup tabs (opened before this edit) so only our fresh popup drives storage.
  for (const t of popupTargets) { try { await bc.send("Target.closeTarget", { targetId: t.id }); } catch (e) { /* ignore */ } }
  await sleep(200);

  // Open a FRESH popup page so popup.js is re-read from disk (exercises the edited code, no ext reload).
  const { targetId: popupTargetId } = await bc.send("Target.createTarget", { url: `chrome-extension://${extId}/popup/popup.html` });
  await sleep(900);
  const list2 = await readJson(`${BROWSER}/json/list`);
  const popupTarget = list2.find((x) => x.id === popupTargetId);
  if (!popupTarget) { console.error("FATAL: could not open scratch popup page"); bc.close(); eduClient.close(); process.exit(4); }
  const popup = await connect(popupTarget);

  const readEdu = () => eduClient.evaluate(READ_EDU);
  const readStg = () => popup.evaluate(READ_STORAGE);

  try {
    // Ensure a clean themed baseline: force all theme keys OFF, then POLL until the content script settles inert.
    await popup.evaluate(setStorageExpr({ themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {}, neutralTintEnabled: false, neutralTintHex: "" }));
    const baseline = await pollUntil(readEdu, (s) => s.marker && s.marker.active === false && !s.styleElPresent);
    report.baselineShot = await screenshot(eduClient, "education-neutral-baseline");

    // --- STEP 0: popup structure invariants (the merge) -------------------------------------------
    const struct = await popup.evaluate(POPUP_STRUCTURE);
    report.structure = struct;
    const structPass =
      struct.hasOldNeutralToggle === false &&
      struct.hasOldNeutralState === false &&
      struct.hasOverrideToggle === true &&
      struct.hasColorPanel === true &&
      struct.hasNeutralSwatch === true &&
      struct.neutralInsideColorPanel === true &&
      struct.hasResetAll === true;
    report.steps.push({ name: "structure: neutral folded into the override panel, no standalone toggle", pass: fail(structPass), detail: struct });

    // --- STEP 1: baseline — override OFF -----------------------------------------------------------
    const vis0 = await popup.evaluate(POPUP_VISIBLE);
    const s1pass = vis0.panelVisible === false && (!baseline.marker || baseline.marker.active === false) && !baseline.styleElPresent;
    report.steps.push({ name: "override OFF: panel hidden, Education inert", pass: fail(s1pass), detail: { vis0, markerActive: baseline.marker ? baseline.marker.active : null } });

    // --- STEP 2: click "Override colors" — neutral rides it; still inert (no hex) ------------------
    await popup.evaluate(clickExpr("toggle-color-override"), { userGesture: true });
    const stg2 = await pollUntil(readStg, (s) => s.colorOverrideEnabled === true);
    await pollUntil(readEdu, (s) => s.marker && s.marker.colorOverride === true);
    const vis2 = await popup.evaluate(POPUP_VISIBLE);
    const edu2 = await eduClient.evaluate(READ_EDU);
    const s2pass =
      stg2.colorOverrideEnabled === true && stg2.neutralTintEnabled === true &&
      vis2.panelVisible === true && vis2.neutralRowVisible === true &&
      (edu2.marker && edu2.marker.colorOverride === true && edu2.marker.neutralTint === false) &&
      neutralEqual(baseline.neutral, edu2.neutral).length === 0; // inert until a hex is picked
    report.steps.push({ name: "override ON: storage both-true, panel+neutral visible, tint inert (no hex)", pass: fail(s2pass), detail: { storage: stg2, vis2, marker: edu2.marker, neutralUnchanged: neutralEqual(baseline.neutral, edu2.neutral) } });

    // --- STEP 3: pick a neutral color — 7 tokens tint live ----------------------------------------
    await popup.evaluate(pickNeutralExpr(TEST_HEX), { userGesture: true });
    const stg3 = await pollUntil(readStg, (s) => norm(s.neutralTintHex) === norm(TEST_HEX));
    const edu3 = await pollUntil(readEdu, (s) => s.marker && s.marker.neutralTint === true && s.marker.neutralTokensPinned === 7);
    report.tintShot = await screenshot(eduClient, "education-neutral-tinted");
    const tintDiffs = neutralMatchesExpected(edu3.neutral);
    const changedFromBaseline = neutralEqual(baseline.neutral, edu3.neutral).length > 0;
    const s3pass =
      norm(stg3.neutralTintHex) === norm(TEST_HEX) &&
      (edu3.marker && edu3.marker.neutralTint === true && edu3.marker.neutralTokensPinned === 7 && edu3.marker.active === true) &&
      tintDiffs.length === 0 && changedFromBaseline;
    report.steps.push({ name: "pick neutral: storage hex set, 7 --neutral-* tokens == deriveNeutral, marker neutralTint+active", pass: fail(s3pass), detail: { hex: stg3.neutralTintHex, marker: edu3.marker, tintMismatches: tintDiffs.slice(0, 7), changedFromBaseline } });

    // --- STEP 4: "Reset all to stock" — clears neutral too -----------------------------------------
    await popup.evaluate(clickExpr("clr-reset-all"), { userGesture: true });
    const stg4 = await pollUntil(readStg, (s) => s.neutralTintHex === "");
    const edu4 = await pollUntil(readEdu, (s) => s.marker && s.marker.neutralTint === false);
    const revDiffs = neutralEqual(baseline.neutral, edu4.neutral);
    const s4pass =
      stg4.neutralTintHex === "" && Object.keys(stg4.colorOverrideValues || {}).length === 0 &&
      (edu4.marker && edu4.marker.neutralTint === false) &&
      revDiffs.length === 0;
    report.steps.push({ name: "Reset all to stock: neutral hex cleared + values empty, neutral tokens exact-revert", pass: fail(s4pass), detail: { storage: stg4, marker: edu4.marker, revertMismatches: revDiffs.slice(0, 7) } });

    // --- STEP 5: click "Override colors" again (OFF) — both flags false, fully inert ---------------
    await popup.evaluate(clickExpr("toggle-color-override"), { userGesture: true });
    const stg5 = await pollUntil(readStg, (s) => s.colorOverrideEnabled === false);
    await pollUntil(readEdu, (s) => !s.styleElPresent && (s.marker ? s.marker.active === false : true));
    const vis5 = await popup.evaluate(POPUP_VISIBLE);
    const edu5 = await eduClient.evaluate(READ_EDU);
    const s5pass =
      stg5.colorOverrideEnabled === false && stg5.neutralTintEnabled === false &&
      vis5.panelVisible === false &&
      !edu5.styleElPresent && (edu5.marker ? edu5.marker.active === false : true);
    report.steps.push({ name: "override OFF again: both flags false, panel hidden, Education fully inert", pass: fail(s5pass), detail: { storage: stg5, vis5, styleElPresent: edu5.styleElPresent, markerActive: edu5.marker ? edu5.marker.active : null } });
    report.revertShot = await screenshot(eduClient, "education-neutral-reverted");
  } catch (e) {
    report.error = String(e && e.stack ? e.stack : e);
    report.overallPass = false;
  } finally {
    // Restore default-OFF and close the scratch popup; leave Education as found.
    try { await popup.evaluate(setStorageExpr({ themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {}, neutralTintEnabled: false, neutralTintHex: "" })); } catch (e) { /* ignore */ }
    await sleep(300);
    try { const fin = await eduClient.evaluate(READ_EDU); report.education.cleanExit = !fin.styleElPresent && (fin.marker ? fin.marker.active === false : true); } catch (e) { /* ignore */ }
    try { popup.close(); } catch (e) { /* ignore */ }
    try { await bc.send("Target.closeTarget", { targetId: popupTargetId }); } catch (e) { /* ignore */ }
    try { eduClient.close(); } catch (e) { /* ignore */ }
    bc.close();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "neutral-merge-verification.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(path.join(OUT_DIR, "neutral-merge-verification.md"), renderMd(report));

  console.log("\n========== NEUTRAL-TINT MERGE — LIVE (real popup → storage → Education) ==========");
  console.log("Extension id:", report.extId, "| engine v" + report.engineVersion, "| test hex", report.testHex);
  for (const s of report.steps) console.log(`  [${s.pass ? "PASS" : "FAIL"}] ${s.name}` + (s.pass ? "" : "\n        -> " + JSON.stringify(s.detail)));
  console.log("  clean exit (Education inert, restored):", report.education.cleanExit);
  if (report.error) console.log("  ERROR:", report.error);
  console.log("\nOVERALL:", report.overallPass ? "PASS ✅" : "FAIL ❌");
  console.log("Artifacts:", path.relative(ROOT, path.join(OUT_DIR, "neutral-merge-verification.json")), "+ .md", "| shots:", path.relative(ROOT, SHOT_DIR));
  console.log("==================================================================================\n");
  process.exit(report.overallPass ? 0 : 1);
}

function renderMd(r) {
  const lines = [];
  lines.push("# Surface/neutral-tint merge — live verification (real popup → storage → Education)");
  lines.push("");
  lines.push("Proves the Surface/neutral tint now rides the **Override colors** toggle (no standalone switch) and");
  lines.push("is cleared by **Reset all to stock**, by driving the *actual* popup page over CDP-9100 and watching the");
  lines.push("ISOLATED content script tint the themed **Education (SaaS950)** tab live.");
  lines.push("");
  lines.push(`- **Overall:** ${r.overallPass ? "PASS ✅" : "FAIL ❌"}`);
  lines.push(`- Engine \`src/theme-control.js\` v${r.engineVersion} (unchanged) · popup \`popup/popup.{html,js}\` (merged) · test hex \`${r.testHex}\``);
  lines.push(`- Extension id \`${r.extId}\`; Education \`${r.education.url}\``);
  lines.push("");
  if (r.structure) {
    lines.push("## Structure (the merge)");
    lines.push("");
    lines.push(`- standalone \`#toggle-neutral-tint\` removed: **${r.structure.hasOldNeutralToggle === false ? "yes ✅" : "no ❌"}**`);
    lines.push(`- \`#clr-neutral\` inside \`#color-panel\`: **${r.structure.neutralInsideColorPanel ? "yes ✅" : "no ❌"}**`);
    lines.push(`- \`#clr-reset-all\` present: **${r.structure.hasResetAll ? "yes ✅" : "no ❌"}**`);
    lines.push("");
  }
  lines.push("## Behavior (driven via real clicks on the popup)");
  lines.push("");
  lines.push("| Step | Result |");
  lines.push("|---|---|");
  for (const s of r.steps) lines.push(`| ${s.name} | ${s.pass ? "PASS ✅" : "FAIL ❌"} |`);
  lines.push(`| clean exit — Education restored (no \`<style>\`, marker inert), storage default-OFF | ${r.education.cleanExit ? "PASS ✅" : "FAIL ❌"} |`);
  lines.push("");
  lines.push("Screenshots in `.tmp/neutral-merge-live/`: `education-neutral-baseline` → `-tinted` → `-reverted`.");
  lines.push("");
  lines.push("Reproduce: `node verify/neutral-merge-live-harness.mjs --port 9100` (re-resolves page ids each run).");
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => { console.error("FATAL", e && e.stack ? e.stack : e); process.exit(2); });
