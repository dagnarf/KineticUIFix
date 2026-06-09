// Unit tests for the blank-viewport-after-bulk-load fix (src/grid-blank-fix.js).
//
// The watchdog __kineticGridBlankWatchdog(W) scans virtual grids; when a grid has rendered rows but NONE
// intersect the viewport while scrollTop is near the top (the live bug signature: .k-grid-table is
// translateY(N) for a non-zero data window while scrollTop is ~0, with no scroll event to reconcile), it
// performs a page-crossing scroll nudge then returns to top. The fake grid below models the live-measured
// geometry AND Kendo's response (translateY tracks scrollTop on a scroll), so the correction is exercised
// end-to-end:  screen-y(row i) = contentTop - scrollTop + translateY + i*rowH ; setting scrollTop makes
// Kendo re-page so translateY := scrollTop (row 0 returns to the viewport top).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "grid-blank-fix.js"), "utf8");

function loadModule() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "grid-blank-fix.js" });
  return sandbox.self.__KINETIC_GRID_BLANK_FIX___MODULE;
}

function rectOf(top, height, left = 0, width = 800) {
  return { top, bottom: top + height, left, right: left + width, width, height };
}

// A fake virtual grid + the surrounding document/window the watchdog touches.
function makeWorld({ rendered = 50, rowH = 24, clientH = 921, contentTop = 195, translateY = 0, scrollTop = 0, total = 25000 } = {}) {
  const sc = { scrollTop, translateY };
  const rows = [];
  for (let i = 0; i < rendered; i += 1) {
    rows.push({
      _i: i,
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect() { return rectOf(contentTop - sc.scrollTop + sc.translateY + this._i * rowH, rowH); }
    });
  }
  const tbody = { children: rows, querySelector: () => null, querySelectorAll: () => [] };
  const table = { style: { transform: "translateY(" + sc.translateY + "px)" }, querySelector: () => null, querySelectorAll: () => [] };
  const content = {
    className: "k-grid-content k-virtual-content",
    clientHeight: clientH,
    scrollHeight: total * rowH,
    getBoundingClientRect: () => rectOf(contentTop, clientH),
    querySelector: (s) => (s.indexOf("tbody") >= 0 ? tbody : (s.indexOf("k-grid-table") >= 0 ? table : null))
  };
  Object.defineProperty(content, "scrollTop", {
    configurable: true,
    get() { return sc.scrollTop; },
    // Model Kendo: a scroll re-pages -> translateY tracks scrollTop (row 0 back to the viewport top).
    set(v) { sc.scrollTop = v; sc.translateY = v; table.style.transform = "translateY(" + v + "px)"; }
  });
  const grid = {
    className: "k-grid k-grid-virtual",
    querySelector: (s) => {
      if (s.indexOf("k-grid-content") >= 0 || s.indexOf("k-virtual-content") >= 0) { return content; }
      if (s.indexOf("tbody") >= 0) { return tbody; }
      if (s.indexOf("k-grid-table") >= 0) { return table; }
      return null;
    },
    querySelectorAll: () => []
  };

  const timers = [];
  function FakeMO() {}
  FakeMO.prototype.observe = function () {};
  FakeMO.prototype.disconnect = function () {};

  const W = {
    document: { body: {}, querySelectorAll: (s) => (s === ".k-grid" ? [grid] : []) },
    WeakMap, WeakSet, Date, Math, String,
    MutationObserver: FakeMO,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    flushTimers() {
      let guard = 0;
      while (timers.length && guard < 200) { guard += 1; const t = timers.shift(); try { t.fn(); } catch (e) {} }
    }
  };
  // Force the blank state WITHOUT going through the tracking setter (mirrors the load path that leaves
  // translateY non-zero while scrollTop stayed 0 with no scroll event).
  function forceBlank(ty) { sc.translateY = ty; sc.scrollTop = 0; table.style.transform = "translateY(" + ty + "px)"; }
  function forceHealthy() { sc.translateY = 0; sc.scrollTop = 0; table.style.transform = "translateY(0px)"; }
  return { W, grid, content, tbody, sc, forceBlank, forceHealthy };
}

test("WATCHDOG_SOURCE is self-contained: new Function-evaluated, it installs against a bare window", () => {
  const mod = loadModule();
  assert.equal(typeof mod.WATCHDOG_SOURCE, "string");
  const fn = new Function("return (" + mod.WATCHDOG_SOURCE + ");")();
  const { W } = makeWorld();
  const api = fn(W);
  assert.ok(api && api.__installed === true, "embedded source installs (M1 delivery path)");
  assert.equal(W.__KINETIC_GRID_BLANK_FIX__, api, "self-registers on the window");
  assert.equal(W.__KINETIC_GRID_FIX__.blankFixArmed, true, "reflects armed state in the shared marker");
});

