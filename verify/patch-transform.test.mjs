// Track B unit tests for the fix transform (T_B_05).
//
// Covers patchBundleText against: (a) the real 437c1f00 guard slice, (b) the current live
// a25a4062 guard slice, (c) an already-patched input (idempotency no-op), (d) a non-matching
// input (fail-safe no-op), plus fail-safe edge inputs; and installRuntimePatch for idempotency,
// fail-safety, the prototype-wrap cure, and clean teardown.
//
// The module is loaded in a fresh VM context with `self` defined, mirroring the MAIN-world /
// service-worker globals it attaches to.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "patch-transform.js"), "utf8");

function loadTransform() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "patch-transform.js" });
  return sandbox.self.__KINETIC_GRID_FIX_TRANSFORM__;
}

function fixture(name) {
  return fs.readFileSync(path.join(root, "verify", "fixtures", name), "utf8");
}

const GUARD_A_ORIG =
  "this.originalPageSize&&!this.grid.model.isPageSizeCalculated&&this.grid.epGridComponent&&" +
  "(this.grid.model.pageSize=this.grid.epGridComponent.settings.pageSize=this.originalPageSize)";
const GUARD_B_ORIG = "this.originalRowHeight&&(this.grid.model.rowHeight=this.originalRowHeight)";
const TRAILING = "calculateModelRowHeight()"; // must survive the rewrite

const REAL_SLICES = [
  { tag: "437c1f00", file: "guard-slice-437c1f00.js" },
  { tag: "a25a4062 (current live)", file: "guard-slice-a25a4062.js" }
];

for (const slice of REAL_SLICES) {
  test(`patchBundleText applies the unconditional restore on the real ${slice.tag} slice`, () => {
    const transform = loadTransform();
    const src = fixture(slice.file);
    const result = transform.patchBundleText(src, {
      url: "https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home/main." + slice.tag + ".js",
      bundleHash: slice.tag
    });

    assert.equal(result.applied, true);
    assert.equal(result.mode, "text");
    assert.deepEqual(Array.from(result.anchorsHit), ["pageSizeRestore", "rowHeightRestore"]);

    // Both original guard forms are gone (rewritten to unconditional restores).
    assert.ok(!result.patched.includes(GUARD_A_ORIG), "guard A original form should be removed");
    assert.ok(!result.patched.includes(GUARD_B_ORIG), "guard B original form should be removed");

    // The cure is present: pageSize restore no longer references isPageSizeCalculated, and
    // rowHeight is restored unconditionally with a positive fallback.
    assert.ok(result.patched.includes("/*KGFv1:pageSize*/"));
    assert.ok(result.patched.includes("/*KGFv1:rowHeight*/"));
    assert.ok(result.patched.includes("(this.grid.model.rowHeight=this.originalRowHeight||this.grid.model.rowHeight||24)"));

    // The trailing late-fallback call is preserved (we only touched the two guards).
    assert.ok(result.patched.includes(TRAILING), "calculateModelRowHeight() must remain intact");

    // The §3 page marker is appended with the mode flag.
    assert.ok(result.patched.includes("window.__KINETIC_GRID_FIX__"));
    assert.ok(result.patched.includes("\"mode\":\"text\""));
  });
}

test("patchBundleText coerces rowHeight at the rowHeightService construction (the v2 load-bearing fix)", () => {
  const transform = loadTransform();
  const src = fixture("rhsvc-slice-437c1f00.js");
  const result = transform.patchBundleText(src, { bundleHash: "437c1f00" });

  assert.equal(result.applied, true);
  assert.deepEqual(Array.from(result.anchorsHit), ["rowHeightServiceRebuild"]);
  // The construction now guards rowHeight with a positive default so the offset table is never NaN.
  assert.ok(result.patched.includes("(this.total,this.rowHeight||/*KGFv2:rhsvc*/24,this.detailRowHeight)"));
  // The original (unguarded) construction form is gone.
  assert.ok(!result.patched.includes("(this.total,this.rowHeight,this.detailRowHeight)"));
  // totalHeight() call (immediately after) is preserved — we only touched the constructor args.
  assert.ok(result.patched.includes("this.rowHeightService.totalHeight()"));

  // Idempotent: re-running is an unchanged no-op (marker already present).
  const twice = transform.patchBundleText(result.patched, { bundleHash: "437c1f00" });
  assert.equal(twice.patched, result.patched);
  assert.deepEqual(Array.from(twice.anchorsHit), ["already-marked"]);
});

