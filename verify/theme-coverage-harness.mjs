// theme-coverage-harness.mjs — LIVE CDP-9100 validation that the color-override controls (the popup's
// 10 family pickers / 27 tokens) govern EVERY theme-sourced color on screen, and correctly leave the
// neutral grayscale ramp untouched. Companion to theme-live-harness.mjs (which proves the disable/revert
// invariants); this one proves COVERAGE. Read-only: inject-measure-REMOVE, asserts exact revert.
//
// METHOD (selector-independent, so it can't be fooled by which sample element a CSS selector lands on):
//   1. Census the live page: every visible element's painted colors (text/bg/border/svg), each distinct
//      RGB classified by SOURCE via the :root custom-property rgb index — THEME (one of the 10 families)
//      vs NEUTRAL (--neutral-*/white/black/surface) vs other.
//   2. Override all 10 families to distinct sentinel hexes (engine-built CSS — the real injected bytes).
//   3. Assert every one of the 27 tokens == its engine-derived sentinel; every baseline THEME color has
//      DISAPPEARED (moved); every baseline NEUTRAL color SURVIVES (untouched).
//   4. Remove and assert exact revert.
//
// The override <style> is injected with a one-notch-higher selector specificity (html:not(#id)) so it
// wins even while the real extension's own disable block re-asserts last in <head> — faithfully
// mirroring the real extension, where override is emitted after disable in ONE element and wins anyway.
//
// USAGE: node verify/theme-coverage-harness.mjs [--port 9100] [--out-dir <dir>]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { CdpClient, listPageTargets } from "./cdp-lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = argVal("--port") || process.env.PORT || "9100";
const BROWSER = `http://127.0.0.1:${PORT}`;
const OUT_DIR = argVal("--out-dir") || path.join(ROOT, ".output", "chrome-plugin-grid-fix");

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function loadEngine() {
  const src = readFileSync(path.join(ROOT, "src", "theme-control.js"), "utf8");
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "theme-control.js" });
  return sandbox.self.__KINETIC_THEME_CONTROL___MODULE;
}
const ENGINE = loadEngine();
const norm = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();
const ALL_TOKENS = [];
for (const f of ENGINE.TOKENS) { ALL_TOKENS.push(f.base); for (const v of f.variants) ALL_TOKENS.push(f.base + v.suffix); }

// Distinct, well-separated sentinel hue per family so each override is unmistakable.
const SENTINELS = {
  primary: "#e91e63", secondary: "#9c27b0", tertiary: "#3f51b5", accent: "#00bcd4", base: "#cddc39",
  interactive: "#ff5722", focus: "#795548", error: "#607d8b", success: "#4caf50", warning: "#ffc107"
};

const STYLE_ID = "kinetic-theme-coverage-probe";
const injectExpr = (css) => `(()=>{var id=${JSON.stringify(STYLE_ID)};var el=document.getElementById(id);
  if(!el){el=document.createElement('style');el.id=id;}
  el.textContent=${JSON.stringify(css)}.split('html{').join('html:not(#kgf-zz){');
  (document.head||document.documentElement).appendChild(el);return {len:(el.textContent||'').length};})()`;
const REMOVE = `(()=>{var el=document.getElementById(${JSON.stringify(STYLE_ID)});if(el&&el.parentNode)el.parentNode.removeChild(el);return {ok:true};})()`;

