// Unit tests for the BINDING-DIRECTIVE fix (v3, src/grid-revirtualize-fix.js).
//
// The corrector __kineticGridFixHook(bd) runs at the grid-binding directive's rebind() opening, BEFORE
// the original rebind recomputes `grid.view`. The synthetic model mirrors the live-confirmed flow
// (.output/chrome-plugin-grid-fix/leak-mechanism-confirmed.md):
//   - rebind() recomputes grid.view = process(data, state):
//       * grouped (state.group.length>0)        -> view = ALL rows (intended render-all)
//       * ungrouped, state.take a positive number -> view = data.slice(skip, skip+take)  (windowed)
//       * ungrouped, state.take undefined/<=0     -> view = ALL rows  (THE LEAK)
//   - Live, grouping NULLS state.take and ungroup never restores it, so the ungrouped rebind leaks.
//   The fix: on an ungrouped rebind with pathological take, restore state.take (+grid.pageSize) to the
//   captured natural window (80) so the original rebind computes the windowed view.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "grid-revirtualize-fix.js"), "utf8");

function loadModule() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "grid-revirtualize-fix.js" });
  return sandbox.self.__KINETIC_GRID_REVIRT__;
}

// ---- Faithful synthetic binding directive + grid ------------------------------------------------

function makeBinding(total, { take = 80, group = [], skip = 0, epGrid = {} } = {}) {
  const allRows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const grid = { data: allRows, pageSize: take, skip, view: [] };
  const bd = {
    grid,
    // epGrid (the Kinetic wrapper) is the STABLE store that survives bd/grid recreation across a
    // grouping cycle — the natural window is stashed there, not on the (recreated) directive.
    epGrid,
    state: { skip, take, group, sort: [], filter: undefined },
    // original rebind: recompute view from state (Kendo process / Kinetic loader.query semantics)
    rebindOriginal() {
      const s = this.state;
      const grouped = s.group && s.group.length > 0;
      if (grouped) {
        grid.view = allRows.slice(); // grouped view = all rows
      } else if (typeof s.take === "number" && s.take > 0) {
        grid.view = allRows.slice(s.skip || 0, (s.skip || 0) + s.take);
      } else {
        grid.view = allRows.slice(); // ungrouped + no take -> render-all (the leak)
      }
    }
  };
  bd.rebindOriginal();
  return { bd, grid };
}

// Run a rebind THROUGH the hook (the injected call fires before the original rebind).
function rebindWithHook(mod, bd) {
  mod.gridFixHook(bd);
  bd.rebindOriginal();
}

// ---- the core efficacy proof --------------------------------------------------------------------

test("LEAK -> FIX: ungrouped rebind with take=undefined restores the natural window", () => {
  const mod = loadModule();
  const total = 4466;
  const { bd, grid } = makeBinding(total, { take: 80, group: [] });

  // 1) healthy rebind captures the natural window (80) on the STABLE epGrid store, no correction.
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, 80, "healthy view is the 80-row window");
  assert.equal(bd.epGrid.__kgfNaturalTake, 80, "natural window captured on the stable epGrid store");

  // 2) grouping nulls state.take and expands the view to all rows (intended while grouped).
  bd.state.group = [{ field: "Job" }, { field: "Part" }];
  bd.state.take = undefined;
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, total, "grouped view = all rows (untouched)");

  // 3) ungroup: group empties but take stays undefined -> WITHOUT the hook this is the leak.
  bd.state.group = [];
  bd.state.take = undefined;
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, 80, "ungrouped view restored to the windowed 80 (fix worked)");
  assert.equal(bd.state.take, 80, "state.take restored to the natural window");
  assert.equal(grid.pageSize, 80, "grid.pageSize kept consistent for the content directive");
});

test("NO mount mis-fire: a healthy take=80 ungrouped rebind is left untouched (no scroll regression)", () => {
  const mod = loadModule();
  const { bd, grid } = makeBinding(4466, { take: 80, group: [] });
  // mount/scroll rebinds have take=80, grp=0 -> NOT pathological -> the v3 hook must not shrink it.
  rebindWithHook(mod, bd);
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, 80, "window stays at the natural 80, never shrunk to a viewport guess");
  assert.equal(bd.state.take, 80, "state.take untouched");
  // no correction recorded (the marker is only written in a real window; here we just assert no shrink)
});

