// theme-live-harness.mjs — Live CDP-9100 verification of the theme-control feature
// (kinetic-theme-control-extension, Track D · T_D_05 + T_D_06). Reuses cdp-lib.mjs (no forked CDP client).
//
// WHAT IT PROVES (§3.3 override-and-revert invariant, on the LIVE themed Education tab):
//   1. DISABLE  -> every one of the 27 :root tokens becomes its §4.2 STOCK value (and so the themed
//                  tenant renders like the un-themed Third tenant). Removing the rule reverts EXACTLY.
//   2. OVERRIDE -> the chosen family's tokens become the §4.2-derived value; other tokens are untouched.
//   3. BOTH     -> stock everywhere, user color where chosen (later-wins source order, §4.3).
//   4. OFF      -> buildCss('') injects nothing; the page equals its native baseline (marker active:false).
//   5. Third cross-check: the un-themed tenant's live tokens already equal §4.2 stock.
//
// FIDELITY: the CSS injected here is produced by the extension's OWN engine (src/theme-control.js
//   buildCss / stockBlock / deriveFamily) — the exact bytes the ISOLATED content script's ensureStyle()
//   appends. The extension need not be installed for this mechanism proof. If the real content script IS
//   detected on the page (dataset marker present), the harness ALSO drives it end-to-end via the
//   extension service worker's chrome.storage.local and asserts the same invariants through the real path.
//
// SAFETY (§6): read-only Epicor; every DOM mutation is inject-measure-REMOVE and the run asserts the page
//   returns to its exact pre-run token set (revertedOk). Never clears cookies. Re-resolves page ids each
//   run via /json/list. No secrets logged.
//
// USAGE:
//   node verify/theme-live-harness.mjs [--port 9100] [--out-dir <dir>] [--no-shots]
//   PORT=9100 node verify/theme-live-harness.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { CdpClient, listPageTargets, readJson } from "./cdp-lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = argVal("--port") || process.env.PORT || "9100";
const BROWSER = `http://127.0.0.1:${PORT}`;
const OUT_DIR = argVal("--out-dir") || path.join(ROOT, ".output", "chrome-plugin-grid-fix");
const TAKE_SHOTS = !process.argv.includes("--no-shots");
const SHOT_DIR = path.join(ROOT, ".tmp", "theme-live");
// --e2e drives the REAL loaded extension (chrome.storage -> content script -> live apply) instead of
// injecting the engine's CSS ourselves. Requires the unpacked extension loaded; reloads the Education tab
// so the document_start content script is present. Writes a separate theme-e2e-verification.{json,md}.
const E2E = process.argv.includes("--e2e");

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// ---------------------------------------------------------------------------------------------------
// Load the REAL engine (the same vm trick the unit suite uses). MODULE exposes buildCss/stockBlock/
// deriveFamily/TOKENS/hslStr/countTokens/validFamilies — the single source of truth for expected values.
// ---------------------------------------------------------------------------------------------------
function loadEngine() {
  const src = readFileSync(path.join(ROOT, "src", "theme-control.js"), "utf8");
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "theme-control.js" });
  return sandbox.self.__KINETIC_THEME_CONTROL___MODULE;
}

const ENGINE = loadEngine();
const TOKEN_NAMES = (() => {
  const names = [];
  for (const fam of ENGINE.TOKENS) {
    names.push(fam.base);
    for (const v of fam.variants) names.push(fam.base + v.suffix);
  }
  return names;
})();

// Expected §4.2 stock value per token, straight from the engine (no hand-copied numbers).
const STOCK_EXPECTED = (() => {
  const map = {};
  for (const fam of ENGINE.TOKENS) {
    map[fam.base] = ENGINE.hslStr(fam.h, fam.s, fam.l);
    for (const v of fam.variants) map[fam.base + v.suffix] = ENGINE.hslStr(fam.h, v.s, v.l);
  }
  return map;
})();

// Strip ALL whitespace so computed "hsl(19, 97%, 81% )" == specified "hsl(19,97%,81%)" (§4.5 note).
const norm = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();

// ---------------------------------------------------------------------------------------------------
// CDP page helpers — read the live token set + visible consumers; inject/remove the real <style>.
// ---------------------------------------------------------------------------------------------------
const READ_STATE = `(()=>{
  const cs=getComputedStyle(document.documentElement);
  const tokens={};
  ${JSON.stringify(TOKEN_NAMES)}.forEach(t=>{ tokens[t]=cs.getPropertyValue(t).trim(); });
  const styleEl=document.getElementById('kinetic-theme-control');
  const tile=document.querySelector('.khp-tile.tile-background')||document.querySelector('.khp-faveColor3 .tile-background')||document.querySelector('.khp-faveColor1 .tile-background');
  const tileBg=tile?getComputedStyle(tile).backgroundColor:null;
  let dataset=null; try{ dataset=JSON.parse(document.documentElement.dataset.kineticThemeControl||'null'); }catch(e){ dataset=null; }
  return { tokens, styleElPresent:!!styleEl, styleElLen: styleEl?(styleEl.textContent||'').length:0,
    tileBg, marker:dataset, title:document.title, href:location.href,
    inlineThemed: (document.documentElement.getAttribute('style')||'').indexOf('--')>=0 };
})()`;

