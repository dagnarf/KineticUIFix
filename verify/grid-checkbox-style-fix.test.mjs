// Unit tests for the boolean-glyph presentation standardizer (src/grid-checkbox-style-fix.js).
//
// The fix __kineticGridCheckboxStyleFix(W) samples the canonical (modal) presentation of the Kinetic
// boolean glyph (.ep-grid-cell-check.mdi — font-size/line-height/display/justify/align + ENABLED-cell
// color) from the currently-rendered glyphs and injects ONE scoped <style> pinning those values with
// !important, so a glyph that drifts after a group/ungroup re-render is forced back to the column's own
// canonical look. The fake DOM below models getComputedStyle (the un-pinned cascade the fix samples) and
// a minimal head/createElement so the injected stylesheet can be asserted directly — we verify the CSS
// the fix WRITES, not the browser's application of !important (a browser guarantee).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "grid-checkbox-style-fix.js"), "utf8");
const GLYPH = ".ep-grid-cell-check.mdi";

function loadModule() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "grid-checkbox-style-fix.js" });
  return sandbox.self.__KINETIC_GRID_CHECKBOX_FIX___MODULE;
}

const CANON = { fontSize: "24px", lineHeight: "12px", display: "flex", justifyContent: "center", alignItems: "center", color: "rgb(0, 0, 0)" };

function makeStyleEl() {
  return { nodeName: "STYLE", tagName: "STYLE", id: "", _attrs: {}, textContent: "", parentNode: null, setAttribute(k, v) { this._attrs[k] = v; } };
}

function makeHead() {
  const children = [];
  const head = {
    nodeName: "HEAD", tagName: "HEAD", children,
    get lastChild() { return children.length ? children[children.length - 1] : null; },
    appendChild(el) { const ix = children.indexOf(el); if (ix >= 0) { children.splice(ix, 1); } children.push(el); el.parentNode = head; return el; },
    removeChild(el) { const ix = children.indexOf(el); if (ix >= 0) { children.splice(ix, 1); } el.parentNode = null; return el; }
  };
  return head;
}

// cs: a computed-style-ish object; disabled: glyph sits inside .ep-row-rule-disabled.
function makeGlyph(cs, disabled = false) {
  return {
    nodeType: 1, nodeName: "SPAN", className: "ep-grid-cell-check mdi mdi-checkbox-blank-outline ng-star-inserted",
    _cs: { fontSize: cs.fontSize, lineHeight: cs.lineHeight, display: cs.display, justifyContent: cs.justifyContent, alignItems: cs.alignItems, color: cs.color },
    closest(sel) { return (disabled && String(sel).indexOf("ep-row-rule-disabled") >= 0) ? { __disabledHost: true } : null; }
  };
}

