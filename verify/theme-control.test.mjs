// theme-control.test.mjs — comprehensive unit suite for src/theme-control.js
// (kinetic-theme-control-extension, Track D · T_D_01 + T_D_02 + T_D_03). SUPERSEDES the Track A seed
// smoke (theme-control-smoke.test.mjs) — it covers everything the smoke did plus the §4.5 round-trip
// sweep, the hue-sat derive mode, TOKENS-table integrity, the full §4.4 marker shape, and more runtime
// edge cases. The live mechanism is proven separately by verify/theme-live-harness.mjs (T_D_05/06).
//
// Loaded the repo way: fs.readFileSync + vm into a `self` sandbox; module global is
// `self.__KINETIC_THEME_CONTROL___MODULE`. The auto-boot stays inert with no document/chrome.
//
// §4.2 WORKED-EXAMPLE NOTE: hexToHsl("#1a73e8") = {h:214,s:82,l:51} by the standard clamp+round
// conversion (s = 206/252 = 0.8175 -> 82%, what Chrome DevTools reports). The 00_shared_context.md §4.2
// prose says 84%; that digit is a documented rounding slip (see plans/TASKS.md "Contract-change
// proposals"). The implementation and these assertions use the mathematically-correct 82%.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "theme-control.js"), "utf8");

function loadModule() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "theme-control.js" });
  return sandbox.self.__KINETIC_THEME_CONTROL___MODULE;
}

const M = loadModule();

// vm-realm objects carry that realm's prototype, which trips strict deepEqual's prototype check.
// Rebuild them in this realm before comparing.
const plain = (o) => JSON.parse(JSON.stringify(o));

// =====================================================================================================
// §4.5 — color util
// =====================================================================================================

test("hexToHsl: #1a73e8 -> {214,82,51} (standard round; doc's 84% is a slip)", () => {
  assert.deepEqual(plain(M.hexToHsl("#1a73e8")), { h: 214, s: 82, l: 51 });
});

test("hexToHsl: 3-digit expansion + grayscale axis + no-hash form", () => {
  assert.deepEqual(plain(M.hexToHsl("#fff")), { h: 0, s: 0, l: 100 });
  assert.deepEqual(plain(M.hexToHsl("#000")), { h: 0, s: 0, l: 0 });
  assert.deepEqual(plain(M.hexToHsl("#808080")), { h: 0, s: 0, l: 50 });
  assert.deepEqual(plain(M.hexToHsl("ff0000")), { h: 0, s: 100, l: 50 });
  assert.deepEqual(plain(M.hexToHsl("#00ff00")), { h: 120, s: 100, l: 50 });
  assert.deepEqual(plain(M.hexToHsl("#0000ff")), { h: 240, s: 100, l: 50 });
});

test("hexToHsl: invalid input -> null", () => {
  assert.equal(M.hexToHsl("nope"), null);
  assert.equal(M.hexToHsl("#12"), null);
  assert.equal(M.hexToHsl("#12345"), null);
  assert.equal(M.hexToHsl("#abcg12"), null);
  assert.equal(M.hexToHsl(123), null);
  assert.equal(M.hexToHsl(null), null);
  assert.equal(M.hexToHsl(undefined), null);
});

test("isValidHex: 3- and 6-digit, with/without #, case-insensitive", () => {
  for (const ok of ["#1a73e8", "1a73e8", "#abc", "ABC", "#FFFFFF", "000000"]) {
    assert.equal(M.isValidHex(ok), true, ok);
  }
  for (const bad of ["#abcg12", "#1234", "#12", "", "#", "rgb(0,0,0)", null, 42, {}]) {
    assert.equal(M.isValidHex(bad), false, JSON.stringify(bad));
  }
});

test("hslStr: integer percents, no space after comma (matches how we assert)", () => {
  assert.equal(M.hslStr(192, 96, 20), "hsl(192,96%,20%)");
  assert.equal(M.hslStr(19, 97, 81), "hsl(19,97%,81%)");
  // hue wrap + clamping + rounding
  assert.equal(M.hslStr(380, 120, -5), "hsl(20,100%,0%)");
  assert.equal(M.hslStr(-10, 50.6, 49.4), "hsl(350,51%,49%)");
});