function injectExpr(css) {
  // Mirrors theme-control.js ensureStyle(): one #kinetic-theme-control <style>, last in <head>.
  const lit = JSON.stringify(css);
  return `(()=>{
    var id='kinetic-theme-control';
    var el=document.getElementById(id);
    if(!el){ el=document.createElement('style'); el.id=id; el.setAttribute('data-kinetic-grid-fix','theme-control'); }
    el.textContent=${lit};
    var head=document.head||document.getElementsByTagName('head')[0]||document.documentElement;
    head.appendChild(el);
    return { applied:true, len:(el.textContent||'').length };
  })()`;
}

const REMOVE_EXPR = `(()=>{ var el=document.getElementById('kinetic-theme-control'); if(el&&el.parentNode){ el.parentNode.removeChild(el); return {removed:true}; } return {removed:false}; })()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(target) {
  const c = new CdpClient(target);
  await c.connect();
  return c;
}

async function screenshot(client, label) {
  if (!TAKE_SHOTS) return null;
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    await client.send("Page.enable").catch(() => {});
    const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(SHOT_DIR, `${label}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return path.relative(ROOT, file);
  } catch (e) {
    return null;
  }
}

// Compare a measured token set against an expected map (whitespace-normalized). Returns mismatches.
function diffTokens(measured, expected, onlyKeys) {
  const keys = onlyKeys || Object.keys(expected);
  const mismatches = [];
  for (const k of keys) {
    if (norm(measured[k]) !== norm(expected[k])) {
      mismatches.push({ token: k, expected: expected[k], got: measured[k] });
    }
  }
  return mismatches;
}

// Visible-consumer check: a themed home-card tile (.khp-tile.tile-background, driven by --primary)
// must change color when the theme is neutralized. Passes (no mismatch) when no tile is on screen so
// the run does not fail on a view without home cards — the computed-token + screenshot proofs stand.
function visibleConsumerChanged(baseline, applied) {
  if (!baseline.tileBg || !applied.tileBg) return [];
  if (norm(baseline.tileBg) === norm(applied.tileBg)) {
    return [{ token: "tileBg", expected: "!= " + baseline.tileBg, got: applied.tileBg }];
  }
  return [];
}

// All 27 tokens equal between two measured sets (used for the exact-revert invariant).
function tokensEqual(a, b) {
  const mismatches = [];
  for (const k of TOKEN_NAMES) {
    if (norm(a[k]) !== norm(b[k])) mismatches.push({ token: k, before: a[k], after: b[k] });
  }
  return mismatches;
}

// ---------------------------------------------------------------------------------------------------
// One mode = inject engine CSS -> measure -> assert -> remove -> assert exact revert to baseline.
// ---------------------------------------------------------------------------------------------------
async function runMode(client, name, state, baseline, asserts, shots) {
  const css = ENGINE.buildCss(state);
  const result = { name, css_len: css.length, checks: [], pass: true };

  await client.evaluate(injectExpr(css));
  await sleep(60);
  const applied = await client.evaluate(READ_STATE);
  result.appliedTileBg = applied.tileBg;

  for (const a of asserts) {
    const mism = a.fn(applied);
    const ok = mism.length === 0;
    result.checks.push({ label: a.label, ok, mismatches: mism.slice(0, 6) });
    if (!ok) result.pass = false;
  }
  if (shots) result.shotApplied = await screenshot(client, `education-${name}-applied`);

  await client.evaluate(REMOVE_EXPR);
  await sleep(60);
  const reverted = await client.evaluate(READ_STATE);
  const revertMism = tokensEqual(baseline.tokens, reverted.tokens);
  const revertOk = revertMism.length === 0 && !reverted.styleElPresent;
  result.checks.push({ label: "exact revert to baseline (all 27 tokens + style removed)", ok: revertOk, mismatches: revertMism.slice(0, 6) });
  if (!revertOk) result.pass = false;

  return result;
}

// ---------------------------------------------------------------------------------------------------
// Optional end-to-end path: if the real content script is on the page, drive chrome.storage via the
// extension SW and verify the SAME invariants through the live extension (not just injected CSS).
// ---------------------------------------------------------------------------------------------------
async function findExtensionSw(targets) {
  const sws = targets.filter((t) => t.type === "service_worker");
  for (const sw of sws) {
    try {
      const c = await connect(sw);
      const info = await c.evaluate(`(()=>{ try{ var m=chrome.runtime.getManifest(); return {name:m.name, version:m.version, hasStorage:!!(chrome.storage&&chrome.storage.local)}; }catch(e){ return {err:String(e)}; } })()`);
      if (info && info.name && /Kinetic/i.test(info.name) && info.hasStorage) return { target: sw, client: c, info };
      c.close();
    } catch (e) { /* skip */ }
  }
  return null;
}