test("no-op while GROUPED (render-all is intended during grouping)", () => {
  const mod = loadModule();
  const total = 4466;
  const { bd, grid } = makeBinding(total, { take: 80, group: [] });
  rebindWithHook(mod, bd); // capture natural 80

  bd.state.group = [{ field: "Job" }, { field: "Part" }, { field: "Rev" }];
  bd.state.take = undefined;
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, total, "grouped view stays all rows");
  assert.equal(bd.state.take, undefined, "the hook must not restore take while grouped");
});

test("natural window is the LARGEST sane take seen, restored exactly", () => {
  const mod = loadModule();
  const { bd, grid } = makeBinding(4466, { take: 50, group: [] });
  rebindWithHook(mod, bd); // capture 50
  // a later healthy rebind with a bigger window updates the captured natural
  bd.state.take = 80; rebindWithHook(mod, bd);
  assert.equal(bd.epGrid.__kgfNaturalTake, 80);
  // leak -> restored to 80 (the largest natural), not 50
  bd.state.group = []; bd.state.take = undefined; rebindWithHook(mod, bd);
  assert.equal(grid.view.length, 80);
});

test("never captured a natural window -> does NOT restore (safe: no under-windowing)", () => {
  const mod = loadModule();
  // grid that is leaked on first sight: take undefined from the very first rebind -> no natural captured.
  const { bd, grid } = makeBinding(4466, { take: 80 });
  bd.state.take = undefined; // force the leaked-from-start condition (no healthy rebind ever seen)
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, 4466, "without a captured natural, the hook stays out of the way");
  assert.equal(bd.epGrid.__kgfNaturalTake, undefined, "nothing captured");
});

test("RECREATION: natural survives bd/grid recreation via the stable epGrid store", () => {
  const mod = loadModule();
  const total = 4466;
  // The Kinetic wrapper persists across the grouping cycle; bd + grid are recreated.
  const epGrid = {};

  // healthy mount on the ORIGINAL bd/grid -> captures natural=80 on epGrid.
  const first = makeBinding(total, { take: 80, epGrid });
  rebindWithHook(mod, first.bd);
  assert.equal(epGrid.__kgfNaturalTake, 80, "natural stashed on the shared epGrid");

  // grouping recreates bd + grid (a fresh instance, born into the leaked state) but reuses epGrid.
  const recreated = makeBinding(total, { take: undefined, group: [], epGrid });
  // ungroup rebind on the RECREATED binding: take undefined, but epGrid still has natural=80.
  recreated.bd.state.take = undefined;
  rebindWithHook(mod, recreated.bd);
  assert.equal(recreated.grid.view.length, 80, "recreated grid re-windowed using the surviving natural");
  assert.equal(recreated.bd.state.take, 80, "state.take restored from epGrid-stored natural");
});

test("idempotent + stable across repeated group->ungroup cycles", () => {
  const mod = loadModule();
  const total = 4466;
  const { bd, grid } = makeBinding(total, { take: 80, group: [] });
  rebindWithHook(mod, bd); // capture 80
  const windows = [];
  for (let c = 0; c < 5; c += 1) {
    bd.state.group = [{ field: "Job" }, { field: "Part" }]; bd.state.take = undefined; rebindWithHook(mod, bd);
    bd.state.group = []; bd.state.take = undefined; rebindWithHook(mod, bd);
    windows.push(grid.view.length);
  }
  assert.deepEqual(windows, [80, 80, 80, 80, 80], "every cycle re-windows to 80 (no drift)");
});

test("fail-safe: never throws on junk bindings or missing state", () => {
  const mod = loadModule();
  for (const bad of [undefined, null, 5, "x", {}, { state: null }, { state: {} }]) {
    assert.doesNotThrow(() => mod.gridFixHook(bad));
  }
});

// ---- M1 text inject (patchBundleText) -----------------------------------------------------------

const REBIND_SNIPPET =
  "class B{rebind(){this.checkForPrismSkip()||(this.customLoading?this.loader.query(this.epGrid,this.state):super.rebind())}checkForPrismSkip(){return false}applyState(n){}onStateChange(n){this.applyState(n),this.rebind()}}";