test("hslToHex: primary/secondary axis colors exact", () => {
  assert.equal(M.hslToHex({ h: 0, s: 0, l: 0 }), "#000000");
  assert.equal(M.hslToHex({ h: 0, s: 0, l: 100 }), "#ffffff");
  assert.equal(M.hslToHex({ h: 0, s: 100, l: 50 }), "#ff0000");
  assert.equal(M.hslToHex({ h: 120, s: 100, l: 50 }), "#00ff00");
  assert.equal(M.hslToHex({ h: 240, s: 100, l: 50 }), "#0000ff");
  assert.equal(M.hslToHex({ h: 60, s: 100, l: 50 }), "#ffff00");
  assert.equal(M.hslToHex({ h: 180, s: 100, l: 50 }), "#00ffff");
});

test("hexToHsl <-> hslToHex round-trips within ±1 per channel across a hue/sat/light sweep (§4.5)", () => {
  const hexes = [
    "#1a73e8", "#e81a73", "#73e81a", "#112233", "#fedcba", "#0a0b0c",
    "#ff8800", "#008844", "#8844ff", "#445566", "#abcdef", "#123456"
  ];
  for (const hex of hexes) {
    const hsl = M.hexToHsl(hex);
    const back = M.hexToHsl(M.hslToHex(hsl)); // hex -> hsl -> hex -> hsl: hsl should be stable within ±1
    assert.ok(Math.abs(back.h - hsl.h) <= 1 || Math.abs(back.h - hsl.h) >= 359, `${hex} hue ${hsl.h} vs ${back.h}`);
    assert.ok(Math.abs(back.s - hsl.s) <= 1, `${hex} sat ${hsl.s} vs ${back.s}`);
    assert.ok(Math.abs(back.l - hsl.l) <= 1, `${hex} light ${hsl.l} vs ${back.l}`);
  }
});

// =====================================================================================================
// §4.2 — TOKENS integrity (the single source of truth)
// =====================================================================================================

test("TOKENS: 10 families, 27 tokens total, keys/labels match the §4.2 table", () => {
  assert.equal(M.TOKENS.length, 10, "10 families");
  const keys = plain(M.TOKENS).map((f) => f.key);
  assert.deepEqual(keys, ["primary", "secondary", "tertiary", "accent", "base", "interactive", "focus", "error", "success", "warning"]);
  let total = 0;
  for (const f of M.TOKENS) total += 1 + f.variants.length;
  assert.equal(total, 27, "27 declared tokens (25 tenant-rotated + 2 base-only success tints, CDP-9100 census 2026-06-05)");
  // base token strings are the canonical CSS custom-property names.
  assert.equal(M.TOKENS[0].base, "--primary");
  assert.equal(M.TOKENS[5].base, "--interactive");
});

// =====================================================================================================
// §4.2 — stockBlock + deriveFamily
// =====================================================================================================

test("stockBlock: 27 declarations, single html host rule, every decl !important, exact §4.2 values", () => {
  const css = M.stockBlock();
  assert.ok(css.startsWith("html{") && css.endsWith("}"), "one html{} rule");
  assert.equal(css.indexOf("html{"), css.lastIndexOf("html{"), "exactly one html{ host");
  assert.equal(css.split(" !important;").length - 1, 27, "exactly 27 pinned tokens, all !important");
  for (const decl of [
    "--primary:hsl(192,96%,20%) !important;",
    "--primary-2485:hsl(192,24%,85%) !important;",
    "--secondary:hsl(199,89%,18%) !important;",
    "--tertiary:hsl(154,42%,69%) !important;",
    "--accent:hsl(19,97%,81%) !important;",
    "--base:hsl(206,26%,95%) !important;",
    "--interactive:hsl(201,85%,34%) !important;",
    "--interactive-x96:hsl(201,100%,96%) !important;",
    "--focus:hsl(323,32%,57%) !important;",
    "--error-50:hsl(7,100%,50%) !important;",
    "--success-9532:hsl(172,95%,32%) !important;",
    // the two base-only success tints surfaced by the CDP-9100 census (suffix = saturation+lightness):
    "--success-4566:hsl(172,45%,66%) !important;",
    "--success-3682:hsl(172,36%,82%) !important;",
    "--warning-91:hsl(44,100%,91%) !important;"
  ]) {
    assert.ok(css.includes(decl), "missing " + decl);
  }
});