async function swSetStorage(swClient, obj) {
  const lit = JSON.stringify(obj);
  return swClient.evaluate(`(async()=>{ await new Promise(r=>chrome.storage.local.set(${lit}, r)); return true; })()`);
}

async function endToEnd(targets, pageClient, baseline) {
  const ext = await findExtensionSw(targets);
  if (!ext) return { ran: false, reason: "extension content script / SW not detected (Load unpacked to enable the end-to-end path)" };
  const e2e = { ran: true, ext: ext.info, modes: [] };
  try {
    // disable on -> tokens stock; off -> revert
    await swSetStorage(ext.client, { themeDisableEnabled: true, colorOverrideEnabled: false, colorOverrideValues: {} });
    await sleep(400);
    let s = await pageClient.evaluate(READ_STATE);
    const disMism = diffTokens(s.tokens, STOCK_EXPECTED);
    e2e.modes.push({ name: "disable(real-storage)", pass: disMism.length === 0 && !!(s.marker && s.marker.active), markerActive: !!(s.marker && s.marker.active), mismatches: disMism.slice(0, 6) });

    await swSetStorage(ext.client, { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} });
    await sleep(400);
    s = await pageClient.evaluate(READ_STATE);
    const revMism = tokensEqual(baseline.tokens, s.tokens);
    e2e.modes.push({ name: "off(real-storage)", pass: revMism.length === 0 && !s.styleElPresent && !!(s.marker && s.marker.active === false), markerActive: s.marker ? s.marker.active : null, mismatches: revMism.slice(0, 6) });
  } finally {
    // Always restore storage to default-OFF so we leave the extension exactly as found.
    try { await swSetStorage(ext.client, { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} }); } catch (e) { /* ignore */ }
    ext.client.close();
  }
  return e2e;
}

// ===================================================================================================
// --e2e: end-to-end through the REAL loaded extension. Drives chrome.storage from the extension's own
// popup page (reliable regardless of SW idle state); the page's ISOLATED content script reacts via
// storage.onChanged and applies live. We reload the Education tab first so the document_start content
// script is present, then assert the SAME §3.3 invariants through the real delivery path.
// ===================================================================================================
async function browserCdp() {
  const ver = await readJson(`${BROWSER}/json/version`);
  const c = new CdpClient({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl });
  await c.connect();
  return c;
}

async function discoverExtension(bc) {
  // Use a chrome://extensions scratch tab + developerPrivate to find our unpacked extension by name.
  const { targetId } = await bc.send("Target.createTarget", { url: "chrome://extensions/" });
  await sleep(1000);
  let found = null;
  try {
    const list = await readJson(`${BROWSER}/json/list`);
    const t = list.find((x) => x.id === targetId);
    if (t) {
      const pc = new CdpClient(t);
      await pc.connect();
      const items = await pc.evaluate(`(async()=>{ try{ const a=await new Promise(r=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},r)); return a.map(i=>({id:i.id,name:i.name,version:i.version,state:i.state})); }catch(e){ return {err:String(e)}; } })()`);
      if (Array.isArray(items)) {
        found = items.find((i) => /Kinetic Grid/i.test(i.name) || /Kinetic UI Fixes/i.test(i.name)) || null;
      }
      pc.close();
    }
  } finally {
    await bc.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return found;
}

async function openExtPage(bc, extId, sub) {
  const url = `chrome-extension://${extId}/${sub}`;
  const { targetId } = await bc.send("Target.createTarget", { url });
  await sleep(700);
  const list = await readJson(`${BROWSER}/json/list`);
  const t = list.find((x) => x.id === targetId);
  if (!t) throw new Error("could not open extension page " + url);
  const c = new CdpClient(t);
  await c.connect();
  return { client: c, targetId };
}

async function setStorageVia(drv, obj) {
  const lit = JSON.stringify(obj);
  return drv.evaluate(`(async()=>{ await new Promise(r=>chrome.storage.local.set(${lit}, r)); return true; })()`);
}

// Reload the Education tab and wait for the content-script marker to appear (proves the document_start
// content script injected on this load). Returns the eduClient connected post-reload.
async function reloadEducationAndWait(eduTarget) {
  let c = new CdpClient(eduTarget);
  await c.connect();
  await c.send("Page.enable").catch(() => {});
  await c.send("Page.reload", {});
  c.close();
  // The target id is stable across a reload; reconnect and poll for the marker + a stable readyState.
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    try {
      c = new CdpClient(eduTarget);
      await c.connect();
      const s = await c.evaluate(READ_STATE);
      const ctx = await c.evaluate(PAGE_READY);
      if (s.marker && ctx.ready === "complete") return { client: c, settledMarker: s.marker };
      c.close();
    } catch (e) { /* tab still reloading */ }
  }
  // last attempt: return whatever we can connect to
  c = new CdpClient(eduTarget);
  await c.connect();
  return { client: c, settledMarker: (await c.evaluate(READ_STATE)).marker };
}

