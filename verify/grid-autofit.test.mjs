// Unit tests for src/grid-autofit.js — the pure column-width engine + dataset signature. DOM/chrome.*-
// free; loads the content script in a vm with a minimal global so the auto-boot guard stays inert.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "src", "grid-autofit.js"), "utf8");

function load() {
  const sandbox = { self: {}, module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

const M = load();

test("module exposes the pure engine and stays inert without document+chrome", () => {
  assert.equal(typeof M.computeColumnWidth, "function");
  assert.equal(typeof M.computeColumnWidths, "function");
  assert.equal(typeof M.clampWidth, "function");
  assert.equal(typeof M.fillToAvailable, "function");
  assert.equal(typeof M.fitKey, "function");
  assert.equal(typeof M.shouldRefit, "function");
  assert.equal(typeof M.densityOptions, "function");
  assert.equal(typeof M.wrappedHeaderOptions, "function");
  assert.equal(typeof M.install, "function");
  assert.equal(typeof M.version, "string");
});

test("clampWidth bounds to [MIN,MAX] and rounds", () => {
  assert.equal(M.clampWidth(5), M.MIN_WIDTH);
  assert.equal(M.clampWidth(M.MAX_WIDTH + 999), M.MAX_WIDTH);
  assert.equal(M.clampWidth(123.6), 124);
  assert.equal(M.clampWidth(Number.NaN), M.MIN_WIDTH);
});

test("computeColumnWidth: body-driven width = max body text + cell padding", () => {
  const w = M.computeColumnWidth({ headerWidth: 10, contentWidths: [40, 80, 60], hasText: true });
  // max body = 80; target = 80 + CELL_PADDING + SAFETY(2); header (10) target is smaller.
  assert.equal(w, Math.ceil(80 + M.CELL_PADDING + 2));
});

test("computeColumnWidth: date-like body cells can reserve a small clip guard", () => {
  const compact = M.computeColumnWidth(
    { headerWidth: 10, contentWidths: [50], hasText: true, bodyExtraPad: M.DATE_TEXT_PAD },
    { cellPadding: 4.2, headerAffordance: 0 }
  );
  assert.equal(compact, Math.ceil(50 + 4.2 + M.DATE_TEXT_PAD + 2));
});

test("computeColumnWidth: header-driven width adds the header affordance", () => {
  const w = M.computeColumnWidth({ headerWidth: 120, contentWidths: [10, 12], hasText: true });
  // header target = 120 + CELL_PADDING + HEADER_AFFORDANCE + SAFETY beats the tiny body.
  assert.equal(w, Math.ceil(120 + M.CELL_PADDING + M.HEADER_AFFORDANCE + 2));
});

test("computeColumnWidth: a column with NO text anywhere is skipped (null) — control/checkbox col", () => {
  assert.equal(M.computeColumnWidth({ headerWidth: 0, contentWidths: [], hasText: false }), null);
  assert.equal(M.computeColumnWidth({ headerWidth: 0, contentWidths: [0, 0], hasText: false }), null);
});

test("computeColumnWidth: oversize content is capped at MAX_WIDTH", () => {
  assert.equal(M.computeColumnWidth({ headerWidth: 0, contentWidths: [99999], hasText: true }), M.MAX_WIDTH);
});

test("computeColumnWidth: bad input -> null", () => {
  assert.equal(M.computeColumnWidth(null), null);
  assert.equal(M.computeColumnWidth(undefined), null);
  assert.equal(M.computeColumnWidth("x"), null);
});

test("computeColumnWidths maps element-wise and preserves skips", () => {
  const out = M.computeColumnWidths([
    { headerWidth: 0, contentWidths: [], hasText: false },     // skip
    { headerWidth: 10, contentWidths: [50], hasText: true }    // fit
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0], null);
  assert.equal(out[1], Math.ceil(50 + M.CELL_PADDING + 2));
  assert.equal(M.computeColumnWidths(null).length, 0);
});

test("fitKey is layout-only: stable across row count / content, changes on column count + viewport", () => {
  const base = { colCount: 11, availableWidth: 1014, firstRowText: "5413 ADDISON" };
  // Row count / content are NOT part of the key -> loading more rows or scrolling keeps the same key.
  assert.equal(M.fitKey(base), M.fitKey({ colCount: 11, availableWidth: 1014, firstRowText: "9999 OTHER" }),
    "different first row (scroll/new data) does NOT change the layout key");
  // Sub-bucket viewport jitter is the same key; a real resize is a different key.
  assert.equal(M.fitKey(base), M.fitKey({ ...base, availableWidth: 1014 + M.WIDTH_BUCKET - 1 }), "sub-bucket width jitter -> same key");
  assert.notEqual(M.fitKey(base), M.fitKey({ ...base, availableWidth: 1618 }), "a real resize changes the key");
  assert.notEqual(M.fitKey(base), M.fitKey({ ...base, colCount: 12 }), "column add/remove changes the key");
  assert.equal(M.fitKey(null), "");
});

test("shouldRefit: first fit, and never without data", () => {
  assert.equal(M.shouldRefit(null, { key: "11|1014", atTop: true, topRow: "A", hasData: true }), true, "never fitted -> fit");
  assert.equal(M.shouldRefit(null, { key: "11|1014", atTop: true, topRow: "A", hasData: false }), false, "no data -> never fit");
});

test("shouldRefit: re-fits on a layout change (resize / column add-remove)", () => {
  const prev = { key: "11|1014", topRow: "A" };
  assert.equal(M.shouldRefit(prev, { key: "11|1618", atTop: true, topRow: "A", hasData: true }), true, "viewport resize");
  assert.equal(M.shouldRefit(prev, { key: "12|1014", atTop: true, topRow: "A", hasData: true }), true, "column change");
});

test("shouldRefit: does NOT re-fit on scroll or on loading more rows (the core requirement)", () => {
  const prev = { key: "11|1014", topRow: "A" };
  // Get-More / append: still at top, same top row, same layout -> hold.
  assert.equal(M.shouldRefit(prev, { key: "11|1014", atTop: true, topRow: "A", hasData: true }), false, "append at top -> hold");
  // Virtual scroll: a different first rendered row, but we are NOT at the top -> it's an artifact, hold.
  assert.equal(M.shouldRefit(prev, { key: "11|1014", atTop: false, topRow: "Z (scrolled)", hasData: true }), false, "mid-scroll -> hold");
});

test("shouldRefit: re-fits on a genuinely new dataset (top row changed while at the top)", () => {
  const prev = { key: "11|1014", topRow: "5413 ADDISON" };
  assert.equal(M.shouldRefit(prev, { key: "11|1014", atTop: true, topRow: "9999 OTHER", hasData: true }), true, "new Search at top -> fit");
  // If the last fit happened while scrolled (topRow unknown), we don't treat an at-top row as a change.
  assert.equal(M.shouldRefit({ key: "11|1014", topRow: null }, { key: "11|1014", atTop: true, topRow: "anything", hasData: true }), false, "no baseline top row -> hold");
});

test("fillToAvailable: distributes surplus proportionally so the total lands exactly on available", () => {
  // flexible 100 + 300 (sum 400) + control 50 = 450; viewport 1000 -> surplus 550.
  const out = M.fillToAvailable([100, null, 300], 50, 1000);
  assert.equal(out[1], null, "control column left untouched");
  assert.equal(out[0] + out[2] + 50, 1000, "flex totals + control fill the viewport exactly");
  assert.ok(out[2] > out[0], "the wider column absorbs more of the surplus (proportional)");
});

test("fillToAvailable: no fill when natural fit already meets or exceeds the viewport", () => {
  assert.deepEqual(M.fillToAvailable([400, 300], 0, 600), [400, 300], "content overflows -> unchanged (h-scroll, no white space)");
  assert.deepEqual(M.fillToAvailable([400, 300], 0, 700), [400, 300], "exact fit -> unchanged");
});

test("fillToAvailable: a sub-FILL_MIN_GAP gap is left alone (no churn on trivial slack)", () => {
  assert.deepEqual(M.fillToAvailable([400, 300], 0, 700 + M.FILL_MIN_GAP), [400, 300]);
});

test("fillToAvailable: bad / empty input is safe", () => {
  assert.equal(M.fillToAvailable(null, 0, 1000).length, 0); // fresh array (vm realm) -> compare length, not deepEqual
  assert.deepEqual(M.fillToAvailable([null, null], 50, 1000), [null, null], "no flexible columns -> unchanged");
  assert.deepEqual(M.fillToAvailable([100, 200], 0, 0), [100, 200], "no available width -> unchanged");
});

// ---- Density slider (information-density lever) -------------------------------------------------

test("clampDensity bounds to [MIN,MAX]; undefined/NaN -> default (no-op)", () => {
  assert.equal(M.clampDensity(0.1), M.DENSITY_MIN);
  assert.equal(M.clampDensity(9), M.DENSITY_MAX);
  assert.equal(M.clampDensity(undefined), M.DENSITY_DEF);
  assert.equal(M.clampDensity(Number.NaN), M.DENSITY_DEF);
  assert.equal(M.clampDensity(0.8), 0.8);
});

test("maxScale is monotonic and equals 1 at density 1", () => {
  assert.equal(M.maxScale(1), 1, "density 1 leaves the cap untouched");
  assert.equal(M.maxScale(M.DENSITY_MIN), 0.5 + 0.5 * M.DENSITY_MIN);
  assert.ok(M.maxScale(0.6) < M.maxScale(1), "denser lowers the cap");
  assert.ok(M.maxScale(1.4) > M.maxScale(1), "roomier raises the cap");
});

test("densityOptions at density 1 with default base reproduces the legacy constants (true no-op)", () => {
  const o = M.densityOptions(1, null);
  assert.equal(o.cellPadding, M.CELL_PADDING);
  assert.equal(o.headerAffordance, M.HEADER_AFFORDANCE);
  assert.equal(o.maxWidth, M.MAX_WIDTH);
  assert.equal(o.minWidth, M.MIN_WIDTH);
  // A column computed with these opts equals the no-opts (legacy) result.
  const col = { headerWidth: 10, contentWidths: [80], hasText: true };
  assert.equal(M.computeColumnWidth(col, o), M.computeColumnWidth(col));
});

test("densityOptions: measured cell chrome overrides the constant (native parity)", () => {
  const o = M.densityOptions(1, { cellPadding: 30, headerAffordance: 40 });
  assert.equal(o.cellPadding, 30, "measured padding flows through");
  assert.equal(o.headerAffordance, 40);
});

test("densityOptions: wrapped-header callers can suppress the header affordance", () => {
  const o = M.densityOptions(0.5, { cellPadding: 8, headerAffordance: 0 });
  assert.equal(o.headerAffordance, 0);
  const noAffordance = M.computeColumnWidth({ headerWidth: 60, contentWidths: [1], hasText: true }, o);
  assert.equal(noAffordance, Math.ceil(60 + 4 + 2), "widest wrapped word + scaled cell padding + safety only");
});

test("wrappedHeaderOptions: suppresses affordance but keeps a header chrome floor for whole-word fit", () => {
  const o = M.wrappedHeaderOptions(0.5, { cellPadding: 4.2, headerAffordance: 22 });
  assert.equal(o.headerAffordance, 0, "no sort/menu affordance in wrapped-header mode");
  assert.equal(o.cellPadding, M.HEADER_WRAP_MIN_CHROME * 0.5, "floor is density-scaled after clamping");
  const uom = M.computeColumnWidth({ headerWidth: 23.23, contentWidths: [12], hasText: true }, o);
  assert.equal(uom, Math.ceil(23.23 + 5 + 2), "dense UOM gets enough rendered header text area");
});

test("densityOptions scales chrome + cap by the factor; denser packs tighter", () => {
  const lo = M.densityOptions(0.5, { cellPadding: 16, headerAffordance: 22 });
  const hi = M.densityOptions(1.5, { cellPadding: 16, headerAffordance: 22 });
  assert.equal(lo.cellPadding, 8, "0.5x padding");
  assert.equal(hi.cellPadding, 24, "1.5x padding");
  assert.ok(lo.maxWidth < M.MAX_WIDTH && hi.maxWidth > M.MAX_WIDTH, "cap tracks density");

  const col = { headerWidth: 0, contentWidths: [120], hasText: true };
  const wLo = M.computeColumnWidth(col, lo);
  const wHi = M.computeColumnWidth(col, hi);
  assert.ok(wLo < wHi, "a denser setting yields a narrower column for the same content");
  // body-driven: 120 + cellPad + safety.
  assert.equal(wLo, Math.ceil(120 + 8 + 2));
  assert.equal(wHi, Math.ceil(120 + 24 + 2));
});

test("density caps a wide outlier column harder when denser", () => {
  const wide = { headerWidth: 0, contentWidths: [900], hasText: true };
  const lo = M.computeColumnWidth(wide, M.densityOptions(0.5, null)); // cap = 600 * 0.75 = 450
  const def = M.computeColumnWidth(wide, M.densityOptions(1, null));  // cap = 600
  assert.equal(lo, Math.round(M.MAX_WIDTH * M.maxScale(0.5)));
  assert.equal(def, M.MAX_WIDTH);
  assert.ok(lo < def, "max-density truncates the runaway column sooner -> more columns fit");
});

test("computeColumnWidths threads opts through to every column", () => {
  const opts = M.densityOptions(0.5, { cellPadding: 10, headerAffordance: 20 });
  const out = M.computeColumnWidths([
    { headerWidth: 0, contentWidths: [], hasText: false },   // skip preserved
    { headerWidth: 0, contentWidths: [100], hasText: true }
  ], opts);
  assert.equal(out[0], null);
  assert.equal(out[1], Math.ceil(100 + opts.cellPadding + 2));
});