function makeWorld({ glyphs = [], hasGrid = true } = {}) {
  const head = makeHead();
  const timers = [];
  const mos = [];
  const document = {
    head, body: { nodeType: 1, nodeName: "BODY" }, documentElement: { nodeName: "HTML" },
    createElement() { return makeStyleEl(); },
    getElementById(id) { return head.children.find((c) => c.id === id) || null; },
    getElementsByTagName(tag) { return tag === "head" ? [head] : []; },
    querySelector(sel) { return (String(sel).indexOf("ep-grid-cell-check") >= 0 && glyphs.length) ? glyphs[0] : null; },
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.indexOf("ep-grid-cell-check") >= 0) {
        if (s.indexOf("k-grid") >= 0 && !hasGrid) { return []; }
        return glyphs;
      }
      return [];
    }
  };
  function FakeMO(cb) { this.cb = cb; mos.push(this); }
  FakeMO.prototype.observe = function () {};
  FakeMO.prototype.disconnect = function () {};
  const W = {
    document,
    getComputedStyle(el) { return el && el._cs ? el._cs : {}; },
    MutationObserver: FakeMO,
    setTimeout: (fn, d) => { timers.push({ fn, d }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    flushTimers() { let g = 0; while (timers.length && g < 200) { g += 1; const t = timers.shift(); try { t.fn(); } catch (e) {} } },
    fireMutation(records) { for (const m of mos) { try { m.cb(records); } catch (e) {} } }
  };
  return { W, head, document, glyphs };
}

function styleText(env) {
  const el = env.document.getElementById("kinetic-grid-checkbox-fix-style");
  return el ? el.textContent : null;
}

test("STYLE_SOURCE is self-contained: new Function-evaluated, installs against a window + arms the marker", () => {
  const mod = loadModule();
  assert.equal(typeof mod.STYLE_SOURCE, "string");
  const fn = new Function("return (" + mod.STYLE_SOURCE + ");")();
  const env = makeWorld({ glyphs: [makeGlyph(CANON), makeGlyph(CANON)] });
  const api = fn(env.W);
  assert.ok(api && api.__installed === true, "embedded source installs (M1 delivery path)");
  assert.equal(env.W.__KINETIC_GRID_CHECKBOX_FIX__, api, "self-registers on the window");
  assert.equal(env.W.__KINETIC_GRID_FIX__.checkboxStyleFixArmed, true, "reflects armed state in the shared marker");
  assert.equal(env.W.__KINETIC_GRID_FIX__.checkboxStyleFixVersion, "1.0.0");
});

test("INJECT: a scoped <style> pinning size + alignment to the sampled canonical is appended to <head>", () => {
  const mod = loadModule();
  const env = makeWorld({ glyphs: [makeGlyph(CANON), makeGlyph(CANON), makeGlyph(CANON)] });
  mod.install(env.W);
  const css = styleText(env);
  assert.ok(css, "style element present in head");
  assert.ok(css.includes(GLYPH + "{font-size:24px !important;"), "pins font-size");
  assert.ok(css.includes("line-height:12px !important;"), "pins line-height");
  assert.ok(css.includes("display:flex !important;"), "pins display");
  assert.ok(css.includes("justify-content:center !important;"), "pins justify-content");
  assert.ok(css.includes("align-items:center !important;"), "pins align-items");
  assert.ok(css.includes(GLYPH + "::before{font-size:inherit !important;"), "pins the ::before icon to inherit the span size");
  // last in head so its !important wins source-order ties
  assert.equal(env.head.lastChild.id, "kinetic-grid-checkbox-fix-style");
});

test("ADAPTIVE: canonical is the MAJORITY presentation, so a drifted minority does not move the pin", () => {
  const mod = loadModule();
  // 8 healthy 24px glyphs + 2 drifted (18px, left-aligned) — modal must remain 24px / center.
  const healthy = [];
  for (let i = 0; i < 8; i += 1) { healthy.push(makeGlyph(CANON)); }
  const drift1 = makeGlyph({ ...CANON, fontSize: "18px", justifyContent: "flex-start" });
  const drift2 = makeGlyph({ ...CANON, fontSize: "18px", justifyContent: "flex-start" });
  const env = makeWorld({ glyphs: [...healthy, drift1, drift2] });
  mod.install(env.W);
  const css = styleText(env);
  assert.ok(css.includes("font-size:24px !important;"), "pins to the majority size, not the drifted 18px");
  assert.ok(css.includes("justify-content:center !important;"), "pins to the majority alignment");
});

test("THEME-SAFE: a uniformly 20px/compact grid pins to ITS OWN value, not a hardcoded 24px", () => {
  const mod = loadModule();
  const compact = { fontSize: "20px", lineHeight: "10px", display: "flex", justifyContent: "center", alignItems: "center", color: "rgb(0, 0, 0)" };
  const glyphs = [makeGlyph(compact), makeGlyph(compact), makeGlyph(compact)];
  const env = makeWorld({ glyphs });
  mod.install(env.W);
  const css = styleText(env);
  assert.ok(css.includes("font-size:20px !important;"), "adapts to the theme's own canonical size");
  assert.ok(!css.includes("font-size:24px"), "does not force the captured default when the grid differs");
});

test("DISABLED-PRESERVING: color is pinned only for ENABLED cells; the :not(.ep-row-rule-disabled) selector excludes greyed cells", () => {
  const mod = loadModule();
  // enabled = black; disabled = grey. Color modal must come from ENABLED only.
  const enabled = [makeGlyph(CANON), makeGlyph(CANON), makeGlyph(CANON), makeGlyph(CANON)];
  const greyA = makeGlyph({ ...CANON, color: "rgb(150, 150, 150)" }, true);
  const greyB = makeGlyph({ ...CANON, color: "rgb(150, 150, 150)" }, true);
  const env = makeWorld({ glyphs: [...enabled, greyA, greyB] });
  mod.install(env.W);
  const css = styleText(env);
  assert.ok(css.includes(".ep-grid-cell:not(.ep-row-rule-disabled) " + GLYPH + "{color:rgb(0, 0, 0) !important;}"), "enabled color pinned via :not(disabled) selector");
  assert.ok(!css.includes("color:rgb(150, 150, 150)"), "the disabled grey is never adopted as the canonical color");
  // size/align rule must NOT carry a color (color is only in the :not() rule)
  const sizeRule = css.slice(css.indexOf(GLYPH + "{"), css.indexOf("}"));
  assert.ok(!sizeRule.includes("color:"), "the unscoped glyph rule does not touch color (greying preserved)");
});

test("DIAGNOSE: counts glyphs deviating from the canonical, broken down by property", () => {
  const mod = loadModule();
  const glyphs = [makeGlyph(CANON), makeGlyph(CANON), makeGlyph(CANON),
    makeGlyph({ ...CANON, fontSize: "30px" }),                 // 1 size deviation
    makeGlyph({ ...CANON, justifyContent: "flex-end" })];      // 1 align deviation
  const env = makeWorld({ glyphs });
  const api = mod.install(env.W);
  const d = api.diagnose();
  assert.equal(d.glyphs, 5);
  assert.equal(d.deviations, 2, "two glyphs deviate from canonical");
  assert.equal(d.byProp.fontSize, 1);
  assert.equal(d.byProp.justify, 1);
});

test("RE-ASSERT: a relevant mutation re-injects the style if it was stripped (SPA re-mount)", () => {
  const mod = loadModule();
  const env = makeWorld({ glyphs: [makeGlyph(CANON), makeGlyph(CANON)] });
  const api = mod.install(env.W);
  const before = api.reasserts();
  assert.ok(styleText(env), "style present after install");
  // Simulate a full re-mount stripping the head style.
  env.head.removeChild(env.document.getElementById("kinetic-grid-checkbox-fix-style"));
  assert.equal(styleText(env), null, "style stripped");
  // A grid-relevant mutation -> debounced re-assert.
  env.W.fireMutation([{ target: { nodeType: 1, nodeName: "TBODY", className: "" }, addedNodes: [], removedNodes: [] }]);
  env.W.flushTimers();
  assert.ok(styleText(env), "style re-injected after the relevant mutation");
  assert.ok(api.reasserts() > before, "reassert counter advanced");
});

test("BOOTSTRAP fallback: no glyphs yet (document_start) injects captured defaults, then refines once glyphs appear", () => {
  const mod = loadModule();
  const env = makeWorld({ glyphs: [] });
  const api = mod.install(env.W);
  let css = styleText(env);
  assert.ok(css.includes("font-size:24px !important;"), "bootstraps with the captured default size");
  assert.equal(api.canonical().sampled, false, "canonical not yet sampled (no glyphs)");
  // Glyphs render at a compact 20px; a relevant mutation should re-derive ONCE and refine the pin.
  env.glyphs.push(makeGlyph({ fontSize: "20px", lineHeight: "10px", display: "flex", justifyContent: "center", alignItems: "center", color: "rgb(0, 0, 0)" }));
  env.W.fireMutation([{ target: { nodeType: 1, nodeName: "TR", className: "" }, addedNodes: [], removedNodes: [] }]);
  env.W.flushTimers();
  css = styleText(env);
  assert.ok(css.includes("font-size:20px !important;"), "refined to the real glyph size once it rendered");
  assert.equal(api.canonical().sampled, true, "canonical now sampled");
});

test("idempotent install + fail-safe on junk", () => {
  const mod = loadModule();
  const env = makeWorld({ glyphs: [makeGlyph(CANON)] });
  const a = mod.install(env.W);
  const b = mod.install(env.W);
  assert.equal(a, b, "second install returns the same api (idempotent)");
  assert.equal(env.head.children.length, 1, "only one style element ever injected");
  for (const bad of [undefined, null, 5, "x", {}]) {
    assert.doesNotThrow(() => mod.install(bad));
    assert.equal(mod.install(bad), null, "junk window -> null, never throws");
  }
});

test("TEARDOWN: uninstall removes the injected style + disconnects, leaving the head clean", () => {
  const mod = loadModule();
  const env = makeWorld({ glyphs: [makeGlyph(CANON)] });
  const api = mod.install(env.W);
  assert.ok(styleText(env), "style present");
  api.uninstall();
  assert.equal(styleText(env), null, "style removed on teardown");
  assert.equal(env.head.children.length, 0, "head clean");
  assert.notEqual(env.W.__KINETIC_GRID_CHECKBOX_FIX__, api, "self-key cleared");
});

test("M1 combine (mirrors background.js): rebind-patch + blank-append + checkbox-append parses and installs all three", () => {
  const checkboxMod = loadModule();
  const load = (rel, key) => { const box = { self: {}, console }; box.globalThis = box.self; vm.runInNewContext(fs.readFileSync(path.join(root, "src", rel), "utf8"), box, { filename: rel }); return box.self[key]; };
  const transform = load("grid-revirtualize-fix.js", "__KINETIC_GRID_REVIRT__");
  const blankMod = load("grid-blank-fix.js", "__KINETIC_GRID_BLANK_FIX___MODULE");

  const REBIND_SNIPPET = "class B{rebind(){this.checkForPrismSkip()||(this.customLoading?this.loader.query(this.epGrid,this.state):super.rebind())}checkForPrismSkip(){return false}}";
  const result = transform.patchBundleText(REBIND_SNIPPET, { url: "https://x.epicorsaas.com/SaaS950/apps/erp/home/main.a25a40629ba315f8.js" });
  let combined = (result && result.applied) ? result.patched : REBIND_SNIPPET;
  if (blankMod && typeof blankMod.WATCHDOG_SOURCE === "string" && combined.indexOf("__KINETIC_GRID_BLANK_FIX__") < 0) {
    combined = combined + ";try{(" + blankMod.WATCHDOG_SOURCE + ")(window);}catch(_kgbf){}";
  }
  if (checkboxMod && typeof checkboxMod.STYLE_SOURCE === "string" && combined.indexOf("__KINETIC_GRID_CHECKBOX_FIX__") < 0) {
    combined = combined + ";try{(" + checkboxMod.STYLE_SOURCE + ")(window);}catch(_kgcf){}";
  }

  assert.ok(combined.includes("__kineticGridBlankWatchdog"), "blank watchdog appended");
  assert.ok(combined.includes("__kineticGridCheckboxStyleFix"), "checkbox standardizer appended");
  assert.doesNotThrow(() => new vm.Script(combined), "combined bundle parses at both append boundaries");

  // A window supporting all three installers.
  const head = makeHead();
  const W = {
    document: {
      body: {}, head, documentElement: {},
      createElement: () => makeStyleEl(),
      getElementById: (id) => head.children.find((c) => c.id === id) || null,
      getElementsByTagName: (t) => (t === "head" ? [head] : []),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    getComputedStyle: () => ({}),
    WeakMap, WeakSet, Date, MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}
  };
  const sandbox = { window: W, console };
  sandbox.globalThis = sandbox;
  assert.doesNotThrow(() => vm.runInNewContext(combined, sandbox, { filename: "combined-bundle.js" }));
  assert.equal(typeof W.__KINETIC_GRID_FIX_HOOK__, "function", "group/ungroup rebind hook installed");
  assert.ok(W.__KINETIC_GRID_BLANK_FIX__ && W.__KINETIC_GRID_BLANK_FIX__.__installed, "blank-fix watchdog installed");
  assert.ok(W.__KINETIC_GRID_CHECKBOX_FIX__ && W.__KINETIC_GRID_CHECKBOX_FIX__.__installed, "checkbox standardizer installed");
  assert.equal(W.__KINETIC_GRID_FIX__.checkboxStyleFixArmed, true, "shared marker reflects all fixes armed");
});