test("patchBundleText injects the hook call right after rebind(){, preserving the body", () => {
  const mod = loadModule();
  const r = mod.patchBundleText(REBIND_SNIPPET, { url: "https://x.epicorsaas.com/SaaS950/apps/erp/home/main.437c1f00e1f99d77.js" });
  assert.equal(r.applied, true);
  assert.deepEqual(Array.from(r.anchorsHit), ["rebind-hook"]);
  assert.ok(r.patched.includes("rebind(){try{window.__KINETIC_GRID_FIX_HOOK__&&window.__KINETIC_GRID_FIX_HOOK__(this);}catch(_kgf){}this.checkForPrismSkip()"));
  assert.ok(r.patched.includes("this.checkForPrismSkip()||(this.customLoading?this.loader.query(this.epGrid,this.state):super.rebind())"), "original rebind body preserved");
  assert.ok(r.patched.includes("window.__KINETIC_GRID_FIX_HOOK__=function"));
  assert.ok(r.patched.includes("\"mode\":\"rebind-text\""));
  assert.doesNotThrow(() => new vm.Script(r.patched), "patched snippet parses");
});

test("sanitizeConfig: only scrollBuffer:true yields config; bufferMult bounded to [2,8]", () => {
  const mod = loadModule();
  assert.equal(mod.sanitizeConfig(null), null);
  assert.equal(mod.sanitizeConfig({}), null);
  assert.equal(mod.sanitizeConfig({ scrollBuffer: false }), null);
  const def = mod.sanitizeConfig({ scrollBuffer: true });
  assert.equal(def.scrollBuffer, true); assert.equal(def.bufferMult, 3);
  assert.equal(mod.sanitizeConfig({ scrollBuffer: true, bufferMult: 4 }).bufferMult, 4);
  assert.equal(mod.sanitizeConfig({ scrollBuffer: true, bufferMult: 1 }).bufferMult, 3, "below 2 -> default 3");
  assert.equal(mod.sanitizeConfig({ scrollBuffer: true, bufferMult: 99 }).bufferMult, 8, "clamped to 8");
});

test("patchBundleText bakes the scroll-buffer config global ONLY when opted in", () => {
  const mod = loadModule();
  // Check for the ASSIGNMENT (`=`), not the bare name — the hook's own .toString() comment mentions the
  // global name verbatim, so a name-only check would false-positive on the off case.
  const off = mod.patchBundleText(REBIND_SNIPPET, {});
  assert.ok(!off.patched.includes("__KINETIC_GRID_FIX_CONFIG__="), "no config assignment when buffer off");

  const on = mod.patchBundleText(REBIND_SNIPPET, { config: { scrollBuffer: true, bufferMult: 4 } });
  assert.ok(on.patched.includes('window.__KINETIC_GRID_FIX_CONFIG__={"scrollBuffer":true,"bufferMult":4};'), "config global baked");
  assert.doesNotThrow(() => new vm.Script(on.patched), "patched-with-config parses");
});

test("patchBundleText is idempotent + fail-safe", () => {
  const mod = loadModule();
  const once = mod.patchBundleText(REBIND_SNIPPET, {});
  const twice = mod.patchBundleText(once.patched, {});
  assert.equal(twice.patched, once.patched);
  assert.deepEqual(Array.from(twice.anchorsHit), ["already-injected"]);

  const absent = mod.patchBundleText("function unrelated(){return 1}", {});
  assert.equal(absent.applied, false);
  const dup = "rebind(){this.checkForPrismSkip()a}rebind(){this.checkForPrismSkip()b}";
  assert.equal(mod.patchBundleText(dup, {}).applied, false, "ambiguous anchor refused");
  for (const bad of [undefined, null, "", 123, {}]) {
    assert.equal(mod.patchBundleText(bad, {}).applied, false);
  }
});