const PAGE_READY = `(()=>({ready:document.readyState}))()`;

// One e2e mode: set storage via the popup driver -> content script applies -> read Education + assert.
async function e2eMode(drv, eduClient, name, storage, baseline, asserts, shot) {
  await setStorageVia(drv, storage);
  await sleep(650); // content-script debounce (~90ms) + apply + a margin
  const s = await eduClient.evaluate(READ_STATE);
  const out = { name, marker: s.marker, tileBg: s.tileBg, checks: [], pass: true };
  for (const a of asserts) {
    const m = a.fn(s);
    const ok = m.length === 0;
    out.checks.push({ label: a.label, ok, mismatches: m.slice(0, 6) });
    if (!ok) out.pass = false;
  }
  if (shot) out.shot = await screenshot(eduClient, `education-e2e-${name}`);
  return out;
}

async function runE2E() {
  const pages = await listPageTargets(BROWSER);
  const edu = pages.find((p) => /SaaS950/i.test(p.url) || /centralusdtedu00\.epicorsaas/i.test(p.url));
  if (!edu) { console.error("FATAL: no Education (SaaS950) tab found on port " + PORT); process.exit(2); }

  const bc = await browserCdp();
  const ext = await discoverExtension(bc);
  if (!ext || ext.state !== "ENABLED") {
    console.error("FATAL: the unpacked extension is not loaded/enabled. Load apps/kinetic-grid-fix-extension/ (or dist/unpacked) via chrome://extensions -> Load unpacked, then re-run.");
    bc.close();
    process.exit(3);
  }

  const report = { mode: "end-to-end (real extension)", port: Number(PORT), engineVersion: ENGINE.version, extension: ext, education: { pageId: edu.id, url: edu.url }, modes: [], overallPass: true };

  // 1) Reload Education so the document_start theme content script is present on this load.
  console.log("Reloading Education tab to inject the v" + ext.version + " content script...");
  const { client: eduClient, settledMarker } = await reloadEducationAndWait(edu);
  report.education.contentScriptPresent = !!settledMarker;
  report.education.restMarker = settledMarker;

  // Open the extension's popup page as the storage driver (chrome.storage write context, SW-idle-proof).
  const driver = await openExtPage(bc, ext.id, "popup/popup.html");
  const drv = driver.client;

  try {
    if (!settledMarker) {
      report.overallPass = false;
      report.education.error = "content-script marker absent after reload — theme-control.js did not inject (is the extension v3.3.0 with the content_scripts entry?)";
    } else {
      // Ensure a clean themed baseline: force all theme keys OFF, settle, capture.
      await setStorageVia(drv, { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} });
      await sleep(500);
      const baseline = await eduClient.evaluate(READ_STATE);
      report.baselineTileBg = baseline.tileBg;
      report.baselineMarkerActive = baseline.marker ? baseline.marker.active : null;
      report.baselineShot = await screenshot(eduClient, "education-e2e-baseline");

      const derivedPrimary = ENGINE.deriveFamily("primary", "#1a73e8");

      // disable
      report.modes.push(await e2eMode(drv, eduClient, "disable", { themeDisableEnabled: true, colorOverrideEnabled: false, colorOverrideValues: {} }, baseline, [
        { label: "all 27 tokens == §4.2 stock", fn: (s) => diffTokens(s.tokens, STOCK_EXPECTED) },
        { label: "marker active:true, themeDisabled:true, tokensPinned:27", fn: (s) => (s.marker && s.marker.active && s.marker.themeDisabled && s.marker.tokensPinned === 27 ? [] : [{ token: "marker", got: s.marker }]) },
        { label: "visible: home-card tile shifts off themed maroon", fn: (s) => visibleConsumerChanged(baseline, s) }
      ], TAKE_SHOTS));

      // override primary
      report.modes.push(await e2eMode(drv, eduClient, "override-primary", { themeDisableEnabled: false, colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }, baseline, [
        { label: "primary set == §4.2 derived (hsl(214,82%,*))", fn: (s) => diffTokens(s.tokens, derivedPrimary, Object.keys(derivedPrimary)) },
        { label: "marker families==['primary'], active:true", fn: (s) => (s.marker && s.marker.active && Array.isArray(s.marker.families) && s.marker.families.length === 1 && s.marker.families[0] === "primary" ? [] : [{ token: "marker", got: s.marker }]) },
        { label: "accent unchanged from themed baseline (non-target family untouched)", fn: (s) => (norm(s.tokens["--accent"]) === norm(baseline.tokens["--accent"]) ? [] : [{ token: "--accent", expected: baseline.tokens["--accent"], got: s.tokens["--accent"] }]) }
      ], TAKE_SHOTS));

      // both
      report.modes.push(await e2eMode(drv, eduClient, "both", { themeDisableEnabled: true, colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }, baseline, [
        { label: "primary == user override (wins over stock)", fn: (s) => diffTokens(s.tokens, derivedPrimary, Object.keys(derivedPrimary)) },
        { label: "accent == stock (disable applies to non-overridden families)", fn: (s) => (norm(s.tokens["--accent"]) === norm(STOCK_EXPECTED["--accent"]) ? [] : [{ token: "--accent", expected: STOCK_EXPECTED["--accent"], got: s.tokens["--accent"] }]) }
      ], TAKE_SHOTS));

      // off -> exact revert
      const offState = await (async () => {
        await setStorageVia(drv, { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} });
        await sleep(650);
        return eduClient.evaluate(READ_STATE);
      })();
      const revMism = tokensEqual(baseline.tokens, offState.tokens);
      report.modes.push({
        name: "off", marker: offState.marker, tileBg: offState.tileBg,
        checks: [
          { label: "all 27 tokens exact-revert to themed baseline", ok: revMism.length === 0, mismatches: revMism.slice(0, 6) },
          { label: "no #kinetic-theme-control <style> remains", ok: !offState.styleElPresent, mismatches: [] },
          { label: "marker active:false (fully inert)", ok: !!(offState.marker && offState.marker.active === false), mismatches: [] }
        ],
        pass: revMism.length === 0 && !offState.styleElPresent && !!(offState.marker && offState.marker.active === false)
      });

      report.overallPass = report.modes.every((m) => m.pass);
    }
  } finally {
    // Restore the extension to default-OFF and close the scratch popup tab; leave Education as found.
    try { await setStorageVia(drv, { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} }); } catch (e) { /* ignore */ }
    await sleep(300);
    try { driver.client.close(); } catch (e) { /* ignore */ }
    try { await bc.send("Target.closeTarget", { targetId: driver.targetId }); } catch (e) { /* ignore */ }
    // Confirm Education is clean (no style, marker inert).
    try { const fin = await eduClient.evaluate(READ_STATE); report.education.cleanExit = !fin.styleElPresent && !!(fin.marker && fin.marker.active === false); } catch (e) { /* ignore */ }
    try { eduClient.close(); } catch (e) { /* ignore */ }
    bc.close();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "theme-e2e-verification.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(path.join(OUT_DIR, "theme-e2e-verification.md"), renderE2EMd(report));

  console.log("\n========== THEME-CONTROL END-TO-END (REAL EXTENSION) ==========");
  console.log("Extension:", report.extension.name, "v" + report.extension.version, "(" + report.extension.id + ")");
  console.log("Content script present after Education reload:", report.education.contentScriptPresent);
  if (report.baselineTileBg) console.log("Baseline tile bg (themed):", report.baselineTileBg);
  for (const m of report.modes) {
    console.log(`  [${m.pass ? "PASS" : "FAIL"}] ${m.name}` + (m.tileBg ? `  tile=${m.tileBg}` : ""));
    for (const c of m.checks) console.log(`        ${c.ok ? "ok " : "XX "} ${c.label}` + (c.ok ? "" : "  -> " + JSON.stringify(c.mismatches)));
  }
  if (report.education.error) console.log("  ERROR:", report.education.error);
  console.log("  clean exit (Education inert, restored):", report.education.cleanExit);
  console.log("\nOVERALL:", report.overallPass ? "PASS ✅" : "FAIL ❌");
  console.log("Artifacts:", path.relative(ROOT, path.join(OUT_DIR, "theme-e2e-verification.json")), "+ .md");
  console.log("===============================================================\n");
  process.exit(report.overallPass ? 0 : 1);
}