test("DETECT + CORRECT: a blank-misaligned grid is realigned and a correction is recorded", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 0, scrollTop: 0 });
  const api = mod.install(env.W);
  env.W.flushTimers(); // drain the install's initial (healthy) check

  // Reproduce the bug: rows rendered ~8000px below the viewport while scrollTop is 0.
  env.forceBlank(8000);
  const before = api.diagnoseAll();
  assert.equal(before[0].blank, true, "blank state detected");
  assert.equal(before[0].inView, 0, "no rows in the viewport");

  const report = api.check();
  assert.equal(report.blank, 1, "check() flags one blank grid");
  assert.equal(report.corrected, 1);
  env.W.flushTimers(); // run the page-crossing nudge + return-to-top

  const after = api.diagnoseAll();
  assert.equal(after[0].blank, false, "grid realigned after correction");
  assert.ok(after[0].inView > 0, "rows now intersect the viewport");
  assert.equal(after[0].scrollTop, 0, "settled at the top");
  assert.equal(api.corrections(), 1, "exactly one correction recorded");
  assert.equal(env.W.__KINETIC_GRID_FIX__.blankCorrections, 1, "shared marker counts the correction");
  assert.equal(api.log().length, 1, "correction logged");
  assert.ok(api.log()[0].topGap >= 4000, "logged the real (large) top gap");
});

test("NO false positive: a healthy grid at the top is left untouched", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 0, scrollTop: 0 });
  const api = mod.install(env.W);
  env.W.flushTimers();
  const report = api.check();
  assert.equal(report.scanned, 1);
  assert.equal(report.blank, 0, "healthy grid is not flagged blank");
  assert.equal(report.corrected, 0);
  assert.equal(api.corrections(), 0);
});

test("NO false positive: a user scrolled to the middle (rows in view) is left untouched", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 5000, scrollTop: 5000 }); // aligned mid-scroll
  const api = mod.install(env.W);
  env.W.flushTimers();
  const d = api.diagnoseAll()[0];
  assert.equal(d.blank, false);
  assert.ok(d.inView > 0, "mid-scroll rows are visible");
  assert.equal(api.check().corrected, 0, "no correction mid-scroll");
});

test("NO false positive: blank but NOT near top (user scrolled away) is NOT corrected", () => {
  const mod = loadModule();
  // scrollTop far from top with rows off-viewport (a transient during fast scroll) -> must not fire,
  // because we only treat the near-top signature as the bug.
  const env = makeWorld({ translateY: 0, scrollTop: 50000 });
  const api = mod.install(env.W);
  env.W.flushTimers();
  const d = api.diagnoseAll()[0];
  assert.equal(d.blank, false, "scrollTop >= clientH is not the bug signature");
  assert.equal(api.check().corrected, 0);
});

test("idempotent install + fail-safe on junk", () => {
  const mod = loadModule();
  const env = makeWorld();
  const a = mod.install(env.W);
  const b = mod.install(env.W);
  assert.equal(a, b, "second install returns the same api (idempotent)");
  for (const bad of [undefined, null, 5, "x", {}]) {
    assert.doesNotThrow(() => mod.install(bad));
    assert.equal(mod.install(bad), null, "junk window -> null, never throws");
  }
});