test("the APPENDED hook definition, evaluated standalone, fixes a leaked binding", () => {
  const mod = loadModule();
  const r = mod.patchBundleText("x();" + REBIND_SNIPPET, {});
  const tail = r.patched.slice(r.patched.indexOf(";try{window.__KINETIC_GRID_FIX_HOOK__="));
  const fakeWindow = {};
  const sandbox = { window: fakeWindow };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(tail, sandbox, { filename: "appended-hook.js" });
  const hook = fakeWindow.__KINETIC_GRID_FIX_HOOK__;
  assert.equal(typeof hook, "function");

  const { bd, grid } = makeBinding(4466, { take: 80, group: [] });
  hook(bd); bd.rebindOriginal();             // capture 80
  bd.state.group = []; bd.state.take = undefined;
  hook(bd); bd.rebindOriginal();             // leak -> fixed
  assert.equal(grid.view.length, 80);
});

// ---- M1 against the REAL minified binding-directive slices --------------------------------------

const REAL_SLICES = [
  { tag: "437c1f00", file: "binding-slice-437c1f00.js" },
  { tag: "a25a4062", file: "binding-slice-a25a4062.js" }
];

function fixture(name) {
  return fs.readFileSync(path.join(root, "verify", "fixtures", name), "utf8");
}

