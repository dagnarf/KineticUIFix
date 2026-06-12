// Unit tests for src/grid-group-data-fix.js — the grouping-draws-an-empty-grid getter rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "grid-group-data-fix.js"), "utf8");
const sandbox = { self: {}, console };
sandbox.globalThis = sandbox.self;
vm.runInNewContext(source, sandbox, { filename: "grid-group-data-fix.js" });
const fix = sandbox.self.__KINETIC_GRID_GROUP_DATA_FIX__;

const ANCHOR = fix.ANCHOR;

// A miniature class body hosting the real anchor so the patched getter can be evaluated functionally.
function syntheticBundle() {
  return "class EpGridStub{" +
    "constructor(){this.model={};this.originalData=void 0;this._filterCalls=0;}" +
    "applyDataFilterToGroupBindingSource(t){this._filterCalls+=1;return t;}" +
    ANCHOR +
    "}globalThis.__EP_GRID_STUB__=EpGridStub;";
}

test("patchBundleText rewrites the unique anchor and reports applied", () => {
  const result = fix.patchBundleText(syntheticBundle(), { url: "main.test.js" });
  assert.equal(result.applied, true);
  assert.equal(result.anchorsHit.join(","), "group-binding-data");
  assert.equal(result.mode, "text");
  assert.ok(result.patched.includes(fix.SITE_MARKER));
  assert.ok(result.patched.includes("groupDataFixVersion"));
  assert.ok(!result.patched.includes(ANCHOR), "original getter body must be replaced");
});

test("idempotent: a second pass is a no-op that still reports applied", () => {
  const first = fix.patchBundleText(syntheticBundle(), {});
  const second = fix.patchBundleText(first.patched, {});
  assert.equal(second.applied, true);
  assert.equal(second.anchorsHit.join(","), "already-patched");
  assert.equal(second.patched, first.patched);
});

test("fail-safe: missing anchor leaves the source untouched", () => {
  const src = "function unrelated(){return 1;}";
  const result = fix.patchBundleText(src, {});
  assert.equal(result.applied, false);
  assert.equal(result.patched, src);
});

test("fail-safe: ambiguous (duplicated) anchor refuses to rewrite", () => {
  const src = syntheticBundle() + ";" + syntheticBundle();
  const result = fix.patchBundleText(src, {});
  assert.equal(result.applied, false);
  assert.equal(result.patched, src);
});

test("fail-safe: non-string input", () => {
  for (const bad of [undefined, null, 42, {}]) {
    const result = fix.patchBundleText(bad, {});
    assert.equal(result.applied, false);
  }
});

// ---- functional behavior of the patched getter -----------------------------

function makePatchedInstance() {
  const result = fix.patchBundleText(syntheticBundle(), {});
  assert.equal(result.applied, true);
  // The tail references window; provide one for the eval scope.
  globalThis.window = globalThis.window || globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(result.patched);
  const instance = new globalThis.__EP_GRID_STUB__();
  return instance;
}

test("native sources still win when non-empty (byte-for-byte semantics)", () => {
  const g = makePatchedInstance();
  g.model.groupBindingSourceData = [{ id: 1 }];
  g.model.data = [{ id: 9 }];
  assert.deepEqual(g.groupBindingData, [{ id: 1 }]);
});

test("epBinding grids fall back to the DataView rows (the live EQMT1030 break)", () => {
  const g = makePatchedInstance();
  // Native chain: sourceData undefined, originalData undefined, model.data EMPTY (truthy []).
  g.model.data = [];
  g.model.epBinding = "TheView";
  Object.defineProperty(g, "epbinding", { get() { return this.model.epBinding; } });
  Object.defineProperty(g, "currentViewData", { get() { return [{ Cust: "A" }, { Cust: "B" }]; } });
  assert.deepEqual(g.groupBindingData, [{ Cust: "A" }, { Cust: "B" }]);
  assert.equal(globalThis.window.__KINETIC_GRID_FIX__.groupDataSourceIndex, 3);
  assert.equal(globalThis.window.__KINETIC_GRID_FIX__.groupDataLen, 2);
});

test("loader grids fall back to the last loader result", () => {
  const g = makePatchedInstance();
  g.gridBindingDirective = { loaderResult: { data: [{ r: 1 }], total: 100 } };
  assert.deepEqual(g.groupBindingData, [{ r: 1 }]);
});

test("nothing available -> original empty-array semantics, never throws", () => {
  const g = makePatchedInstance();
  assert.deepEqual(g.groupBindingData, []);
  assert.equal(g._filterCalls > 0, true, "still routed through applyDataFilterToGroupBindingSource");
});

test("a throwing fallback source degrades to native behavior instead of throwing", () => {
  const g = makePatchedInstance();
  Object.defineProperty(g, "epbinding", { get() { throw new Error("boom"); } });
  g.model.data = [{ id: 5 }];
  assert.deepEqual(g.groupBindingData, [{ id: 5 }]);
});

test("patch-time tail stamps groupDataFixVersion on window", () => {
  makePatchedInstance();
  assert.equal(globalThis.window.__KINETIC_GRID_FIX__.groupDataFixVersion, fix.version);
});