test("deriveFamily: worked example #1a73e8 -> primary set (literal-base, 82%)", () => {
  assert.deepEqual(plain(M.deriveFamily("primary", "#1a73e8")), {
    "--primary": "hsl(214,82%,51%)",
    "--primary-2485": "hsl(214,82%,85%)",
    "--primary-2491": "hsl(214,82%,91%)",
    "--primary-3468": "hsl(214,82%,68%)",
    "--primary-3495": "hsl(214,82%,95%)"
  });
});

test("deriveFamily: single-token family (accent) emits only the base", () => {
  const out = M.deriveFamily("accent", "#112233"); // #112233 = hsl(210,50%,13%)
  assert.deepEqual(Object.keys(out), ["--accent"]);
  assert.equal(out["--accent"], "hsl(210,50%,13%)");
});

test("deriveFamily: multi-variant family (interactive) keeps picked H/S, variant stock L", () => {
  const out = M.deriveFamily("interactive", "#1a73e8"); // hsl(214,82,51)
  assert.equal(out["--interactive"], "hsl(214,82%,51%)");      // base = picked L
  assert.equal(out["--interactive-24"], "hsl(214,82%,24%)");   // variant stock L 24
  assert.equal(out["--interactive-44"], "hsl(214,82%,44%)");
  assert.equal(out["--interactive-54"], "hsl(214,82%,54%)");
  assert.equal(out["--interactive-82"], "hsl(214,82%,82%)");
  assert.equal(out["--interactive-x96"], "hsl(214,82%,96%)");  // S follows picked, L stays stock
});

test("deriveFamily: hue-only mode keeps stock S/L, rotates hue only (purest native-faithful)", () => {
  const out = M.deriveFamily("primary", "#1a73e8", "hue-only");
  assert.equal(out["--primary"], "hsl(214,96%,20%)");      // stock S96 L20, picked H214
  assert.equal(out["--primary-2485"], "hsl(214,24%,85%)"); // stock S24 L85
});

test("deriveFamily: hue-sat mode = picked H/S, base at stock L (not picked L)", () => {
  const out = M.deriveFamily("primary", "#1a73e8", "hue-sat");
  assert.equal(out["--primary"], "hsl(214,82%,20%)");      // base L = stock 20 (NOT picked 51)
  assert.equal(out["--primary-3468"], "hsl(214,82%,68%)"); // variant stock L 68
});

test("deriveFamily: success family rotates all 4 variants incl. the base-only -4566/-3682 tints", () => {
  const out = M.deriveFamily("success", "#1a73e8"); // hsl(214,82,51)
  assert.equal(out["--success"], "hsl(214,82%,51%)");       // base = picked L
  assert.equal(out["--success-9532"], "hsl(214,82%,32%)");  // variant stock L 32
  assert.equal(out["--success-4566"], "hsl(214,82%,66%)");  // CDP-9100 gap token: stock L 66
  assert.equal(out["--success-3682"], "hsl(214,82%,82%)");  // CDP-9100 gap token: stock L 82
  assert.equal(out["--success-x96"], "hsl(214,82%,96%)");
  assert.equal(Object.keys(out).length, 5, "base + 4 variants — the full success family");
});

test("deriveFamily: bad key/hex -> {}", () => {
  assert.deepEqual(plain(M.deriveFamily("nope", "#1a73e8")), {});
  assert.deepEqual(plain(M.deriveFamily("primary", "zzz")), {});
  assert.deepEqual(plain(M.deriveFamily("primary", null)), {});
});