for (const slice of REAL_SLICES) {
  test(`patchBundleText injects into the real ${slice.tag} binding slice and the result parses`, () => {
    const mod = loadModule();
    const src = fixture(slice.file).split("\n").slice(1).join("\n");
    const r = mod.patchBundleText(src, { bundleHash: slice.tag });
    assert.equal(r.applied, true, "rebind anchor found in the real slice");
    assert.deepEqual(Array.from(r.anchorsHit), ["rebind-hook"]);
    assert.ok(r.patched.includes("rebind(){try{window.__KINETIC_GRID_FIX_HOOK__&&window.__KINETIC_GRID_FIX_HOOK__(this);}catch(_kgf){}this.checkForPrismSkip()"));
    assert.ok(r.patched.includes(".customLoading?this.loader.query(this.epGrid,this.state):super.rebind()"), "original rebind body survives");
    const body = r.patched.replace(/\n;try\{window\.__KINETIC_GRID_FIX_HOOK__=[\s\S]*$/, "");
    assert.doesNotThrow(() => new vm.Script("(class{" + body + "});"), `patched ${slice.tag} slice parses`);
  });
}

// ---- M2 runtime: installBindingWrap finds + wraps the binding directive class --------------------

function makeFakeWindow() {
  const W = {};
  W.Array = Array;
  W.setInterval = () => 0;
  W.clearInterval = () => {};
  return W;
}

test("installBindingWrap marker stays pending until the binding prototype is wrapped", () => {
  const mod = loadModule();
  const W = makeFakeWindow();
  const originalArrayPush = Array.prototype.push;
  try {
    const result = mod.installBindingWrap(W);
    assert.equal(result.applied, false);
    assert.equal(W.__KINETIC_GRID_FIX__.applied, false, "runtime marker must not overclaim");
    assert.equal(W.__KINETIC_GRID_FIX__.trapInstalled, true, "early trap is reported separately");
    assert.equal(W.__KINETIC_GRID_FIX__.prototypeWrapped, false);
    assert.equal(W.__KINETIC_GRID_REVIRT_RESULT__.applied, false);
  } finally {
    W.__KINETIC_GRID_REVIRT_STATE__?.cleanupRuntime();
    assert.equal(Array.prototype.push, originalArrayPush, "global push trap restored");
  }
});

test("installBindingWrap wraps the binding prototype and the wrap runs the hook on rebind", () => {
  const mod = loadModule();
  const W = makeFakeWindow();
  const originalArrayPush = Array.prototype.push;
  W.webpackChunkapp = [];
  try {
    mod.installBindingWrap(W);
    assert.equal(typeof W.__KINETIC_GRID_FIX_HOOK__, "function");

    function factory(module) {
      function Binding() {}
      Binding.prototype.rebind = function () { this.__rebound = (this.__rebound | 0) + 1; };
      Binding.prototype.applyState = function () {};
      Binding.prototype.onStateChange = function () {};
      Binding.prototype.checkForPrismSkip = function () { return false; };
      module.exports = { Binding: Binding };
    }
    W.webpackChunkapp.push([[1], { 9: factory }]);
    const wrapped = W.webpackChunkapp[0][1][9];
    assert.notEqual(wrapped, factory);
    const moduleObj = { exports: {} };
    wrapped(moduleObj, moduleObj.exports, () => {});

    const Binding = moduleObj.exports.Binding;
    assert.ok(Binding.prototype.__kgfBindingWrapped__, "binding prototype wrapped");
    assert.equal(W.__KINETIC_GRID_FIX__.applied, true);
    assert.equal(W.__KINETIC_GRID_FIX__.prototypeWrapped, true);
    assert.equal(W.__KINETIC_GRID_REVIRT_RESULT__.applied, true);

    // a leaked instance: ungrouped + take undefined, with a captured natural -> wrap restores it
    const inst = new Binding();
    inst.grid = { pageSize: 80, view: [] };
    inst.state = { group: [], take: undefined };
    inst.__kgfNaturalTake = 80;
    inst.rebind();
    assert.equal(inst.state.take, 80, "wrapped rebind ran the hook and restored take before the original");
    assert.equal(inst.__rebound, 1, "original rebind still ran");
  } finally {
    W.__KINETIC_GRID_REVIRT_STATE__?.cleanupRuntime();
    assert.equal(Array.prototype.push, originalArrayPush, "global push trap restored");
  }
});

test("installBindingWrap catches a webpack chunk array created after runtime install", () => {
  const mod = loadModule();
  const W = makeFakeWindow();
  const originalArrayPush = Array.prototype.push;
  try {
    mod.installBindingWrap(W);

    function factory(module) {
      function Binding() {}
      Binding.prototype.rebind = function () { this.__rebound = (this.__rebound | 0) + 1; };
      Binding.prototype.applyState = function () {};
      Binding.prototype.onStateChange = function () {};
      module.exports = { Binding: Binding };
    }

    W.webpackChunkapp = [];
    W.webpackChunkapp.push([[1], { 9: factory }]);
    const wrapped = W.webpackChunkapp[0][1][9];
    assert.notEqual(wrapped, factory, "global push trap wrapped the first chunk push");
    const moduleObj = { exports: {} };
    wrapped(moduleObj, moduleObj.exports, () => {});
    assert.ok(moduleObj.exports.Binding.prototype.__kgfBindingWrapped__);
    assert.equal(W.__KINETIC_GRID_FIX__.applied, true);
    assert.ok(W.__KINETIC_GRID_FIX__.anchorsHit.includes("array-push-trap"));
    assert.ok(W.__KINETIC_GRID_FIX__.anchorsHit.includes("binding-prototype-wrap"));
  } finally {
    W.__KINETIC_GRID_REVIRT_STATE__?.cleanupRuntime();
    assert.equal(Array.prototype.push, originalArrayPush, "global push trap restored");
  }
});

test("installBindingWrap is idempotent + fail-safe + teardown restores push", () => {
  const mod = loadModule();
  for (const bad of [undefined, null, 5, "x"]) {
    assert.equal(mod.installBindingWrap(bad).applied, false);
  }
  const W = makeFakeWindow();
  const originalArrayPush = Array.prototype.push;
  W.webpackChunkapp = [];
  const originalPush = W.webpackChunkapp.push;
  const first = mod.installBindingWrap(W);
  const second = mod.installBindingWrap(W);
  assert.equal(second.applied, first.applied);
  assert.notEqual(W.webpackChunkapp.push, originalPush);
  W.__KINETIC_GRID_REVIRT_STATE__.cleanupRuntime();
  assert.equal(W.webpackChunkapp.push, originalPush, "push restored");
  assert.equal(Array.prototype.push, originalArrayPush, "global push restored");
  assert.equal(W.__KINETIC_GRID_REVIRT_STATE__, undefined);
  assert.equal(W.__KINETIC_GRID_REVIRT_RESULT__, undefined);
  assert.equal(W.__KINETIC_GRID_FIX_HOOK__, undefined);
});

// ---- opt-in SCROLL BUFFER (default OFF) ----------------------------------------------------------
// The hook reads window.__KINETIC_GRID_FIX_CONFIG__ (M1 bakes it into the bundle) or the
// <html data-kgf-config> attr (M2 bridge). Load the module in a sandbox that exposes a `window` carrying
// the config so we can drive the buffer path deterministically (loadModule's sandbox has no window, so
// the existing tests above exercise the buffer-OFF path = original behavior).
function loadModuleWithWindow(win) {
  const sandbox = { self: {}, console, window: win };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "grid-revirtualize-fix.js" });
  return sandbox.self.__KINETIC_GRID_REVIRT__;
}

