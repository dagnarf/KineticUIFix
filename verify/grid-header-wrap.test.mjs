// Unit tests for src/grid-header-wrap.js — the "Wrap column headers" feature.
// Covers the pure engine (word split, widest-word measurement, shrink-only width math), the wrap CSS
// shape, the host gate, and the module-export contract. No DOM / no chrome.* needed for the pure layer;
// a tiny fake DOM exercises the install + live storage path the repo way (vm sandbox).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

function loadModule() {
  const src = fs.readFileSync(path.join(root, "src", "grid-header-wrap.js"), "utf8");
  const sandbox = { self: {}, module: { exports: {} }, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "grid-header-wrap.js" });
  // Auto-boot is guarded on root.document, which the bare sandbox lacks -> no install, pure module only.
  return sandbox.module.exports;
}

// ---------------------------------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------------------------------

test("splitWords: collapses whitespace, drops empties, single/multi word", () => {
  const M = loadModule();
  // Array.from re-homes the vm-sandbox (cross-realm) array onto this realm's Array proto so
  // deepStrictEqual compares by structure, not by foreign prototype.
  const split = (s) => Array.from(M.splitWords(s));
  assert.deepEqual(split("Exclude from Cycle Count"), ["Exclude", "from", "Cycle", "Count"]);
  assert.deepEqual(split("  Stock   Value\tPercent "), ["Stock", "Value", "Percent"]);
  assert.deepEqual(split("Code"), ["Code"]);
  assert.deepEqual(split(""), []);
  assert.deepEqual(split(null), []);
});

test("widestWordWidth: returns the max single-word measure, ignores non-finite", () => {
  const M = loadModule();
  const widths = { Exclude: 55, from: 28, Cycle: 40, Count: 42 };
  const measure = (w) => widths[w];
  assert.equal(M.widestWordWidth(["Exclude", "from", "Cycle", "Count"], measure), 55);
  assert.equal(M.widestWordWidth([], measure), 0);
  assert.equal(M.widestWordWidth(["x"], () => NaN), 0);
  assert.equal(M.widestWordWidth(["x"], "not a fn"), 0);
});

test("computeWrapWidth: narrows a multi-word header column to widest word + chrome (shrink only)", () => {
  const M = loadModule();
  // "Exclude from Cycle Count" boolean column: widest word ~55, content (checkbox) ~0, current 229.
  const target = M.computeWrapWidth(
    { words: ["Exclude", "from", "Cycle", "Count"], widestWordPx: 55, contentPx: 0, currentWidth: 229 },
    { chrome: 38, minWidth: 24, threshold: 8, safetyPad: 2 }
  );
  // ceil(max(55,0) + 38 + 2) = 95, which is < 229 - 8 -> narrow to 95.
  assert.equal(target, 95);
});

test("computeWrapWidth: single-word header is never narrowed (wrapping can't help)", () => {
  const M = loadModule();
  assert.equal(
    M.computeWrapWidth({ words: ["Code"], widestWordPx: 30, contentPx: 0, currentWidth: 120 }, {}),
    null
  );
});

test("computeWrapWidth: content wider than the widest word keeps the column (data-driven, not header-driven)", () => {
  const M = loadModule();
  // A multi-word header but the body text is the binding constraint -> target >= current -> no shrink.
  assert.equal(
    M.computeWrapWidth(
      { words: ["Count", "Frequency"], widestWordPx: 60, contentPx: 200, currentWidth: 162 },
      { chrome: 38, threshold: 8 }
    ),
    null,
    "content 200 + chrome dominates current 162 -> would widen, so skip"
  );
});

test("computeWrapWidth: only acts when it frees more than the threshold; never widens", () => {
  const M = loadModule();
  // Target lands within threshold of current -> not worth it.
  assert.equal(
    M.computeWrapWidth({ words: ["Calculate", "Value"], widestWordPx: 80, contentPx: 0, currentWidth: 124 },
      { chrome: 38, threshold: 8, safetyPad: 2 }),
    null,
    "ceil(80+38+2)=120; 120 > 124-8=116 -> within threshold, skip"
  );
  // Clamp to minWidth and still shrink when far below current.
  assert.equal(
    M.computeWrapWidth({ words: ["A", "B"], widestWordPx: 4, contentPx: 0, currentWidth: 229 },
      { chrome: 8, minWidth: 24, threshold: 8, safetyPad: 2 }),
    24,
    "tiny words clamp up to minWidth, still a big shrink from 229"
  );
});