// =====================================================================================================
// §4.3 — buildCss build order + inert cases + countTokens/validFamilies
// =====================================================================================================

test("buildCss: disable-only === stockBlock(); host html; !important", () => {
  const css = M.buildCss({ themeDisableEnabled: true });
  assert.equal(css, M.stockBlock());
  assert.ok(css.startsWith("html{") && css.includes("!important"));
});

test("buildCss: inert cases all return ''", () => {
  assert.equal(M.buildCss({}), "");
  assert.equal(M.buildCss(null), "");
  assert.equal(M.buildCss({ colorOverrideEnabled: true, colorOverrideValues: {} }), "");
  // values present but the toggle is off -> still inert
  assert.equal(M.buildCss({ colorOverrideEnabled: false, colorOverrideValues: { primary: "#1a73e8" } }), "");
  // invalid hex contributes nothing
  assert.equal(M.buildCss({ colorOverrideEnabled: true, colorOverrideValues: { primary: "bogus" } }), "");
  // unknown family key contributes nothing
  assert.equal(M.buildCss({ colorOverrideEnabled: true, colorOverrideValues: { nope: "#1a73e8" } }), "");
});

test("buildCss: override-only emits just the chosen family, !important, html host", () => {
  const css = M.buildCss({ colorOverrideEnabled: true, colorOverrideValues: { accent: "#112233" } });
  assert.equal(css, "html{--accent:hsl(210,50%,13%) !important;}");
  assert.ok(!css.includes("--primary"));
});

test("buildCss: both-on => stock first, user override after (later-wins source order, §4.3)", () => {
  const css = M.buildCss({ themeDisableEnabled: true, colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } });
  assert.ok(css.startsWith(M.stockBlock()), "disable block emitted first");
  const stockPrimary = css.indexOf("--primary:hsl(192,96%,20%) !important;");
  const userPrimary = css.indexOf("--primary:hsl(214,82%,51%) !important;");
  assert.ok(stockPrimary >= 0 && userPrimary >= 0, "both primaries present");
  assert.ok(userPrimary > stockPrimary, "user override comes after stock (later wins the cascade tie)");
});

test("coverage: overriding all 10 families reaches EVERY one of the 27 theme tokens exactly once", () => {
  // Validates (CDP-9100 live proof: .tmp/palette-audit/all-families-coverage.mjs, 13/13) that the popup's
  // 10 family pickers collectively control the complete theme palette — no token is unreachable.
  const allFamilies = {};
  for (const f of M.TOKENS) allFamilies[f.key] = "#1a73e8";
  const css = M.buildCss({ colorOverrideEnabled: true, colorOverrideValues: allFamilies });
  const expectedNames = [];
  for (const f of M.TOKENS) { expectedNames.push(f.base); for (const v of f.variants) expectedNames.push(f.base + v.suffix); }
  assert.equal(expectedNames.length, 27, "27 theme tokens");
  for (const name of expectedNames) {
    assert.ok(css.includes(name + ":"), `override CSS must declare ${name} (token unreachable otherwise)`);
  }
  // exactly 27 declarations, every one !important — full palette, no stragglers.
  assert.equal(css.split(" !important;").length - 1, 27, "all 27 tokens overridden, all !important");
  assert.equal(M.countTokens({ colorOverrideEnabled: true, colorOverrideValues: allFamilies }), 27);
});

// =====================================================================================================
// NEUTRAL TINT (v3.6.0) — the optional surface/grayscale-ramp control
// =====================================================================================================

test("NEUTRAL_TOKENS: 7 pure-gray ramp tokens, lightness = suffix (base --neutral = white L100)", () => {
  assert.equal(M.NEUTRAL_TOKENS.length, 7);
  const map = {};
  for (const t of M.NEUTRAL_TOKENS) map[t.base] = t.l;
  assert.deepEqual(map, { "--neutral": 100, "--neutral-95": 95, "--neutral-80": 80, "--neutral-52": 52, "--neutral-38": 38, "--neutral-27": 27, "--neutral-20": 20 });
});