test("M1 combine (mirrors background.js): rebind-patch + watchdog-append parses and installs both", () => {
  const blankMod = loadModule();
  // Load the sibling rebind module the same way background.js does (importScripts).
  const revirtSrc = fs.readFileSync(path.join(root, "src", "grid-revirtualize-fix.js"), "utf8");
  const revBox = { self: {}, console };
  revBox.globalThis = revBox.self;
  vm.runInNewContext(revirtSrc, revBox, { filename: "grid-revirtualize-fix.js" });
  const transform = revBox.self.__KINETIC_GRID_REVIRT__;

  const REBIND_SNIPPET =
    "class B{rebind(){this.checkForPrismSkip()||(this.customLoading?this.loader.query(this.epGrid,this.state):super.rebind())}checkForPrismSkip(){return false}}";

  // EXACTLY the background.js handlePausedRequest combine.
  const result = transform.patchBundleText(REBIND_SNIPPET, { url: "https://x.epicorsaas.com/SaaS950/apps/erp/home/main.a25a40629ba315f8.js" });
  const rebindApplied = !!(result && result.applied && typeof result.patched === "string");
  let combined = rebindApplied ? result.patched : REBIND_SNIPPET;
  if (blankMod && typeof blankMod.WATCHDOG_SOURCE === "string" && combined.indexOf("__KINETIC_GRID_BLANK_FIX__") < 0) {
    combined = combined + ";try{(" + blankMod.WATCHDOG_SOURCE + ")(window);}catch(_kgbf){}";
  }

  assert.equal(rebindApplied, true, "rebind anchor patched");
  assert.ok(combined.includes("window.__KINETIC_GRID_FIX_HOOK__=function"), "rebind hook def present");
  assert.ok(combined.includes("__kineticGridBlankWatchdog"), "watchdog installer appended");
  assert.doesNotThrow(() => new vm.Script(combined), "combined bundle parses at the append boundary");

  // Run the combined bundle against a fake window+document; both fixes must self-install.
  const env = makeWorld();
  const sandbox = { window: env.W, console };
  sandbox.globalThis = sandbox;
  // expose the document/timer globals the watchdog reads off `window`
  assert.doesNotThrow(() => vm.runInNewContext(combined, sandbox, { filename: "combined-bundle.js" }));
  assert.equal(typeof env.W.__KINETIC_GRID_FIX_HOOK__, "function", "group/ungroup hook installed");
  assert.ok(env.W.__KINETIC_GRID_BLANK_FIX__ && env.W.__KINETIC_GRID_BLANK_FIX__.__installed, "blank-fix watchdog installed");
});

test("v1.1 STABILITY GATE: a blank that clears within the confirm window is NOT corrected (transient)", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 0, scrollTop: 0 });
  const api = mod.install(env.W);
  env.W.flushTimers();
  env.forceBlank(9000);
  const report = api.check();
  assert.equal(report.blank, 1, "blank seen at check time");
  env.forceHealthy(); // the transient clears before the stability window elapses
  env.W.flushTimers();
  assert.equal(api.corrections(), 0, "no correction — the blank did not persist past the stability gate");
});

test("v1.1 SYMMETRIC: rows rendered ABOVE the viewport at the top are detected + corrected", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 0, scrollTop: 0 });
  const api = mod.install(env.W);
  env.W.flushTimers();
  env.forceBlank(-8000); // rows pushed ABOVE the viewport (negative translate)
  const before = api.diagnoseAll()[0];
  assert.equal(before.blank, true, "rows-above-viewport flagged blank");
  assert.ok(before.topGap < 0, "topGap is negative (above)");
  api.check();
  env.W.flushTimers();
  const after = api.diagnoseAll()[0];
  assert.equal(after.blank, false, "realigned");
  assert.equal(api.corrections(), 1);
});

test("v1.1 DIAGNOSTICS: log carries trigger + topGap; lastCorrection + marker fields populate", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 0, scrollTop: 0 });
  const api = mod.install(env.W);
  env.W.flushTimers();
  env.forceBlank(12000);
  api.check(); // trigger = "manual"
  env.W.flushTimers();
  const log = api.log();
  assert.equal(log.length, 1);
  assert.equal(log[0].trigger, "manual", "log records the trigger source");
  assert.ok(log[0].topGap >= 4000, "log records the topGap magnitude");
  const lc = api.lastCorrection();
  assert.equal(lc.count, 1);
  assert.ok(lc.topGap >= 4000, "lastCorrection exposes the gap");
  assert.equal(env.W.__KINETIC_GRID_FIX__.blankFixVersion, "1.1.0");
  assert.ok(typeof env.W.__KINETIC_GRID_FIX__.lastTopGap === "number", "marker carries lastTopGap for field debugging");
});

test("bounded retries: correction gives up after a few attempts if alignment never sticks", () => {
  const mod = loadModule();
  const env = makeWorld({ translateY: 8000, scrollTop: 0 });
  // Make Kendo UNRESPONSIVE: scrollTop setter does NOT track (simulating a grid that won't recompute).
  Object.defineProperty(env.content, "scrollTop", { get() { return env.sc.scrollTop; }, set() { /* stuck */ }, configurable: true });
  const api = mod.install(env.W);
  env.forceBlank(8000);
  api.check();
  // flushing should terminate (bounded perGrid attempts) rather than loop forever.
  assert.doesNotThrow(() => env.W.flushTimers());
  assert.equal(api.diagnoseAll()[0].blank, true, "still blank (Kendo never responded) but no infinite loop");
});