test("computeWrapWidth: guards bad input", () => {
  const M = loadModule();
  assert.equal(M.computeWrapWidth(null, {}), null);
  assert.equal(M.computeWrapWidth({ words: ["A", "B"], widestWordPx: 10, contentPx: 0, currentWidth: 0 }, {}), null,
    "currentWidth 0 (unknown) -> skip");
});

test("computeWrapWidths: index-aligned array of px-or-null", () => {
  const M = loadModule();
  const cols = [
    { words: [], widestWordPx: 0, contentPx: 0, currentWidth: 20 },                 // control col -> null
    { words: ["Code"], widestWordPx: 30, contentPx: 30, currentWidth: 68 },         // single word -> null
    { words: ["Exclude", "from", "Cycle", "Count"], widestWordPx: 55, contentPx: 0, currentWidth: 229 }
  ];
  const out = M.computeWrapWidths(cols, { chrome: 38, threshold: 8, safetyPad: 2 });
  assert.equal(out.length, 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 95);
});

test("wrapCss: emits scoped, !important wrap rules for the Kinetic header title", () => {
  const M = loadModule();
  const css = M.wrapCss();
  assert.match(css, /\.k-grid-header .ep-grid-hdr\.ep-text-truncate/);
  assert.match(css, /white-space:normal !important/);
  assert.match(css, /text-overflow:clip !important/);
  assert.match(css, /overflow-wrap:normal !important/);
  assert.match(css, /hyphens:none !important/);
  assert.match(css, /text-align:center !important/);
  assert.match(css, /justify-content:center !important/);
  assert.doesNotMatch(css, /overflow-wrap:anywhere/);
  // It must not touch the body cells (header-only feature).
  assert.doesNotMatch(css, /k-grid-content/);
});

// ---------------------------------------------------------------------------------------------------
// Host gate (pure)
// ---------------------------------------------------------------------------------------------------

test("hostAllowed: default epicorsaas suffix accepted, spoof rejected, custom pattern honored", () => {
  const M = loadModule();
  const W = (host) => ({ location: { hostname: host } });
  assert.equal(M.hostAllowed(W("centralusdtedu00.epicorsaas.com"), {}), true);
  assert.equal(M.hostAllowed(W("epicorsaas.com"), {}), true);
  assert.equal(M.hostAllowed(W("evil-epicorsaas.com.attacker.test"), {}), false);
  assert.equal(M.hostAllowed(W("tenant.example.com"), { customHostPatterns: ["*://*.example.com/*"] }), true);
  assert.equal(M.hostAllowed(W("tenant.example.com"), { customHostPatterns: [] }), false);
});

// ---------------------------------------------------------------------------------------------------
// Install + live storage (fake DOM)
// ---------------------------------------------------------------------------------------------------