test("deriveNeutral: injects picked hue+sat, PRESERVES each token's stock lightness (contrast-safe)", () => {
  const out = M.deriveNeutral("#1a73e8"); // hsl(214,82,51)
  assert.equal(out["--neutral"], "hsl(214,82%,100%)");    // base keeps L100 (still white)
  assert.equal(out["--neutral-95"], "hsl(214,82%,95%)");
  assert.equal(out["--neutral-80"], "hsl(214,82%,80%)");
  assert.equal(out["--neutral-52"], "hsl(214,82%,52%)");
  assert.equal(out["--neutral-20"], "hsl(214,82%,20%)");  // dark text-ish gray keeps L20 -> contrast intact
  assert.equal(Object.keys(out).length, 7);
});

test("deriveNeutral: bad hex -> {}", () => {
  assert.deepEqual(plain(M.deriveNeutral("zzz")), {});
  assert.deepEqual(plain(M.deriveNeutral(null)), {});
});

test("neutralActive/countNeutral: only on + valid hex contributes 7", () => {
  assert.equal(M.neutralActive({ neutralTintEnabled: true, neutralTintHex: "#1a73e8" }), true);
  assert.equal(M.neutralActive({ neutralTintEnabled: false, neutralTintHex: "#1a73e8" }), false);
  assert.equal(M.neutralActive({ neutralTintEnabled: true, neutralTintHex: "nope" }), false);
  assert.equal(M.countNeutral({ neutralTintEnabled: true, neutralTintHex: "#1a73e8" }), 7);
  assert.equal(M.countNeutral({ neutralTintEnabled: true }), 0);
});

test("buildCss: neutral-tint emits 7 --neutral-* decls, all !important; disjoint from theme blocks", () => {
  const css = M.buildCss({ neutralTintEnabled: true, neutralTintHex: "#1a73e8" });
  assert.ok(css.startsWith("html{") && css.includes("--neutral:hsl(214,82%,100%) !important;"));
  assert.equal(css.split(" !important;").length - 1, 7, "exactly 7 neutral tokens");
  for (const n of ["--neutral", "--neutral-95", "--neutral-80", "--neutral-52", "--neutral-38", "--neutral-27", "--neutral-20"]) {
    assert.ok(css.includes(n + ":"), "missing " + n);
  }
  // never touches a brand token
  assert.ok(!css.includes("--primary"));
});