function renderE2EMd(r) {
  const lines = [];
  lines.push("# Theme-control END-TO-END verification (real loaded extension)");
  lines.push("");
  lines.push("Drives the **actually-loaded unpacked extension** through its real delivery path —");
  lines.push("`chrome.storage.local` (written from the extension's own popup page) → the ISOLATED content");
  lines.push("script's `storage.onChanged` → live `<style>` apply — on the themed **Education (SaaS950)** tab,");
  lines.push("which is reloaded first so the `document_start` content script is present.");
  lines.push("");
  lines.push(`- **Overall:** ${r.overallPass ? "PASS ✅" : "FAIL ❌"}`);
  lines.push(`- **Extension:** ${r.extension.name} v${r.extension.version} (\`${r.extension.id}\`), state ${r.extension.state}`);
  lines.push(`- **Content script present after Education reload:** ${r.education.contentScriptPresent}`);
  if (r.baselineTileBg) lines.push(`- **Themed baseline tile bg:** \`${r.baselineTileBg}\` (home-card \`.khp-tile.tile-background\`, driven by \`--primary\`)`);
  lines.push("");
  if (r.education.error) { lines.push("> ❌ " + r.education.error); lines.push(""); }
  lines.push("| Mode (set via real chrome.storage) | Result | Tile bg | Checks |");
  lines.push("|---|---|---|---|");
  for (const m of r.modes) {
    const checks = m.checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.label}`).join("<br>");
    lines.push(`| \`${m.name}\` | ${m.pass ? "PASS" : "FAIL"} | \`${m.tileBg || "-"}\` | ${checks} |`);
  }
  lines.push(`| clean exit | ${r.education.cleanExit ? "PASS" : "FAIL"} | — | ✅ Education restored: no \`<style>\`, marker \`active:false\`, storage default-OFF |`);
  lines.push("");
  lines.push("Screenshots in `.tmp/theme-live/` (`education-e2e-*`). This complements the engine-injection");
  lines.push("mechanism proof in [`theme-verification.md`](theme-verification.md): that one proves the CSS is");
  lines.push("correct; this one proves the **shipped extension delivers it** through storage + the content script.");
  lines.push("");
  lines.push("Reproduce: `node verify/theme-live-harness.mjs --e2e --port 9100` (requires the unpacked extension loaded).");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Main verification run.