// Minimal DOM + grid scaffold: one .k-grid with a header thead of N ths and two mirrored colgroups whose
// <col> widths we can assert against. Enough surface for install/scan/narrow/restore.
function makeFakeWorld(headers, colWidths) {
  const styleEls = {};
  function mkEl(tag) {
    const children = [];
    const attrs = {};
    const styleObj = {};
    const el = {
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      _tag: tag,
      children,
      childNodes: children,
      className: "",
      id: "",
      textContent: "",
      style: styleObj,
      dataset: {},
      get lastChild() { return children[children.length - 1] || null; },
      get parentNode() { return el._parent || null; },
      setAttribute(n, v) { attrs[n] = String(v); if (n === "id") { el.id = String(v); } },
      getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
      hasAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n); },
      removeAttribute(n) { delete attrs[n]; },
      appendChild(c) { c._parent = el; const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); children.push(c); if (c.id && c._tag === "style") styleEls[c.id] = c; return c; },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c._parent = null; if (c.id && styleEls[c.id] === c) delete styleEls[c.id]; return c; },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { return queryAll(el, sel); },
      closest() { return null; },
    };
    return el;
  }

  function walk(el, fn) {
    fn(el);
    for (const c of el.children) { walk(c, fn); }
  }
  function queryAll(rootEl, sel) {
    const out = [];
    // Support only the selectors this script uses.
    walk(rootEl, (el) => {
      if (el === rootEl) return;
      if (matchSel(el, sel)) { out.push(el); }
    });
    return out;
  }
  function matchSel(el, sel) {
    sel = sel.trim();
    // handle comma OR descendant for the few selectors used
    if (sel === "col") return el._tag === "col";
    if (sel === "colgroup") return el._tag === "colgroup";
    if (sel === "tbody") return el._tag === "tbody";
    if (sel === ".k-grid-header table, .k-grid-table") {
      return (el._tag === "table" && (el.className.includes("k-grid-header-table") || el.className.includes("k-grid-table")));
    }
    if (sel === ".k-grid") return el.className.split(/\s+/).includes("k-grid");
    if (sel === ".k-grid-header thead th") return el._tag === "th";
    if (sel.startsWith(".")) {
      const cls = sel.slice(1).split(".");
      return cls.every((c) => el.className.split(/\s+/).includes(c) || (c === "ep-grid-cell-text" && el._isTitle));
    }
    return false;
  }

  // Build the grid.
  const grid = mkEl("div"); grid.className = "k-grid";
  // header table + colgroup
  const headerTable = mkEl("table"); headerTable.className = "k-grid-header-table";
  const headerCg = mkEl("colgroup");
  const bodyTable = mkEl("table"); bodyTable.className = "k-grid-table";
  const bodyCg = mkEl("colgroup");
  for (const w of colWidths) {
    const c1 = mkEl("col"); c1.style.width = w + "px"; headerCg.appendChild(c1);
    const c2 = mkEl("col"); c2.style.width = w + "px"; bodyCg.appendChild(c2);
  }
  headerTable.appendChild(headerCg);
  bodyTable.appendChild(bodyCg);
  // thead with ths
  const thead = mkEl("thead");
  for (const text of headers) {
    const th = mkEl("th"); th.className = "k-table-th ep-grid-header";
    const title = mkEl("span"); title.className = "ep-grid-cell-text"; title._isTitle = true; title.textContent = text;
    th.appendChild(title);
    thead.appendChild(th);
  }
  headerTable.appendChild(thead);
  // an empty content/tbody (no data rows -> contentPx 0)
  const content = mkEl("div"); content.className = "k-grid-content";
  const tbody = mkEl("tbody"); content.appendChild(tbody);
  grid.appendChild(headerTable);
  grid.appendChild(bodyTable);
  grid.appendChild(content);

  const head = mkEl("head");
  const body = mkEl("body");
  body.appendChild(grid);
  const docEl = mkEl("html"); docEl.dataset = {};
  const D = {
    documentElement: docEl,
    head,
    body,
    createElement: (t) => mkEl(t),
    getElementById: (id) => styleEls[id] || null,
    getElementsByTagName: (t) => (t === "head" ? [head] : []),
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(body, sel); },
  };

  const changeListeners = [];
  const store = {};
  const W = {
    document: D,
    location: { hostname: "centralusdtedu00.epicorsaas.com" },
    getComputedStyle: () => ({ fontStyle: "normal", fontWeight: "400", fontSize: "14px", fontFamily: "sans-serif", paddingLeft: "7px", paddingRight: "7px", borderLeftWidth: "0px", borderRightWidth: "0px" }),
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 2,
    clearInterval: () => {},
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    WeakSet: WeakSet,
    WeakMap: WeakMap,
    chrome: {
      storage: {
        local: {
          get(keys, cb) { const out = {}; for (const k of keys) out[k] = store[k]; cb(out); },
        },
        onChanged: { addListener(fn) { changeListeners.push(fn); }, removeListener() {} },
      },
    },
  };
  // canvas measureText stub: width ~ 7px per char (so "Exclude"=49, full "Exclude from Cycle Count"=168).
  D.createElement = (t) => {
    const el = mkEl(t);
    if (t === "canvas") {
      el.getContext = () => ({ font: "", measureText: (s) => ({ width: String(s).length * 7 }) });
    }
    return el;
  };
  function setStore(patch) {
    const changes = {};
    for (const k of Object.keys(patch)) { changes[k] = { oldValue: store[k], newValue: patch[k] }; store[k] = patch[k]; }
    for (const fn of changeListeners) fn(changes, "local");
  }
  return { W, D, grid, headerCg, bodyCg, setStore, store };
}