const READ = `(()=>{var cs=getComputedStyle(document.documentElement);var o={tokens:{}};
  ${JSON.stringify(ALL_TOKENS)}.forEach(t=>o.tokens[t]=cs.getPropertyValue(t).trim());
  var themeSet=${JSON.stringify(ALL_TOKENS)};
  function rgbOf(val){var p=document.createElement('span');p.style.color='';try{p.style.color=val;}catch(e){return null;}
    document.body.appendChild(p);var c=getComputedStyle(p).color;document.body.removeChild(p);return c;}
  var props=[],seen={};
  function scan(rules){for(var i=0;i<rules.length;i++){var r=rules[i];try{
    if(r.type===1&&r.style&&r.selectorText&&/(:root|html)/.test(r.selectorText)){
      for(var j=0;j<r.style.length;j++){var p=r.style[j];if(p.indexOf('--')===0&&!seen[p]){seen[p]=1;props.push(p);}}}
    if(r.cssRules)scan(r.cssRules);}catch(e){}}}
  for(var s=0;s<document.styleSheets.length;s++){try{scan(document.styleSheets[s].cssRules);}catch(e){}}
  var rgbIndex={};props.forEach(function(p){var v=cs.getPropertyValue(p).trim();if(!v)return;var rgb=rgbOf(v);
    if(!rgb||!/^rgb/.test(rgb))return;(rgbIndex[rgb]=rgbIndex[rgb]||[]).push(p);});
  function bucket(rgb){var toks=rgbIndex[rgb]||[];
    if(toks.some(function(t){return themeSet.indexOf(t)>=0;}))return 'THEME';
    if(toks.some(function(t){return /^--neutral|^--bs-(white|black|gray)|^--kendo-color-(base|surface|app-surface|on-app-surface)/.test(t);}))return 'NEUTRAL';
    return toks.length?'OTHERVAR':'HARDCODED';}
  var tally={};
  function add(rgb){if(!rgb||rgb==='rgba(0, 0, 0, 0)'||rgb==='transparent'||/, 0\\)$/.test(rgb))return;tally[rgb]=(tally[rgb]||0)+1;}
  var all=document.querySelectorAll('*');
  for(var i=0;i<all.length&&i<20000;i++){var el=all[i];var r;try{r=el.getBoundingClientRect();}catch(e){continue;}
    if(r.width<=0||r.height<=0)continue;var g=getComputedStyle(el);if(g.visibility==='hidden'||g.display==='none')continue;
    add(g.color);add(g.backgroundColor);
    if(g.borderTopWidth!=='0px')add(g.borderTopColor);if(g.borderBottomWidth!=='0px')add(g.borderBottomColor);
    if(g.fill&&g.fill!=='none')add(rgbOf(g.fill));if(g.stroke&&g.stroke!=='none')add(rgbOf(g.stroke));}
  var theme={},neutral={};
  Object.keys(tally).forEach(function(rgb){var b=bucket(rgb);if(b==='THEME')theme[rgb]=tally[rgb];else if(b==='NEUTRAL')neutral[rgb]=tally[rgb];});
  o.themeColors=theme;o.neutralColors=neutral;return o;})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pages = await listPageTargets(BROWSER);
  const target = pages.find((p) => /epicorsaas\.com/.test(p.url) && /\/apps\/erp\//.test(p.url));
  if (!target) { console.error("No Kinetic page target on CDP " + PORT + "."); process.exit(2); }
  console.error(`Target: ${target.title} :: ${target.url}`);
  const client = new CdpClient(target);
  await client.connect();

  const results = [];
  const check = (label, ok, detail) => { results.push({ label, ok: !!ok, detail }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  :: " + detail : ""}`); };

  const base = await client.evaluate(READ);
  const css = ENGINE.buildCss({ colorOverrideEnabled: true, colorOverrideValues: SENTINELS });
  const expected = {};
  for (const fam of Object.keys(SENTINELS)) Object.assign(expected, ENGINE.deriveFamily(fam, SENTINELS[fam]));

  await client.evaluate(injectExpr(css));
  await sleep(90);
  const applied = await client.evaluate(READ);

  let tokOk = 0; for (const t of ALL_TOKENS) if (norm(applied.tokens[t]) === norm(expected[t])) tokOk++;
  check(`all ${ALL_TOKENS.length} theme tokens == derived sentinel`, tokOk === ALL_TOKENS.length, `${tokOk}/${ALL_TOKENS.length}`);

  const baseTheme = Object.keys(base.themeColors);
  const appliedColors = new Set([...Object.keys(applied.themeColors), ...Object.keys(applied.neutralColors)]);
  const surviving = baseTheme.filter((rgb) => appliedColors.has(rgb));
  const themeInstances = baseTheme.reduce((s, k) => s + base.themeColors[k], 0);
  check(`all ${baseTheme.length} distinct THEME colors recolored (${themeInstances} instances)`, surviving.length === 0,
    surviving.length ? `still present: ${surviving.join(", ")}` : `${baseTheme.length}/${baseTheme.length} moved`);

  const baseNeutral = Object.keys(base.neutralColors);
  const lostNeutral = baseNeutral.filter((rgb) => !appliedColors.has(rgb));
  check(`all ${baseNeutral.length} distinct NEUTRAL colors UNCHANGED (grayscale by design)`, lostNeutral.length === 0,
    lostNeutral.length ? `changed: ${lostNeutral.join(", ")}` : "");

  await client.evaluate(REMOVE);
  await sleep(90);
  const reverted = await client.evaluate(READ);
  let revOk = 0; for (const t of ALL_TOKENS) if (norm(reverted.tokens[t]) === norm(base.tokens[t])) revOk++;
  check(`exact revert: all ${ALL_TOKENS.length} tokens restored`, revOk === ALL_TOKENS.length, `${revOk}/${ALL_TOKENS.length}`);
  const revertedColors = new Set([...Object.keys(reverted.themeColors), ...Object.keys(reverted.neutralColors)]);
  check("exact revert: all theme colors back on screen", baseTheme.every((rgb) => revertedColors.has(rgb)), "");

  client.close();
  const pass = results.filter((r) => r.ok).length;
  const summary = {
    target: { title: target.title, url: target.url },
    distinctThemeColors: baseTheme.length, themeColorInstances: Object.keys(base.themeColors).reduce((s, k) => s + base.themeColors[k], 0),
    distinctNeutralColors: Object.keys(base.neutralColors).length,
    checks: results, pass, total: results.length, ok: pass === results.length
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "theme-coverage-verification.json"), JSON.stringify(summary, null, 2));
  console.log(`\n=== ${pass}/${results.length} checks passed ===  (wrote ${path.relative(ROOT, path.join(OUT_DIR, "theme-coverage-verification.json"))})`);
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