test("BUFFER on: ungrouped healthy take grows to natural*mult (capped), pageSize tracks", () => {
  const win = { __KINETIC_GRID_FIX_CONFIG__: { scrollBuffer: true, bufferMult: 4 } };
  const mod = loadModuleWithWindow(win);
  const { bd, grid } = makeBinding(4466, { take: 80, group: [] });
  rebindWithHook(mod, bd);                     // captures natural=80, then grows to 320
  assert.equal(bd.epGrid.__kgfNaturalTake, 80, "natural window stays the grid's true page size (80)");
  assert.equal(bd.state.take, 320, "take grown to natural*mult (80*4)");
  assert.equal(grid.pageSize, 320, "grid.pageSize tracks the buffered window");
  assert.equal(grid.view.length, 320, "rendered window is the buffered 320 rows");
});

test("BUFFER runaway guard: buffered take never feeds back into natural (stable across rebinds)", () => {
  const win = { __KINETIC_GRID_FIX_CONFIG__: { scrollBuffer: true, bufferMult: 4 } };
  const mod = loadModuleWithWindow(win);
  const { bd } = makeBinding(4466, { take: 80, group: [] });
  for (let i = 0; i < 5; i += 1) { rebindWithHook(mod, bd); }
  assert.equal(bd.epGrid.__kgfNaturalTake, 80, "natural NEVER inflates past the true 80 over many rebinds");
  assert.equal(bd.state.take, 320, "take settles at the buffered 320, not a runaway value");
});

test("BUFFER cap: bufferMult is clamped by MAX_WINDOW (1000)", () => {
  const win = { __KINETIC_GRID_FIX_CONFIG__: { scrollBuffer: true, bufferMult: 100 } };
  const mod = loadModuleWithWindow(win);
  const { bd } = makeBinding(50000, { take: 80, group: [] });
  rebindWithHook(mod, bd);
  assert.equal(bd.state.take, 1000, "buffered take capped at MAX_WINDOW (80*100 -> 1000)");
});

test("BUFFER on ALSO fixes the leak: ungrouped take=undefined restores to the buffered window", () => {
  const win = { __KINETIC_GRID_FIX_CONFIG__: { scrollBuffer: true, bufferMult: 4 } };
  const mod = loadModuleWithWindow(win);
  const total = 4466;
  const { bd, grid } = makeBinding(total, { take: 80, group: [] });
  rebindWithHook(mod, bd);                      // natural=80 -> buffered 320
  bd.state.group = [{ field: "Job" }]; bd.state.take = undefined; rebindWithHook(mod, bd); // grouped: all
  assert.equal(grid.view.length, total, "grouped render-all untouched");
  bd.state.group = []; bd.state.take = undefined; rebindWithHook(mod, bd);                  // ungroup leak
  assert.equal(bd.state.take, 320, "restored to the BUFFERED window, not the bare natural 80");
  assert.equal(grid.view.length, 320, "windowed view at the buffered size (no leak, no shrink)");
});

test("BUFFER stays no-op while GROUPED (render-all intended)", () => {
  const win = { __KINETIC_GRID_FIX_CONFIG__: { scrollBuffer: true, bufferMult: 4 } };
  const mod = loadModuleWithWindow(win);
  const total = 4466;
  const { bd, grid } = makeBinding(total, { take: 80, group: [{ field: "Job" }] });
  rebindWithHook(mod, bd);
  assert.equal(grid.view.length, total, "grouped view = all rows; buffer does not touch it");
});

test("BUFFER off (config absent) is byte-for-byte the original behavior", () => {
  // No window config -> bufferOn false -> healthy take=80 stays 80 (the existing 'no mount mis-fire' rule).
  const mod = loadModuleWithWindow({});
  const { bd, grid } = makeBinding(4466, { take: 80, group: [] });
  rebindWithHook(mod, bd);
  rebindWithHook(mod, bd);
  assert.equal(bd.state.take, 80, "no config -> take untouched at 80");
  assert.equal(grid.view.length, 80, "no config -> window stays natural 80");
});