test("patchBundleText preserves everything except the two guard sites (surgical diff)", () => {
  const transform = loadTransform();
  const src = fixture("guard-slice-437c1f00.js");
  const result = transform.patchBundleText(src, { bundleHash: "437c1f00" });

  // Reconstruct the source minus our additions and assert it equals the original input — proves
  // the only changes are the two guard rewrites and the appended marker.
  let reverted = result.patched
    .replace("/*KGFv1:pageSize*/this.grid.epGridComponent&&(this.grid.model.pageSize=this.grid.epGridComponent.settings.pageSize=this.originalPageSize||this.grid.model.pageSize||100)", GUARD_A_ORIG)
    .replace("/*KGFv1:rowHeight*/(this.grid.model.rowHeight=this.originalRowHeight||this.grid.model.rowHeight||24)", GUARD_B_ORIG);
  // Strip the appended marker tail (everything from the first appended newline+marker).
  const markerIdx = reverted.indexOf("\n;window.__KINETIC_GRID_FIX__=");
  assert.ok(markerIdx >= 0, "marker tail must be appended");
  reverted = reverted.slice(0, markerIdx);
  assert.equal(reverted, src);
});

test("patchBundleText is idempotent (already-patched input is an unchanged no-op)", () => {
  const transform = loadTransform();
  const src = fixture("guard-slice-437c1f00.js");
  const once = transform.patchBundleText(src, { bundleHash: "437c1f00" });
  const twice = transform.patchBundleText(once.patched, { bundleHash: "437c1f00" });

  assert.equal(twice.applied, true);
  assert.equal(twice.patched, once.patched, "re-running must not change already-patched text");
  assert.deepEqual(Array.from(twice.anchorsHit), ["already-marked"]);
});

test("patchBundleText is fail-safe on a non-matching bundle (no-op, unchanged)", () => {
  const transform = loadTransform();
  const src = "function unrelated(){return 1;}";
  const result = transform.patchBundleText(src, {
    url: "https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home/main.nomatch.js"
  });

  assert.equal(result.applied, false);
  assert.equal(result.patched, src);
  assert.deepEqual(Array.from(result.anchorsHit), []);
  assert.equal(result.mode, "text");
});

test("patchBundleText is fail-safe on degenerate inputs (never throws)", () => {
  const transform = loadTransform();
  for (const bad of [undefined, null, "", 123, {}]) {
    const result = transform.patchBundleText(bad, {});
    assert.equal(result.applied, false);
    assert.equal(result.mode, "text");
    assert.deepEqual(Array.from(result.anchorsHit), []);
  }
});

test("patchBundleText only rewrites when the anchor occurs exactly once (refuses ambiguity)", () => {
  const transform = loadTransform();
  // Two copies of guard B -> ambiguous -> refuse to touch that site; guard A absent too.
  const src = GUARD_B_ORIG + ";" + GUARD_B_ORIG + ";";
  const result = transform.patchBundleText(src, {});
  assert.equal(result.applied, false);
  assert.equal(result.patched, src);
});

// --- installRuntimePatch ---------------------------------------------------

function makeFakeWindow() {
  const W = {};
  W.setInterval = () => 0;
  W.clearInterval = () => {};
  W.setTimeout = () => 0;
  W.clearTimeout = () => {};
  return W;
}

test("installRuntimePatch is fail-safe on a junk window", () => {
  const transform = loadTransform();
  for (const bad of [undefined, null, 5, "x"]) {
    const r = transform.installRuntimePatch(bad);
    assert.equal(r.applied, false);
    assert.equal(r.mode, "runtime");
    assert.deepEqual(Array.from(r.anchorsHit), []);
  }
});

test("installRuntimePatch is idempotent (second call does not re-install)", () => {
  const transform = loadTransform();
  const W = makeFakeWindow();
  const first = transform.installRuntimePatch(W);
  const second = transform.installRuntimePatch(W);
  assert.equal(second.mode, "runtime");
  assert.equal(second.applied, first.applied);
  // The runtime state object persists (single install).
  assert.ok(W.__KINETIC_GRID_FIX_RUNTIME_STATE__);
});

