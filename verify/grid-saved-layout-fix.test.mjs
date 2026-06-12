// Unit tests for src/grid-saved-layout-fix.js — the initFromSavedLayout filteringMode guard rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "grid-saved-layout-fix.js"), "utf8");
const sandbox = { self: {}, console };
sandbox.globalThis = sandbox.self;
vm.runInNewContext(source, sandbox, { filename: "grid-saved-layout-fix.js" });
const fix = sandbox.self.__KINETIC_GRID_SAVED_LAYOUT_FIX__;

// The live minified shape (main.bd8a10b1401bffd8.js): the comma-expression chain where only the
// expandedFilter operand guards s.panelCardGrid, with arbitrary minified local names.
function brokenChain(layoutVar = "p", stateVar = "s") {
  return layoutVar + "&&(" + stateVar + ".panelCardGrid&&(" + stateVar + ".panelCardGrid.expandedFilter=void 0!==" + layoutVar + ".expandedFilter&&" + layoutVar + ".expandedFilter),"
    + layoutVar + ".filteringMode&&(" + stateVar + ".panelCardGrid.model.filteringMode=" + layoutVar + ".filteringMode),void 0!==" + layoutVar + ".state)";
}

function syntheticBundle(layoutVar = "p", stateVar = "s") {
  return "globalThis.__INIT_STUB__=function(" + stateVar + "," + layoutVar + "){" + brokenChain(layoutVar, stateVar) + "};";
}

test("patchBundleText guards the unique filteringMode restore and reports applied", () => {
  const result = fix.patchBundleText(syntheticBundle(), { url: "main.test.js" });
  assert.equal(result.applied, true);
  assert.equal(result.anchorsHit.join(","), "saved-layout-filtering-mode");
  assert.equal(result.mode, "text");
  assert.ok(result.patched.includes(fix.SITE_MARKER));
  assert.ok(result.patched.includes("savedLayoutFixVersion"));
  assert.ok(result.patched.includes("p.filteringMode&&s.panelCardGrid&&s.panelCardGrid.model&&"), "missing guard inserted");
});

test("anchor matches regardless of the minified local names (back-referenced)", () => {
  const result = fix.patchBundleText(syntheticBundle("Te", "qt"), {});
  assert.equal(result.applied, true);
  assert.ok(result.patched.includes("Te.filteringMode&&qt.panelCardGrid&&qt.panelCardGrid.model&&"));
});

test("anchor refuses mismatched back-reference (different layout locals)", () => {
  // x.filteringMode assigning from y.filteringMode is NOT the broken site shape.
  const src = "x.filteringMode&&(s.panelCardGrid.model.filteringMode=y.filteringMode)";
  const result = fix.patchBundleText(src, {});
  assert.equal(result.applied, false);
  assert.equal(result.patched, src);
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

// ---- functional behavior of the patched chain -------------------------------

function runPatched(stateObj, layoutObj) {
  const result = fix.patchBundleText(syntheticBundle(), {});
  assert.equal(result.applied, true);
  const ctx = { window: {}, globalThis: null, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(result.patched, ctx, { filename: "patched.js" });
  ctx.__INIT_STUB__(stateObj, layoutObj);
  return stateObj;
}

test("grids WITHOUT panelCardGrid survive a saved layout carrying filteringMode (the SQLONFLY defect)", () => {
  const s = {}; // no panelCardGrid — the SQL On The Fly Output grid shape
  assert.doesNotThrow(() => runPatched(s, { filteringMode: "row", state: {} }));
  assert.equal(s.panelCardGrid, undefined, "no stub side effects");
});

test("grids WITH panelCardGrid still receive the filteringMode restore (native semantics kept)", () => {
  const s = { panelCardGrid: { model: {} } };
  runPatched(s, { filteringMode: "menu", expandedFilter: true, state: {} });
  assert.equal(s.panelCardGrid.model.filteringMode, "menu");
  assert.equal(s.panelCardGrid.expandedFilter, true);
});

test("unpatched chain really does throw for the panelCardGrid-less shape (regression sentinel)", () => {
  const ctx = { globalThis: null, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(syntheticBundle(), ctx, { filename: "stock.js" });
  assert.throws(() => ctx.__INIT_STUB__({}, { filteringMode: "row", state: {} }), /panelCardGrid|undefined/);
});