test("buildCss: neutral inert when off / bad hex; composes with disable + override (all three blocks)", () => {
  assert.equal(M.buildCss({ neutralTintEnabled: false, neutralTintHex: "#1a73e8" }), "");
  assert.equal(M.buildCss({ neutralTintEnabled: true, neutralTintHex: "bogus" }), "");
  const all = M.buildCss({ themeDisableEnabled: true, colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" }, neutralTintEnabled: true, neutralTintHex: "#ff0000" });
  assert.ok(all.includes("--primary:hsl(192,96%,20%) !important;"), "disable block present");
  assert.ok(all.includes("--primary:hsl(214,82%,51%) !important;"), "override block present");
  assert.ok(all.includes("--neutral-80:hsl(0,100%,80%) !important;"), "neutral block present (#ff0000 = h0 s100)");
});

test("runtime: neutral-tint-on marker active + neutralTokensPinned=7, leaves brand tokens alone", () => {
  const W = makeWorld({ store: { neutralTintEnabled: true, neutralTintHex: "#1a73e8" } });
  M.install(W);
  const el = W.document.getElementById("kinetic-theme-control");
  assert.ok(el, "style present");
  const m = readMarker(W);
  assert.equal(m.active, true);
  assert.equal(m.neutralTint, true);
  assert.equal(m.neutralTokensPinned, 7);
  assert.equal(m.tokensPinned, 0, "no brand tokens pinned");
  assert.deepEqual(m.families, []);
});

test("validFamilies: only override-on + valid hex, returned in TOKENS order", () => {
  assert.deepEqual(plain(M.validFamilies({})), []);
  assert.deepEqual(plain(M.validFamilies({ colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } })), ["primary"]);
  // off -> none even with values
  assert.deepEqual(plain(M.validFamilies({ colorOverrideEnabled: false, colorOverrideValues: { primary: "#1a73e8" } })), []);
  // ordering follows TOKENS, not insertion
  assert.deepEqual(
    plain(M.validFamilies({ colorOverrideEnabled: true, colorOverrideValues: { accent: "#112233", primary: "#1a73e8" } })),
    ["primary", "accent"]
  );
  // invalid hex filtered out
  assert.deepEqual(
    plain(M.validFamilies({ colorOverrideEnabled: true, colorOverrideValues: { primary: "nope", accent: "#112233" } })),
    ["accent"]
  );
});

test("countTokens: disable=27; +overridden family variant counts; both-on sums", () => {
  assert.equal(M.countTokens({ themeDisableEnabled: true }), 27);
  assert.equal(M.countTokens({ colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }), 5);
  assert.equal(M.countTokens({ colorOverrideEnabled: true, colorOverrideValues: { accent: "#112233" } }), 1);
  assert.equal(M.countTokens({ colorOverrideEnabled: true, colorOverrideValues: { success: "#1a73e8" } }), 5, "success now base+4 variants");
  assert.equal(M.countTokens({ themeDisableEnabled: true, colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }), 32);
  assert.equal(M.countTokens({}), 0);
});

// =====================================================================================================
// runtime (fake DOM) — §4.3 applier, §4.4 marker, §4.6 host gate + live reactivity
// =====================================================================================================

function makeStyleEl() {
  return {
    nodeType: 1, nodeName: "STYLE", id: "", _attrs: {}, textContent: "", parentNode: null,
    setAttribute(k, v) { this._attrs[k] = v; }
  };
}

function makeWorld({ hostname = "centralusdtedu00.epicorsaas.com", store = {} } = {}) {
  const headChildren = [];
  const head = {
    nodeType: 1, nodeName: "HEAD", children: headChildren,
    get lastChild() { return headChildren.length ? headChildren[headChildren.length - 1] : null; },
    appendChild(el) { const ix = headChildren.indexOf(el); if (ix >= 0) { headChildren.splice(ix, 1); } headChildren.push(el); el.parentNode = head; return el; },
    removeChild(el) { const ix = headChildren.indexOf(el); if (ix >= 0) { headChildren.splice(ix, 1); } el.parentNode = null; return el; }
  };
  const documentElement = { nodeName: "HTML", dataset: {} };
  const document = {
    head, documentElement, readyState: "complete",
    createElement() { return makeStyleEl(); },
    getElementById(id) { for (let i = 0; i < headChildren.length; i += 1) { if (headChildren[i].id === id) { return headChildren[i]; } } return null; },
    getElementsByTagName(t) { return String(t).toLowerCase() === "head" ? [head] : []; },
    addEventListener() {}, removeEventListener() {}
  };
  const listeners = [];
  const chrome = {
    storage: {
      local: { get(keys, cb) { const out = {}; for (let i = 0; i < keys.length; i += 1) { if (Object.prototype.hasOwnProperty.call(store, keys[i])) { out[keys[i]] = store[keys[i]]; } } cb(out); } },
      onChanged: { addListener(fn) { listeners.push(fn); }, removeListener(fn) { const ix = listeners.indexOf(fn); if (ix >= 0) { listeners.splice(ix, 1); } } }
    }
  };
  function FakeMO(cb) { this._cb = cb; }
  FakeMO.prototype.observe = function () {};
  FakeMO.prototype.disconnect = function () {};
  const W = {
    document, location: { hostname }, chrome,
    MutationObserver: FakeMO,
    setTimeout(fn) { try { fn(); } catch (e) { /* ignore */ } return 0; }, // synchronous: debounce -> immediate
    clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    _listeners: listeners, _head: head, _docEl: documentElement, _store: store
  };
  return W;
}

function readMarker(W) {
  try { return JSON.parse(W._docEl.dataset.kineticThemeControl || "null"); } catch (e) { return null; }
}

test("runtime: disable-on installs stockBlock <style> + §4.4 marker with the full field shape", () => {
  const W = makeWorld({ store: { themeDisableEnabled: true, colorOverrideEnabled: false, colorOverrideValues: {} } });
  const api = M.install(W);
  assert.ok(api && api.__installed, "installed");
  const el = W.document.getElementById("kinetic-theme-control");
  assert.ok(el, "style element present");
  assert.equal(el._attrs["data-kinetic-grid-fix"], "theme-control");
  assert.equal(el.textContent, M.stockBlock());
  assert.equal(W._head.lastChild, el, "appended last in head");
  const m = readMarker(W);
  // §4.4 marker shape — do not rename these fields (popup + harness read them).
  assert.deepEqual(Object.keys(m).sort(), ["active", "colorOverride", "families", "neutralTint", "neutralTokensPinned", "reasserts", "themeDisabled", "tokensPinned", "version"]);
  assert.equal(m.active, true);
  assert.equal(m.themeDisabled, true);
  assert.equal(m.colorOverride, false);
  assert.equal(m.neutralTint, false);
  assert.equal(m.tokensPinned, 27);
  assert.equal(m.neutralTokensPinned, 0);
  assert.deepEqual(m.families, []);
  assert.equal(typeof m.version, "string");
  assert.equal(typeof m.reasserts, "number");
});

test("runtime: override-on marker lists families + active when >=1 family set", () => {
  const W = makeWorld({ store: { colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8", accent: "#112233" } } });
  M.install(W);
  const m = readMarker(W);
  assert.equal(m.active, true);
  assert.equal(m.themeDisabled, false);
  assert.equal(m.colorOverride, true);
  assert.deepEqual(m.families, ["primary", "accent"]);
  assert.equal(m.tokensPinned, 6); // primary(5) + accent(1)
});

test("runtime: override-on but no valid family -> inert, marker active:false (§4.4 active rule)", () => {
  const W = makeWorld({ store: { colorOverrideEnabled: true, colorOverrideValues: {} } });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-theme-control"), null, "no style when override has no families");
  const m = readMarker(W);
  assert.equal(m.active, false);
  assert.equal(m.colorOverride, true);
  assert.deepEqual(m.families, []);
});

test("runtime: all-off is fully inert (no <style>, marker active:false, 0 tokens)", () => {
  const W = makeWorld({ store: { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} } });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-theme-control"), null, "no style element");
  const m = readMarker(W);
  assert.equal(m.active, false);
  assert.equal(m.tokensPinned, 0);
  assert.deepEqual(m.families, []);
});

test("runtime: unsupported host is inert (no marker, no <style>)", () => {
  const W = makeWorld({ hostname: "evil.example.com", store: { themeDisableEnabled: true } });
  const api = M.install(W);
  assert.ok(api && api.__installed, "runtime can install so it can read custom-host storage");
  assert.equal(W.document.getElementById("kinetic-theme-control"), null);
  assert.equal(W._docEl.dataset.kineticThemeControl, undefined);
});

test("runtime: default epicorsaas host gate accepts; suffix-spoof stays inert", () => {
  const W1 = makeWorld({ hostname: "epicorsaas.com", store: { themeDisableEnabled: true } });
  assert.ok(M.install(W1), "bare apex accepted");
  const W2 = makeWorld({ hostname: "centralusdtadtl17.epicorsaas.com", store: { themeDisableEnabled: true } });
  assert.ok(M.install(W2), "subdomain accepted");
  const W3 = makeWorld({ hostname: "notepicorsaas.com.evil.com", store: { themeDisableEnabled: true } });
  assert.ok(M.install(W3), "runtime installed but must remain inert");
  assert.equal(W3.document.getElementById("kinetic-theme-control"), null, "suffix-spoof gets no style");
  assert.equal(W3._docEl.dataset.kineticThemeControl, undefined, "suffix-spoof gets no marker");
});

test("runtime: user-granted custom host pattern accepts exact and wildcard subdomains", () => {
  const W1 = makeWorld({
    hostname: "kinetic.example.com",
    store: { themeDisableEnabled: true, customHostPatterns: ["*://kinetic.example.com/*"] }
  });
  M.install(W1);
  assert.ok(W1.document.getElementById("kinetic-theme-control"), "exact custom host applies");

  const W2 = makeWorld({
    hostname: "tenant.apps.example.com",
    store: { themeDisableEnabled: true, customHostPatterns: ["*://*.apps.example.com/*"] }
  });
  M.install(W2);
  assert.ok(W2.document.getElementById("kinetic-theme-control"), "wildcard custom host applies");
});

test("runtime: live storage.onChanged rebuild (no reload) + revert removes <style> exactly", () => {
  const store = { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} };
  const W = makeWorld({ store });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-theme-control"), null, "starts inert");

  // User flips override on + picks an accent -> onChanged fires -> live apply (no reload).
  store.colorOverrideEnabled = true;
  store.colorOverrideValues = { accent: "#112233" };
  W._listeners.forEach((fn) => fn({ colorOverrideEnabled: { newValue: true }, colorOverrideValues: { newValue: store.colorOverrideValues } }, "local"));
  const el = W.document.getElementById("kinetic-theme-control");
  assert.ok(el, "style created live");
  assert.equal(el.textContent, "html{--accent:hsl(210,50%,13%) !important;}");
  assert.deepEqual(readMarker(W).families, ["accent"]);

  // User turns everything back off -> element removed, fully reverted.
  store.colorOverrideEnabled = false;
  store.colorOverrideValues = {};
  W._listeners.forEach((fn) => fn({ colorOverrideEnabled: { newValue: false } }, "local"));
  assert.equal(W.document.getElementById("kinetic-theme-control"), null, "reverted: no style element");
  assert.equal(readMarker(W).active, false);
});

test("runtime: storage.onChanged ignores non-local areas and unrelated keys", () => {
  const store = { themeDisableEnabled: false, colorOverrideEnabled: false, colorOverrideValues: {} };
  const W = makeWorld({ store });
  M.install(W);
  // a sync-area change, or a gridFix* change, must not create our <style>.
  store.themeDisableEnabled = true; // even if the store changed, a non-local / unrelated event is a no-op
  W._listeners.forEach((fn) => fn({ themeDisableEnabled: { newValue: true } }, "sync"));
  assert.equal(W.document.getElementById("kinetic-theme-control"), null, "sync-area change ignored");
  W._listeners.forEach((fn) => fn({ gridFixEnabled: { newValue: true } }, "local"));
  assert.equal(W.document.getElementById("kinetic-theme-control"), null, "unrelated key ignored");
});

test("runtime: idempotent install (second call returns same api, single element)", () => {
  const W = makeWorld({ store: { themeDisableEnabled: true } });
  const a = M.install(W);
  const b = M.install(W);
  assert.equal(a, b, "same runtime api");
  assert.equal(W._head.children.filter((c) => c.id === "kinetic-theme-control").length, 1, "no double install");
});

test("runtime: uninstall removes <style> + marker and allows clean re-install", () => {
  const W = makeWorld({ store: { themeDisableEnabled: true } });
  const api = M.install(W);
  api.uninstall();
  assert.equal(W.document.getElementById("kinetic-theme-control"), null);
  assert.equal(W._docEl.dataset.kineticThemeControl, undefined);
  const api2 = M.install(W);
  assert.ok(api2 && api2.__installed, "re-install after uninstall works");
  assert.ok(W.document.getElementById("kinetic-theme-control"), "<style> back after re-install");
});

test("runtime: api.css()/state()/marker() reflect current state", () => {
  const W = makeWorld({ store: { themeDisableEnabled: true } });
  const api = M.install(W);
  assert.equal(api.css(), M.stockBlock());
  assert.equal(api.state().themeDisableEnabled, true);
  assert.equal(api.marker().active, true);
});