test("installRuntimePatch wraps the provider prototype and applies the same cure on registration", () => {
  const transform = loadTransform();
  const W = makeFakeWindow();
  // Pre-existing webpack chunk container, empty so install attaches before our module registers.
  W.webpackChunkapp = [];

  transform.installRuntimePatch(W);

  // A module factory whose source carries the guarded-restore signature. Its exported class has
  // the buggy guarded adjustVirtualScrolling (leaves rowHeight undefined).
  function factory(module) {
    function Provider() {}
    Provider.prototype.hasGroups = function () { return false; };
    Provider.prototype.adjustVirtualScrolling = function () {
      // Emulate the guarded restore: scrollable comes back, but originalRowHeight is undefined
      // so model.rowHeight stays undefined (the bug).
      this.grid.model.scrollable = "virtual";
      var ignore = this.originalRowHeight; // signature token for the factory matcher
      void ignore;
    };
    module.exports = { Provider: Provider };
  }

  // webpack chunk shape: [[chunkIds], {moduleId: factory}]
  W.webpackChunkapp.push([[1], { 42: factory }]);

  // Simulate webpack evaluating the (now-wrapped) factory.
  const wrappedFactory = W.webpackChunkapp[0][1][42];
  assert.notEqual(wrappedFactory, factory, "factory should have been wrapped");
  const moduleObj = { exports: {} };
  wrappedFactory(moduleObj, moduleObj.exports, () => {});

  const Provider = moduleObj.exports.Provider;
  const inst = new Provider();
  inst.grid = { model: {}, epGridComponent: { settings: {}, calculateModelRowHeight() {} } };
  inst.originalRowHeight = undefined;
  inst.originalPageSize = 50;

  inst.adjustVirtualScrolling();

  // The cure ran after the original guarded restore: rowHeight is now a positive number and
  // pageSize was restored from originalPageSize despite the original guard.
  assert.equal(inst.grid.model.rowHeight, 24, "rowHeight must be forced to the 24px fallback");
  assert.equal(inst.grid.model.pageSize, 50, "pageSize must be restored from originalPageSize");
  assert.equal(inst.grid.epGridComponent.settings.pageSize, 50);

  // The §3 page marker is set in runtime mode.
  assert.ok(W.__KINETIC_GRID_FIX__);
  assert.equal(W.__KINETIC_GRID_FIX__.mode, "runtime");
  assert.equal(W.__KINETIC_GRID_FIX__.applied, true);
  assert.ok(W.__KINETIC_GRID_FIX__.anchorsHit.includes("provider-prototype-wrap"));
});

test("installRuntimePatch teardown restores the original push and clears the marker", () => {
  const transform = loadTransform();
  const W = makeFakeWindow();
  W.webpackChunkapp = [];
  const originalPush = W.webpackChunkapp.push;

  transform.installRuntimePatch(W);
  assert.notEqual(W.webpackChunkapp.push, originalPush, "push should be wrapped");

  W.__KINETIC_GRID_FIX_RUNTIME_STATE__.cleanupRuntime();

  assert.equal(W.webpackChunkapp.push, originalPush, "push must be restored");
  assert.equal(W.__KINETIC_GRID_FIX_RUNTIME_STATE__, undefined, "runtime state cleared");
  assert.equal(W.__KINETIC_GRID_FIX__, undefined, "runtime marker cleared");
});

test("the patched real bundle slices remain syntactically valid (wrapped)", () => {
  const transform = loadTransform();
  for (const slice of REAL_SLICES) {
    const src = fixture(slice.file);
    const result = transform.patchBundleText(src, { bundleHash: slice.tag });
    // The slice is a run of class-method definitions, so strip the appended marker tail and wrap
    // it in a class body before syntax-checking (the guards live inside a class method).
    const body = result.patched.replace(/\n;window\.__KINETIC_GRID_FIX__=[\s\S]*$/, "");
    const wrapped = "(class{" + body + "});";
    assert.doesNotThrow(() => new vm.Script(wrapped), `patched ${slice.tag} slice must parse`);
  }
});