test("install + scan (autofit OFF): narrows the long multi-word header column, leaves others", () => {
  const M = loadModule();
  // Columns: control(20, ""), Code(68), "Exclude from Cycle Count"(229).
  const fake = makeFakeWorld(["", "Code", "Exclude from Cycle Count"], [20, 68, 229]);
  fake.store.gridHeaderWrapEnabled = true;
  fake.store.gridAutoSizeEnabled = false;
  const api = M.install(fake.W);
  assert.ok(api, "installed");
  const cols = [...fake.headerCg.children].map((c) => c.style.width);
  // control + Code untouched; the long header column shrank well below 229.
  assert.equal(cols[0], "20px");
  assert.equal(cols[1], "68px");
  const narrowed = parseInt(cols[2], 10);
  assert.ok(narrowed < 229, "Exclude column narrowed from 229, got " + cols[2]);
  // widest word "Exclude" = 7 chars * 7 = 49; + chrome(14+22=36) + safety 2 = ceil(87) -> ~87.
  assert.ok(narrowed <= 100 && narrowed >= 50, "narrowed near widest-word width, got " + narrowed);
  // body colgroup kept in lockstep with header.
  assert.deepEqual([...fake.bodyCg.children].map((c) => c.style.width), cols);
  // wrap <style> injected.
  assert.ok(fake.D.getElementById("kinetic-grid-header-wrap-style"), "wrap style present");
  const marker = api.marker();
  assert.equal(marker.active, true);
  assert.equal(marker.autofitDeferred, false);
});

test("scan defers widths to auto-fit when gridAutoSizeEnabled is on (CSS only, no narrowing)", () => {
  const M = loadModule();
  const fake = makeFakeWorld(["", "Code", "Exclude from Cycle Count"], [20, 68, 229]);
  fake.store.gridHeaderWrapEnabled = true;
  fake.store.gridAutoSizeEnabled = true; // autofit owns widths
  const api = M.install(fake.W);
  // Columns must be UNTOUCHED (deferred to autofit), but the wrap CSS is still injected.
  assert.deepEqual([...fake.headerCg.children].map((c) => c.style.width), ["20px", "68px", "229px"]);
  assert.ok(fake.D.getElementById("kinetic-grid-header-wrap-style"), "wrap style still present");
  assert.equal(api.marker().autofitDeferred, true);
});

test("turning the toggle off restores the original widths and removes the wrap style", () => {
  const M = loadModule();
  const fake = makeFakeWorld(["", "Code", "Exclude from Cycle Count"], [20, 68, 229]);
  fake.store.gridHeaderWrapEnabled = true;
  fake.store.gridAutoSizeEnabled = false;
  M.install(fake.W);
  assert.ok(parseInt(fake.headerCg.children[2].style.width, 10) < 229, "narrowed first");
  // Flip off via storage change.
  fake.setStore({ gridHeaderWrapEnabled: false });
  assert.deepEqual([...fake.headerCg.children].map((c) => c.style.width), ["20px", "68px", "229px"],
    "restored to native widths");
  assert.equal(fake.D.getElementById("kinetic-grid-header-wrap-style"), null, "wrap style removed");
});

test("module export contract", () => {
  const M = loadModule();
  assert.equal(typeof M.version, "string");
  for (const fn of ["splitWords", "widestWordWidth", "computeWrapWidth", "computeWrapWidths", "wrapCss", "hostAllowed", "install"]) {
    assert.equal(typeof M[fn], "function", fn + " exported");
  }
});