// ---------------------------------------------------------------------------------------------------
async function main() {
  if (E2E) { await runE2E(); return; }
  const targets = await readJson(`${BROWSER}/json/list`);
  const pages = (await listPageTargets(BROWSER));
  const edu = pages.find((p) => /SaaS950/i.test(p.url) || /centralusdtedu00\.epicorsaas/i.test(p.url));
  const third = pages.find((p) => /SaaS695third/i.test(p.url) || /centralusdtadtl17\.epicorsaas/i.test(p.url));

  const report = {
    generatedNote: "Timestamp added by caller (Date.now unavailable in some sandboxes).",
    port: Number(PORT),
    engineVersion: ENGINE.version,
    tokenCount: TOKEN_NAMES.length,
    education: null,
    third: null,
    endToEnd: null,
    overallPass: true
  };

  if (!edu) {
    console.error("FATAL: no Education (SaaS950) page target found on port " + PORT);
    process.exit(2);
  }

  // ---- Education (themed): the mechanism proof -----------------------------------------------------
  const eduClient = await connect(edu);
  try {
    const baseline = await eduClient.evaluate(READ_STATE);
    const baselineShot = await screenshot(eduClient, "education-baseline");
    const eduReport = { pageId: edu.id, url: edu.url, themed: true, baselineShot, baselineTileBg: baseline.tileBg, modes: [], inertOff: null };

    // Sanity: Education really is themed (its live tokens differ from stock on the brand families).
    const themedDelta = diffTokens(baseline.tokens, STOCK_EXPECTED);
    eduReport.themedFamiliesDifferingFromStock = themedDelta.map((m) => m.token);

    // Mode 1 — DISABLE: all 27 tokens -> stock; the themed home-card tile visibly changes color.
    eduReport.modes.push(await runMode(eduClient, "disable", { themeDisableEnabled: true }, baseline, [
      { label: "all 27 tokens == §4.2 stock", fn: (s) => diffTokens(s.tokens, STOCK_EXPECTED) },
      { label: "visible consumer: home-card tile bg shifts off the themed maroon", fn: (s) => visibleConsumerChanged(baseline, s) }
    ], TAKE_SHOTS));

    // Mode 2 — OVERRIDE primary #1a73e8 -> derived; non-primary untouched.
    const derivedPrimary = ENGINE.deriveFamily("primary", "#1a73e8");
    eduReport.modes.push(await runMode(eduClient, "override-primary", { colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }, baseline, [
      { label: "primary set == §4.2 derived (hsl(214,82%,*))", fn: (s) => diffTokens(s.tokens, derivedPrimary, Object.keys(derivedPrimary)) },
      { label: "accent unchanged from themed baseline (non-target family untouched)", fn: (s) => (norm(s.tokens["--accent"]) === norm(baseline.tokens["--accent"]) ? [] : [{ token: "--accent", expected: baseline.tokens["--accent"], got: s.tokens["--accent"] }]) }
    ], TAKE_SHOTS));

    // Mode 3 — BOTH: stock everywhere, user color wins for primary (later-wins).
    eduReport.modes.push(await runMode(eduClient, "both", { themeDisableEnabled: true, colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }, baseline, [
      { label: "primary == user override (wins over stock)", fn: (s) => diffTokens(s.tokens, derivedPrimary, Object.keys(derivedPrimary)) },
      { label: "accent == stock (disable applies to non-overridden families)", fn: (s) => (norm(s.tokens["--accent"]) === norm(STOCK_EXPECTED["--accent"]) ? [] : [{ token: "--accent", expected: STOCK_EXPECTED["--accent"], got: s.tokens["--accent"] }]) }
    ], TAKE_SHOTS));

    // Inert OFF (engine-level): empty state -> '' -> nothing injected; page already == baseline.
    const inertCss = ENGINE.buildCss({});
    eduReport.inertOff = {
      buildCssEmpty: inertCss === "",
      engineMarkerActive: (ENGINE.validFamilies({}).length > 0),  // false expected
      pass: inertCss === "" && ENGINE.validFamilies({}).length === 0
    };

    eduReport.pass = eduReport.modes.every((m) => m.pass) && eduReport.inertOff.pass;
    report.education = eduReport;
    if (!eduReport.pass) report.overallPass = false;

    // ---- Optional end-to-end via the real extension (if loaded) -----------------------------------
    report.endToEnd = await endToEnd(targets, eduClient, baseline);
    if (report.endToEnd.ran && !report.endToEnd.modes.every((m) => m.pass)) report.overallPass = false;

    // Final safety: confirm no injected style left behind on Education.
    const finalState = await eduClient.evaluate(READ_STATE);
    report.education.cleanExit = !finalState.styleElPresent && tokensEqual(baseline.tokens, finalState.tokens).length === 0;
    if (!report.education.cleanExit) report.overallPass = false;
  } finally {
    eduClient.close();
  }

  // ---- Third (un-themed) cross-check: native tokens already == stock ------------------------------
  if (third) {
    const thirdClient = await connect(third);
    try {
      const s = await thirdClient.evaluate(READ_STATE);
      const mism = diffTokens(s.tokens, STOCK_EXPECTED);
      report.third = { pageId: third.id, url: third.url, themed: false, tokensEqualStock: mism.length === 0, mismatches: mism.slice(0, 8), pass: mism.length === 0 };
      if (!report.third.pass) report.overallPass = false;
    } finally {
      thirdClient.close();
    }
  } else {
    report.third = { pass: true, skipped: "no Third (SaaS695third) tab found — cross-check skipped" };
  }

  // ---- Write artifacts ---------------------------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "theme-verification.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(path.join(OUT_DIR, "theme-verification.md"), renderMd(report));

  // ---- Console summary ---------------------------------------------------------------------------
  console.log("\n========== THEME-CONTROL LIVE VERIFICATION ==========");
  console.log("Engine version:", report.engineVersion, "| tokens:", report.tokenCount);
  if (report.education) {
    console.log("\nEducation (themed) — mechanism proof (real engine CSS injected via CDP):");
    console.log("  themed families differing from stock:", (report.education.themedFamiliesDifferingFromStock || []).join(", ") || "(none?!)");
    for (const m of report.education.modes) {
      console.log(`  [${m.pass ? "PASS" : "FAIL"}] ${m.name}`);
      for (const c of m.checks) console.log(`        ${c.ok ? "ok " : "XX "} ${c.label}` + (c.ok ? "" : "  -> " + JSON.stringify(c.mismatches)));
    }
    console.log(`  [${report.education.inertOff.pass ? "PASS" : "FAIL"}] inert OFF (buildCss('')==='' & no families active)`);
    console.log(`  [${report.education.cleanExit ? "PASS" : "FAIL"}] clean exit (no style left, baseline restored)`);
  }
  if (report.endToEnd) {
    if (report.endToEnd.ran) {
      console.log("\nEnd-to-end via real extension (" + report.endToEnd.ext.name + " v" + report.endToEnd.ext.version + "):");
      for (const m of report.endToEnd.modes) console.log(`  [${m.pass ? "PASS" : "FAIL"}] ${m.name} (markerActive=${m.markerActive})` + (m.pass ? "" : "  -> " + JSON.stringify(m.mismatches)));
    } else {
      console.log("\nEnd-to-end via real extension: SKIPPED — " + report.endToEnd.reason);
    }
  }
  if (report.third) {
    if (report.third.skipped) console.log("\nThird cross-check: SKIPPED — " + report.third.skipped);
    else console.log(`\nThird (un-themed) cross-check: [${report.third.pass ? "PASS" : "FAIL"}] native tokens == §4.2 stock`);
  }
  console.log("\nOVERALL:", report.overallPass ? "PASS ✅" : "FAIL ❌");
  console.log("Artifacts:", path.relative(ROOT, path.join(OUT_DIR, "theme-verification.json")), "+ .md");
  console.log("=====================================================\n");

  process.exit(report.overallPass ? 0 : 1);
}

function renderMd(r) {
  const lines = [];
  lines.push("# Theme-control live verification (Track D · T_D_05/T_D_06)");
  lines.push("");
  lines.push("Live CDP-9100 verification of the v3.3.0 disable-theming + color-override feature against the");
  lines.push("themed **Education (SaaS950)** tab, cross-checked against the un-themed **Third (SaaS695third)** tab.");
  lines.push("");
  lines.push(`- **Overall:** ${r.overallPass ? "PASS ✅" : "FAIL ❌"}`);
  lines.push(`- Engine: \`src/theme-control.js\` v${r.engineVersion} · ${r.tokenCount} tokens (10 families)`);
  lines.push("- **Method:** the CSS asserted here is produced by the extension's own engine (`buildCss`/`stockBlock`/");
  lines.push("  `deriveFamily`) and injected as the real `#kinetic-theme-control <style>` via CDP — byte-identical to");
  lines.push("  what the ISOLATED content script's `ensureStyle()` appends. Computed `:root` tokens are read back with");
  lines.push("  `getComputedStyle` (whitespace-normalized). Every mode is inject → measure → **remove** → assert exact");
  lines.push("  revert to the captured baseline (§3.3 / §6 reversibility).");
  lines.push("");
  if (r.education) {
    const e = r.education;
    lines.push("## Education (themed) — mechanism proof");
    lines.push("");
    lines.push("Themed brand families that differ from stock at baseline (the live theme): " +
      "`" + (e.themedFamiliesDifferingFromStock || []).join("`, `") + "`.");
    lines.push("");
    lines.push("| Mode | Result | Checks |");
    lines.push("|---|---|---|");
    for (const m of e.modes) {
      const checks = m.checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.label}`).join("<br>");
      lines.push(`| \`${m.name}\` | ${m.pass ? "PASS" : "FAIL"} | ${checks} |`);
    }
    lines.push(`| inert OFF | ${e.inertOff.pass ? "PASS" : "FAIL"} | ✅ \`buildCss('')===''\` and no families active (marker \`active:false\`) |`);
    lines.push(`| clean exit | ${e.cleanExit ? "PASS" : "FAIL"} | ✅ no \`#kinetic-theme-control\` left; all 27 tokens back to baseline |`);
    lines.push("");
    if (e.baselineTileBg) {
      lines.push("**Visible consumer — the home-card tile** (`.khp-tile.tile-background`, driven by `--primary`):");
      lines.push("");
      lines.push("| State | Tile background | |");
      lines.push("|---|---|---|");
      lines.push(`| themed baseline | \`${e.baselineTileBg}\` | maroon (Education primary, hue 0) |`);
      for (const m of e.modes) {
        if (!m.appliedTileBg) continue;
        const note = m.name === "disable" ? "teal — the stock palette (= Third)"
          : m.name === "override-primary" ? "the user's blue (`#1a73e8` → derived primary)"
          : m.name === "both" ? "user override wins over stock" : "";
        lines.push(`| \`${m.name}\` applied | \`${m.appliedTileBg}\` | ${note} |`);
      }
      lines.push("");
    }
    if (e.baselineShot) {
      lines.push("Screenshots (`.tmp/theme-live/`): `education-baseline.png` (themed) vs");
      lines.push("`education-disable-applied.png` (stock) vs `education-override-primary-applied.png` (custom blue).");
      lines.push("");
    }
  }
  if (r.endToEnd) {
    lines.push("## End-to-end via the real extension");
    lines.push("");
    if (r.endToEnd.ran) {
      lines.push(`Driven through the loaded **${r.endToEnd.ext.name} v${r.endToEnd.ext.version}** service worker's`);
      lines.push("`chrome.storage.local` → the real content script's `storage.onChanged` → live apply:");
      lines.push("");
      lines.push("| Mode | Result | Marker active |");
      lines.push("|---|---|---|");
      for (const m of r.endToEnd.modes) lines.push(`| \`${m.name}\` | ${m.pass ? "PASS" : "FAIL"} | ${m.markerActive} |`);
    } else {
      lines.push("SKIPPED — " + r.endToEnd.reason + ".");
      lines.push("");
      lines.push("The chrome.storage → `storage.onChanged` → apply plumbing and the §4.4 marker are covered by the");
      lines.push("unit suite (`verify/theme-control.test.mjs` fake-DOM runtime tests + `verify/background-theme-coexist.test.mjs`).");
      lines.push("For the full live path through the loaded extension, run `node verify/theme-live-harness.mjs --e2e`");
      lines.push("→ [`theme-e2e-verification.md`](theme-e2e-verification.md).");
    }
    lines.push("");
  }
  if (r.third) {
    lines.push("## Third (un-themed) cross-check");
    lines.push("");
    if (r.third.skipped) {
      lines.push("SKIPPED — " + r.third.skipped + ".");
    } else {
      lines.push(`**${r.third.pass ? "PASS ✅" : "FAIL ❌"}** — the un-themed tenant's live \`:root\` tokens already equal §4.2`);
      lines.push("stock, confirming the headline goal: **disable-theming on Education reproduces Third's stock palette.**");
      if (!r.third.pass) lines.push("\nMismatches: `" + JSON.stringify(r.third.mismatches) + "`");
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("Reproduce: `node verify/theme-live-harness.mjs --port 9100` (re-resolves page ids each run).");
  lines.push("Raw data: [`theme-verification.json`](theme-verification.json).");
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => { console.error("FATAL", e && e.stack ? e.stack : e); process.exit(2); });
