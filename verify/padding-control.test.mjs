// padding-control.test.mjs — unit suite for src/padding-control.js (the per-component-family UI
// density feature). Mirrors theme-control.test.mjs: load the module the repo way (fs.readFileSync + vm
// into a `self` sandbox; module global is self.__KINETIC_PADDING_CONTROL___MODULE), exercise the PURE
// engine (FAMILIES integrity, clamp/round, buildCss scaling + inert cases, activeAdjustments, ruleCount),
// then the runtime against a fake DOM that implements the <style>.textContent mechanism the real injector
// uses. The live cascade is proven separately by verify/padding-live-harness.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "padding-control.js"), "utf8");

function loadModule() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(source, sandbox, { filename: "padding-control.js" });
  return sandbox.self.__KINETIC_PADDING_CONTROL___MODULE;
}

const M = loadModule();
const plain = (o) => JSON.parse(JSON.stringify(o));
const cd = (componentDensity) => ({ componentDensity });

// =====================================================================================================
// FAMILIES integrity (the single source of truth, mirrored verbatim in popup.js)
// =====================================================================================================

test("FAMILIES: 10 families with the expected keys", () => {
  assert.equal(M.FAMILIES.length, 10);
  assert.equal(M.FAMILIES.map((f) => f.key).join(","), "grid,button,textbox,dropdown,page,tabs,label,tag,card,tree");
  for (const f of M.FAMILIES) {
    assert.equal(typeof f.label, "string");
    assert.ok(Array.isArray(f.dims) && f.dims.length > 0, f.key + " has dims");
  }
});

test("FAMILIES: every dim has a sane range (min<def<=max, def 1, step>0) and rule table", () => {
  for (const f of M.FAMILIES) {
    for (const d of f.dims) {
      assert.equal(typeof d.label, "string", f.key + "." + d.key + " label");
      assert.equal(d.def, 1, f.key + "." + d.key + " default factor is 1 (stock)");
      assert.ok(d.min < d.def && d.def <= d.max, f.key + "." + d.key + " range brackets default");
      assert.ok(d.step > 0, f.key + "." + d.key + " positive step");
      assert.ok(Array.isArray(d.rules) && d.rules.length > 0, f.key + "." + d.key + " has rules");
      for (const r of d.rules) {
        assert.equal(typeof r.sel, "string", "rule selector is a string");
        assert.ok(r.sel.length > 0, "rule selector non-empty");
        assert.ok(Array.isArray(r.props) && r.props.length > 0, "rule has props");
        for (const p of r.props) {
          assert.equal(typeof p.name, "string");
          assert.equal(typeof p.base, "number");
          assert.ok(isFinite(p.base), p.name + " base is a finite number");
        }
      }
    }
  }
});

test("FAMILIES: dropdown 'height' coordinates the value-text container (anti-clip)", () => {
  const dd = M.FAMILIES.find((f) => f.key === "dropdown");
  const h = dd.dims.find((d) => d.key === "height");
  const sels = h.rules.map((r) => r.sel).join(" | ");
  assert.ok(sels.indexOf(".k-input-value-text") >= 0, "value-text scaled with the field (prevents value clipping)");
  const vt = h.rules.find((r) => r.sel.indexOf(".k-input-value-text") >= 0);
  assert.ok(vt.sel.indexOf(".k-picker") >= 0, "value-text rule is scoped to closed picker fields, not detached popups");
  assert.ok(vt.props.some((p) => p.name === "padding-top"), "value-text padding-top scaled too");
});

test("FAMILIES: text fields are scoped away from comboboxes/pickers", () => {
  const tb = M.FAMILIES.find((f) => f.key === "textbox");
  for (const d of tb.dims) {
    for (const r of d.rules) {
      assert.ok(r.sel.indexOf(".k-combobox") < 0 && r.sel.indexOf(".k-dropdownlist") < 0 && r.sel.indexOf(".k-picker") < 0,
        "textbox selector must not leak into dropdowns: " + r.sel);
    }
  }
});

// =====================================================================================================
// pure helpers — clampFactor / isDefaultFactor / round2
// =====================================================================================================

test("clampFactor: clamps into [min,max] per family+dim; null for unknown/NaN", () => {
  assert.equal(M.clampFactor("grid", "rowHeight", 9), 1.8, "grid rowHeight max 1.8");
  assert.equal(M.clampFactor("grid", "rowHeight", 0.1), 0.6, "grid rowHeight min 0.6");
  assert.equal(M.clampFactor("grid", "rowHeight", 1.3), 1.3, "in range unchanged");
  assert.equal(M.clampFactor("button", "font", 9), 1.6, "button font max 1.6");
  assert.equal(M.clampFactor("dropdown", "height", 0.1), 0.7, "dropdown height min 0.7");
  assert.equal(M.clampFactor("tag", "height", 0.1), 0.65, "tag height min 0.65");
  assert.equal(M.clampFactor("nope", "x", 1), null, "unknown family -> null");
  assert.equal(M.clampFactor("grid", "nope", 1), null, "unknown dim -> null");
  assert.equal(M.clampFactor("grid", "rowHeight", "x"), null, "NaN -> null");
});

test("isDefaultFactor: true only at the dim default (1)", () => {
  assert.equal(M.isDefaultFactor("grid", "rowHeight", 1), true);
  assert.equal(M.isDefaultFactor("grid", "rowHeight", 1.2), false);
  assert.equal(M.isDefaultFactor("nope", "x", 1), false);
});

test("round2: rounds to 2dp and stringifies without float dust", () => {
  assert.equal(M.round2(24 * 1.5), "36");
  assert.equal(M.round2(17 * 1.4), "23.8");
  assert.equal(M.round2(14 * 1.2), "16.8");
  assert.equal(M.round2(0), "0");
});

test("isAdaptivePickerTag: lower-level auto-apply assist targets adaptive Kendo picker hosts", () => {
  assert.equal(M.isAdaptivePickerTag("KENDO-DROPDOWNLIST"), true);
  assert.equal(M.isAdaptivePickerTag("kendo-combobox"), true);
  assert.equal(M.isAdaptivePickerTag("KENDO-MULTICOLUMNCOMBOBOX"), true);
  assert.equal(M.isAdaptivePickerTag("KENDO-MULTISELECT"), true);
  assert.equal(M.isAdaptivePickerTag("KENDO-AUTOCOMPLETE"), true);
  assert.equal(M.isAdaptivePickerTag("KENDO-ACTIONSHEET"), false, "action sheet is not the picker host");
  assert.equal(M.isAdaptivePickerTag("DIV"), false);
});

// =====================================================================================================
// buildCss — scaling, ordering, inert cases
// =====================================================================================================

test("buildCss: inert cases all return ''", () => {
  assert.equal(M.buildCss({}), "");
  assert.equal(M.buildCss(null), "");
  assert.equal(M.buildCss(cd({})), "");
  assert.equal(M.buildCss(cd({ grid: { rowHeight: 1 } })), "", "factor at default emits nothing");
  assert.equal(M.buildCss(cd({ nope: { x: 1.5 } })), "", "unknown family ignored");
  assert.equal(M.buildCss(cd({ grid: { nope: 1.5 } })), "", "unknown dim ignored");
});

test("buildCss: textAreaAutoSizeEnabled removes the native resize handle without owning scroll policy", () => {
  const css = M.buildCss({ textAreaAutoSizeEnabled: true });
  assert.equal(M.ruleCount({ textAreaAutoSizeEnabled: true }), 2, "text-area rule plus view scroll rule");
  assert.ok(css.indexOf("ep-text-area textarea.k-textarea, .ep-text-area textarea.k-textarea") >= 0,
    "selector is scoped to Kinetic ep-text-area wrappers");
  assert.ok(css.indexOf("resize: none !important;") >= 0, "native resize handle suppressed while enabled");
  assert.ok(css.indexOf("ep-view, .ep-view-content { overflow-y: auto !important; overscroll-behavior-y: auto !important; }") >= 0,
    "view content becomes scrollable when capped textareas create residual page overflow");
  assert.equal(css.indexOf("ep-text-area textarea.k-textarea, .ep-text-area textarea.k-textarea { resize: none !important; overflow-y:"), -1,
    "textarea overflow remains runtime-measured");
});

test("buildCss: fullWidthEnabled expands AppStudio view shell, fixed header, panel cards, and panel-card grids", () => {
  const css = M.buildCss({ fullWidthEnabled: true });
  assert.equal(M.ruleCount({ fullWidthEnabled: true }), 4, "four full-width layout rules");
  assert.ok(css.indexOf("ep-view.page-content.header-width") >= 0, "view-shell cap removed");
  assert.ok(css.indexOf("#ep-view-header") >= 0, "fixed page header width cap removed");
  assert.ok(css.indexOf("ep-panel-card-grid") >= 0, "panel-card grids stretch");
  assert.ok(css.indexOf("ep-panel-card") >= 0, "panel cards stretch");
  assert.ok(css.indexOf("max-width: none !important;") >= 0, "width cap is removed with priority");
});

test("buildCss: grid rowHeight scales td/th + cell + in-cell input (row floor) + the MDI checkbox glyph, !important", () => {
  const css = M.buildCss(cd({ grid: { rowHeight: 1.5 } }));
  assert.ok(css.indexOf(".k-grid td.k-table-td") >= 0);
  assert.ok(css.indexOf("height: 36px !important;") >= 0, "24 * 1.5 = 36 (td + input)");
  assert.ok(css.indexOf("min-height: 36px !important;") >= 0);
  // the cell wrapper line-height is the real Epicor row-height floor for TEXT cells (base 22)
  assert.ok(css.indexOf(".ep-grid .k-grid tr td .ep-grid-cell { line-height: 33px !important; height: 33px !important; }") >= 0, "22 * 1.5 = 33 on the cell");
  // in-cell <input> (select/edit columns) is the tallest-cell floor; scaled to compact the whole row
  assert.ok(css.indexOf(".ep-grid .k-grid tbody td.k-table-td input { height: 36px !important; min-height: 36px !important; }") >= 0, "in-cell input scaled too");
  // the MDI boolean-checkbox glyph tracks the row so it fits at every density (24->36 font, 12->18 lh)
  assert.ok(css.indexOf(".k-grid .ep-grid-cell-check.mdi { font-size: 36px !important; line-height: 18px !important; }") >= 0, "checkbox glyph font-size + line-height scale with rowHeight");
});

test("buildCss: the rowHeight checkbox-glyph rule outranks the standardizer pin (coexistence)", () => {
  // 24*0.6 = 14.4, 12*0.6 = 7.2 — the glyph shrinks to fit a compacted row.
  const css = M.buildCss(cd({ grid: { rowHeight: 0.6 } }));
  assert.ok(css.indexOf(".k-grid .ep-grid-cell-check.mdi { font-size: 14.4px !important; line-height: 7.2px !important; }") >= 0);
  // The selector must carry MORE classes than grid-checkbox-style-fix.js's `.ep-grid-cell-check.mdi`
  // (2 classes) so this density scale wins the cascade when both features run on the same grid.
  const grid = M.FAMILIES.find((f) => f.key === "grid");
  const rh = grid.dims.find((d) => d.key === "rowHeight");
  const glyph = rh.rules.find((r) => r.sel.indexOf(".ep-grid-cell-check.mdi") >= 0);
  assert.ok(glyph, "rowHeight has a checkbox-glyph rule");
  assert.ok((glyph.sel.match(/\./g) || []).length >= 3, "glyph selector has >= 3 classes (outranks the .ep-grid-cell-check.mdi standardizer pin)");
});

test("buildCss: grid font scales font-size only (header + the .ep-grid-cell row-text wrapper)", () => {
  const css = M.buildCss(cd({ grid: { font: 1.2 } }));
  assert.ok(css.indexOf("font-size: 16.8px !important;") >= 0, "14 * 1.2 = 16.8");
  // row text: the .ep-grid-cell data wrapper scales too, not just the header (the user-reported fix)
  assert.ok(css.indexOf(".ep-grid .k-grid td.k-table-td .ep-grid-cell { font-size: 16.8px !important; }") >= 0, "data-cell wrapper scaled");
  assert.ok(css.indexOf("height:") < 0, "font dim never touches height/line-height");
});

test("buildCss: grid font reaches ROW text via the .ep-grid-cell wrapper, not just the header", () => {
  const grid = M.FAMILIES.find((f) => f.key === "grid");
  const font = grid.dims.find((d) => d.key === "font");
  const sels = font.rules.map((r) => r.sel);
  assert.ok(sels.some((s) => s.indexOf(".k-column-title") >= 0), "still scales the header label");
  const cellRule = font.rules.find((r) => r.sel.indexOf(".ep-grid-cell") >= 0);
  assert.ok(cellRule, "a rule targets the .ep-grid-cell data wrapper (the row-text lever)");
  assert.ok(cellRule.sel.indexOf(".ep-grid ") === 0, "scoped under .ep-grid to outrank Epicor's stock cell font-size");
  assert.ok((cellRule.sel.match(/\./g) || []).length >= 3, "specificity guard (>= 3 classes)");
  const css = M.buildCss(cd({ grid: { font: 1.5 } }));
  assert.ok(css.indexOf(".ep-grid .k-grid td.k-table-td .ep-grid-cell { font-size: 21px !important; }") >= 0, "14 * 1.5 = 21 on the row cells");
});

test("buildCss: grid cellPad scales data-cell + header horizontal padding (aligned, 2 rules)", () => {
  const css = M.buildCss(cd({ grid: { cellPad: 0.5 } }));
  // data cells: the .ep-grid-cell wrapper (the td's own padding is 0 in Epicor grids)
  assert.ok(css.indexOf(".ep-grid .k-grid td.k-table-td > .ep-grid-cell { padding-left: 3.5px !important; padding-right: 3.5px !important; }") >= 0, "7 * 0.5 = 3.5 on data cells");
  // headers scale by the SAME factor so column titles stay aligned with the cells beneath
  assert.ok(css.indexOf(".ep-grid .k-grid th.k-header.k-table-th { padding-left: 3.5px !important; padding-right: 3.5px !important; }") >= 0, "header inset scales with the same factor");
  assert.ok(css.indexOf("height:") < 0 && css.indexOf("font-size") < 0, "cellPad touches only padding");
  assert.equal(M.ruleCount(cd({ grid: { cellPad: 0.5 } })), 3, "cellPad = 3 rules (data + header inline + header block)");
});

test("buildCss: grid cellPad selectors are scoped to .ep-grid + match stock specificity (>= 0,3,1)", () => {
  const grid = M.FAMILIES.find((f) => f.key === "grid");
  const cp = grid.dims.find((d) => d.key === "cellPad");
  for (const r of cp.rules) {
    assert.ok(r.sel.indexOf(".ep-grid ") === 0, "scoped under .ep-grid so it can outrank the stock !important rule: " + r.sel);
    // class count >= 3 (.ep-grid + .k-grid + one more) keeps specificity at/above the stock rule
    assert.ok((r.sel.match(/\./g) || []).length >= 3, "specificity guard (>= 3 classes): " + r.sel);
  }
});

test("buildCss: dropdown height emits the coordinated value-text fix", () => {
  const css = M.buildCss(cd({ dropdown: { height: 1.4 } }));
  assert.ok(css.indexOf(".k-combobox.k-picker .k-input-inner, .k-dropdownlist.k-picker .k-input-inner, .k-picker-md.k-picker .k-input-inner, .k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner { height: 56px !important; min-height: 56px !important; }") >= 0,
    "date/time inputs include the live k-datepicker.k-input / k-timepicker.k-input shape");
  assert.ok(css.indexOf(".k-combobox.k-picker, .k-dropdownlist.k-picker, .k-picker-md.k-picker, .k-datepicker.k-picker, .k-timepicker.k-picker, .k-datepicker.k-input, .k-timepicker.k-input { height: 56px !important; min-height: 56px !important; }") >= 0,
    "date/time hosts include the live k-datepicker.k-input / k-timepicker.k-input shape");
  assert.ok(css.indexOf(".k-combobox.k-picker .k-input-value-text, .k-dropdownlist.k-picker .k-input-value-text, .k-picker-md.k-picker .k-input-value-text { height: 56px !important; padding-top: 16.8px !important; line-height: 28px !important; }") >= 0,
    "value-text scaled: 40*1.4=56, 12*1.4=16.8, 20*1.4=28");
  assert.ok(css.indexOf(".k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner { padding-top: 21px !important; line-height: 28px !important; }") >= 0,
    "date/time value padding and line-height scale with compact height");
});

test("buildCss: dropdown height resets compact transforms in the home settings flyout", () => {
  const css = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  assert.ok(css.indexOf(".ep-user-settings .k-dropdownlist.k-picker, .ep-user-settings .k-picker-md.k-picker { transform: translateY(0px) !important; padding-top: 0px !important; }") >= 0,
    "settings picker transform/padding reset prevents value/label overlap");
  assert.ok(css.indexOf(".ep-user-settings .k-dropdownlist.k-picker .k-input-inner, .ep-user-settings .k-picker-md.k-picker .k-input-inner { transform: translateY(0px) !important; }") >= 0,
    "settings inner value transform reset keeps the value inside the dropdown");
});

test("buildCss: dropdown selectors do not target detached popup/list option DOM", () => {
  const css = M.buildCss(cd({ dropdown: { height: 0.7, font: 0.8, padding: 0.2 } }));
  assert.ok(!/(^|\n)\.k-input-value-text \{/.test(css), "no document-global value-text rule that can hit popup option labels");
  assert.ok(!/(^|\n)\.k-picker-md \{/.test(css), "no document-global medium-picker rule that can hit Kendo popup/action-sheet hosts");
  assert.ok(css.indexOf(".k-picker-md .k-input-inner") < 0, "medium picker inner rules require the element to be the picker root");
  assert.ok(css.indexOf(".k-picker-md.k-picker") >= 0, "closed picker fields remain covered");
});

test("buildCss: card gutter scales col padding + the row's NEGATIVE margin by the same factor", () => {
  const css = M.buildCss(cd({ card: { gutter: 0.3 } }));
  assert.ok(css.indexOf(".ep-panel-card .col.col-container { padding-left: 4.5px !important; padding-right: 4.5px !important; }") >= 0, "15 * 0.3 = 4.5 on columns");
  // the row's negative margin MUST track the column padding (base -15) or the row overflows
  assert.ok(css.indexOf(".ep-panel-card .row.row-container { margin-left: -4.5px !important; margin-right: -4.5px !important; }") >= 0, "-15 * 0.3 = -4.5 on the row");
  assert.equal(M.ruleCount(cd({ card: { gutter: 0.3 } })), 2, "gutter = 2 rules (col + row)");
});

test("buildCss: card cardPad scales all four sides of .ep-content from their stock bases", () => {
  const css = M.buildCss(cd({ card: { cardPad: 0.5 } }));
  assert.ok(css.indexOf(".ep-panel-card .ep-content { padding-top: 5px !important; padding-right: 10px !important; padding-bottom: 2.5px !important; padding-left: 10px !important; }") >= 0,
    "10/20/5/20 * 0.5 = 5/10/2.5/10");
});

test("buildCss: card fieldGap scales control margin-bottom (base 10) + checkbox (base 5)", () => {
  const css = M.buildCss(cd({ card: { fieldGap: 0.3 } }));
  assert.ok(css.indexOf("margin-bottom: 3px !important;") >= 0, "10 * 0.3 = 3 on field controls");
  assert.ok(css.indexOf(".ep-panel-card .ep-component-top-element.ep-check-box { margin-bottom: 1.5px !important; }") >= 0, "5 * 0.3 = 1.5 on checkboxes");
  assert.equal(M.ruleCount(cd({ card: { fieldGap: 0.3 } })), 3, "fieldGap = 3 rules (controls + checkbox + panel-bar-header centring pin)");
  // PANEL-BAR HEADER exception: in the expanded-header band the top-element margins are symmetric 5/5
  // CENTRING geometry, not a stacked-field gap — zeroing margin-bottom seated the search box 2.5px below
  // the sibling dropdown in the band's flex-centre (live-repro QAGO1090 2026-06-10). Pinned to constant 5.
  assert.ok(css.indexOf(".ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-text-box, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-numeric-box, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-date-picker, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-time-picker, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-combo-box, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-text-area, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-check-box { margin-bottom: 5px !important; }") >= 0,
    "header-band top-element margin-bottom pinned to stock 5 (constant at any factor)");
});

test("card family is the WHITE-SPACE lever: layout spacing only, never CONTROL height/width", () => {
  const card = M.FAMILIES.find((f) => f.key === "card");
  assert.ok(card, "card family exists");
  assert.equal(card.dims.map((d) => d.key).join(","), "gutter,cardPad,header,fieldGap");
  // gutter/cardPad/fieldGap touch only padding/margin (scaling a control's height adds bottom-of-column grey)
  const css = M.buildCss(cd({ card: { gutter: 0.3, cardPad: 0.3, fieldGap: 0.3 } }));
  assert.ok(css.indexOf("height:") < 0 && css.indexOf("width:") < 0, "spacing dims touch only padding/margin");
  // header legitimately scales the card-header band height (layout chrome, not a field control)
  const hCss = M.buildCss(cd({ card: { header: 0.5 } }));
  assert.ok(hCss.indexOf(".ep-panel-card .k-panelbar-item > .k-link { height: 40px !important; min-height: 40px !important; padding-left: 40px !important; padding-right: 12px !important; }") >= 0,
    "header clamps to the safe 0.8 floor: 50 * 0.8 = 40");
  assert.ok(hCss.indexOf(".ep-panel-card .ep-panelcard-header { height: 40px !important; min-height: 40px !important; }") >= 0,
    "inner panel header tracks the outer k-link height");
  // every card selector is scoped under .ep-panel-card and never targets a .k-input control box
  for (const d of card.dims) {
    for (const r of d.rules) {
      assert.ok(r.sel.indexOf(".ep-panel-card") === 0, "card selector scoped to .ep-panel-card: " + r.sel);
      assert.ok(r.sel.indexOf(".k-input") < 0, "card family never sizes a control box: " + r.sel);
    }
  }
});

test("buildCss: card cardPad also collapses the inter-card outer margin (panel margins)", () => {
  const css = M.buildCss(cd({ card: { cardPad: 0.5 } }));
  assert.ok(css.indexOf(".ep-panel-card { margin-bottom: 5px !important; }") >= 0, "10 * 0.5 = 5 between cards");
});

test("buildCss: textbox height re-aligns the summary currency '$' prefix as fields compact", () => {
  const css = M.buildCss(cd({ textbox: { height: 0.7 } }));
  // the $ prefix's absolute top (stock 20px, tuned for 40px fields) scales down so it tracks the value
  assert.ok(css.indexOf(".erp-currency .currency-symbol { top: 8.4px !important; }") >= 0, "currency $ top 12*0.7=8.4 (was a fixed 20 -> printed too low)");
  // and the $ font scales with the value font so they match size
  const fontCss = M.buildCss(cd({ textbox: { font: 0.8 } }));
  assert.ok(fontCss.indexOf(".erp-currency .currency-symbol input { font-size: 11.2px !important; }") >= 0, "currency $ font 14*0.8=11.2");
});

test("buildCss: field height compacts the floating-label WRAP via :has (eliminates below-value space)", () => {
  // The wrap is the PARENT of the control, so it must be matched with :has(), scoped to .ep-panel-card.
  const tb = M.buildCss(cd({ textbox: { height: 0.75 } }));
  assert.ok(tb.indexOf(".ep-panel-card .k-floating-label-container:has(.k-textbox, .k-numerictextbox, .k-maskedtextbox) { height: 30px !important; min-height: 30px !important; }") >= 0, "textbox wrap 40*0.75=30");
  // a stale descendant selector (.k-textbox .k-floating-label-container) must NOT be used — it never matches
  const tbDim = M.FAMILIES.find((f) => f.key === "textbox").dims.find((d) => d.key === "height");
  for (const r of tbDim.rules) {
    assert.ok(!/\.k-(textbox|numerictextbox)\s+\.k-floating-label-container/.test(r.sel), "no descendant wrap selector: " + r.sel);
  }
  const dd = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  assert.ok(dd.indexOf(".ep-panel-card .k-floating-label-container:has(.k-combobox, .k-dropdownlist, .k-datepicker, .k-timepicker) { height: 28px !important; min-height: 28px !important; }") >= 0, "dropdown wrap 40*0.7=28");
  // value-pull lifts the combobox/dropdownlist value as the wrap shrinks (base 12 -> 8.4 at min, clears clip)
  assert.ok(dd.indexOf(".k-combobox.k-input, .k-dropdownlist.k-picker { padding-top: 8.4px !important; }") >= 0, "value-pull 12*0.7=8.4");
  assert.ok(dd.indexOf(".k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner { padding-top: 10.5px !important; line-height: 14px !important; }") >= 0,
    "date/time compact value fit: 15*0.7=10.5 and 20*0.7=14");
});

test("buildCss: textbox height scales the embedded search icon so its glyph re-centres (anti-cutoff)", () => {
  const css = M.buildCss(cd({ textbox: { height: 0.7 } }));
  // 40×40 box (padding 20) -> 28×28 (padding 14): flex-centred glyph lands on the 28px field centre, 0 overflow.
  assert.ok(css.indexOf(".ep-panel-card ep-numeric-box .ep-search-icon, .ep-panel-card ep-text-box .ep-search-icon { height: 28px !important; padding: 14px !important; }") >= 0,
    "search icon box scales 40→28 / 20→14 with the field height");
  // Scoped to panel-card fields only — the global top-bar search icon (different size, never in a card) is safe.
  const tbDim = M.FAMILIES.find((f) => f.key === "textbox").dims.find((d) => d.key === "height");
  const iconRule = tbDim.rules.find((r) => r.sel.indexOf(".ep-search-icon") >= 0);
  assert.ok(iconRule.sel.indexOf(".ep-panel-card") === 0, "icon rule is scoped to .ep-panel-card");
});

test("buildCss: textbox height LIFTS the floated label clear of the rising value (anti-collision)", () => {
  // Affine translateY (base 20, offset -16) = +4 at stock, -2 at f=0.7 — lifts the floated label up as the
  // value rises so "Sales Order" no longer overlaps "5413".
  const compact = M.buildCss(cd({ textbox: { height: 0.7 } }));
  assert.ok(compact.indexOf(".ep-panel-card .k-floating-label-container:not(.k-empty):has(.k-textbox, .k-numerictextbox, .k-maskedtextbox) .k-floating-label { transform: translateY(-2px) !important; }") >= 0,
    "floated label lifts to translateY(-2px) at f=0.7");
  // :not(.k-empty) so empty-field PLACEHOLDERS keep their centring transform.
  assert.ok(compact.indexOf(":not(.k-empty)") >= 0, "label-lift is scoped to floated (non-empty) labels");
  // clampMax 4: on EXPANSION (f>1) the label is NOT pushed below stock — it pins at the stock translateY(4).
  const expand = M.buildCss(cd({ textbox: { height: 1.6 } }));
  assert.ok(expand.indexOf("transform: translateY(4px) !important;") >= 0, "expansion clamps the lift to stock +4 (never pushes label down)");
  // The dropdown family lifts its floated label by the SAME affine (comboboxes collided worse via value-pull).
  const dd = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  assert.ok(dd.indexOf(".ep-panel-card .k-floating-label-container:not(.k-empty):has(.k-combobox, .k-dropdownlist, .k-datepicker, .k-timepicker) .k-floating-label { transform: translateY(-2px) !important; }") >= 0,
    "dropdown floated label lifts to translateY(-2px) at f=0.7");
});

test("buildCss: dropdown height recentres the combobox/dropdownlist toggle-arrow (anti-clip)", () => {
  const css = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  // The chevron .k-input-button is position:RELATIVE; top:12 (stock) — a flex child whose in-flow start
  // moves down by the host's value-pull padding-top (12f). At f=0.7 it landed at 8.4(pad)+12 = 20px in a
  // 28px host and overflowed the bottom by 12px (clipped). Recentre via top_css = 8f-10 = -4.4 at f=0.7,
  // so final top = pad(8.4) + (-4.4) = 4 → dead-centre in the 28px host. Inert at f=1 (dim skipped).
  // EXCLUDES date/time (own absolute rule); .ep-panel-card-scoped so the login/flyout/shell exceptions
  // (host pinned to 40px, not panel cards) are untouched.
  assert.ok(css.indexOf(".ep-panel-card .k-combobox.k-picker .k-input-button, .ep-panel-card .k-dropdownlist.k-picker .k-input-button { top: -4.4px !important; }") >= 0,
    "combobox/dropdownlist toggle-arrow recentres (top:-4.4 -> dead-centre in the 28px field) at f=0.7");
  assert.equal(M.buildCss(cd({ dropdown: { height: 1 } })).indexOf(".k-dropdownlist.k-picker .k-input-button { top:"), -1,
    "toggle-arrow recentre is inert at f=1 (stock top:12 preserved, exact revert)");
});

test("buildCss: textbox height RE-SEATS the panel-bar-header search-box (direct-input variant)", () => {
  // The expanded-header key-field search box (.ep-panel-bar-title .erp-search-box) is the DIRECT-input
  // markup variant (the <input> itself is .k-textbox.k-input, no .k-input-inner child), so the form-field
  // "keep padding-top 17" clip-edge rationale does not hold — stock 17 seated the typed value ON the
  // underline of the 28px compacted box (live-repro QAGO1090 2026-06-10). Stock-proportional vertical
  // scaling + affine separation that vanishes at f=1: value padding-top 12f+5 (17 stock / 13.4 min),
  // floated label translateY(9f-5) (4 stock / 1.3 min), empty-resting placeholder top 7f+12 (ink-centred).
  const css = M.buildCss(cd({ textbox: { height: 0.7 } }));
  assert.ok(css.indexOf(".ep-panel-bar-title .erp-search-box input.k-textbox.k-input { padding-top: 13.4px !important; line-height: 12.6px !important; font-size: 9.8px !important; }") >= 0,
    "header search-box value re-seats (padding-top 13.4, line/font scaled) at f=0.7");
  assert.ok(css.indexOf(".ep-panel-bar-title .erp-search-box .k-floating-label-container.k-empty:not(.k-focus) .k-floating-label { top: 16.9px !important; }") >= 0,
    "empty-resting placeholder re-seats to top 16.9 (net 7f against translateY(-12)) — ink-centred");
  assert.ok(css.indexOf(".ep-panel-bar-title .erp-search-box .k-floating-label-container.k-focus .k-floating-label, .ep-panel-bar-title .erp-search-box .k-floating-label-container:not(.k-empty) .k-floating-label { font-size: 7.84px !important; line-height: 12.6px !important; transform: translateY(1.3px) !important; }") >= 0,
    "floated label scales + lifts (translateY 1.3) — NEVER pins top (Epicor's k-focus top:0 must win)");
  // Continuity: at f=1 the dim is inert (stock untouched, exact revert).
  assert.equal(M.buildCss(cd({ textbox: { height: 1 } })).indexOf(".ep-panel-bar-title"), -1,
    "header search-box exception is inert at f=1");
});

test("buildCss: textbox height RE-SEATS compact direct text and numeric values", () => {
  // Live Customer page at the minimum preset showed direct ep-text-box inputs and kendo-numerictextbox
  // inner inputs keeping stock padding-top 17px inside a 28px compact field. That left an 11px content
  // band for an 18px line-height. These scoped rules keep the 28px density but restore a usable value band.
  const css = M.buildCss(cd({ textbox: { height: 0.7, font: 0.8 } }));
  assert.ok(css.indexOf(".ep-component-top-element.ep-text-box input.k-textbox.k-input { padding-top: 9.8px !important; }") >= 0,
    "direct text inputs compact padding-top to 14*0.7=9.8");
  assert.ok(css.indexOf(".ep-component-top-element.ep-numeric-box .k-numerictextbox.k-input > .k-input-inner { transform: none !important; padding-top: 9.8px !important; }") >= 0,
    "numeric input inner is kept inside the 28px host and re-seated");
  assert.ok(css.indexOf(".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner, .k-maskedtextbox .k-input-inner, .ep-component-top-element.ep-text-box input.k-textbox.k-input { font-size: 11.2px !important; line-height: 14.4px !important; }") >= 0,
    "font slider owns the final compact line-height for wrapped and direct text fields");
});

test("buildCss: dropdown height RE-SEATS normal panel-card dropdown values", () => {
  const css = M.buildCss(cd({ dropdown: { height: 0.7, font: 0.8 } }));
  assert.ok(css.indexOf(".ep-component-top-element.ep-dropdown .k-dropdownlist.k-picker, .ep-component-top-element.ep-dropdown .k-combobox.k-picker, ep-combo-box .k-dropdownlist.k-picker, ep-combo-box .k-combobox.k-picker { padding-top: 0px !important; }") >= 0,
    "normal form dropdown host padding is reset so the value box stays inside the compact host");
  assert.ok(css.indexOf(".ep-component-top-element.ep-dropdown .k-dropdownlist.k-picker > .k-input-inner, .ep-component-top-element.ep-dropdown .k-combobox.k-picker > .k-input-inner, ep-combo-box .k-dropdownlist.k-picker > .k-input-inner, ep-combo-box .k-combobox.k-picker > .k-input-inner { transform: none !important; }") >= 0,
    "normal form dropdown inner transform is cancelled");
  assert.ok(css.indexOf(".ep-component-top-element.ep-dropdown .k-input-value-text, ep-combo-box .k-input-value-text { height: auto !important; padding-top: 0px !important; transform: none !important; }") >= 0,
    "selected value box uses natural height and the font slider line-height");
  assert.ok(css.indexOf(".k-combobox.k-picker .k-input-value-text, .k-dropdownlist.k-picker .k-input-value-text, .k-picker-md.k-picker .k-input-value-text, .k-combobox.k-picker .k-input-inner, .k-dropdownlist.k-picker .k-input-inner, .k-picker-md.k-picker .k-input-inner, .k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner { font-size: 11.2px !important; line-height: 14.4px !important; }") >= 0,
    "dropdown font slider still owns the final value line-height");
});

test("buildCss: dropdown height RE-CENTRES panel-bar-header (label-less) dropdown text", () => {
  // Header-band pickers (.ep-panel-header-elements, e.g. the Supplier Tracker "All" view picker) have NO
  // floating label: stock host padding-top is 0 and the auto-height value text is flex-centred. The global
  // value-pull (host padding-top 12f) + value-text box rules (height 40f / padding-top 12f) pushed the text
  // 2×8.4px below centre at f=0.7, overflowing the 28px host (live-repro QAGO1090, 2026-06-10). The
  // exception restores the stock centring model: host pad 0, auto/normal value box, chevron top 20f-10
  // (pad-0 host, vs the global 8f-10 which assumes a 12f pad).
  const css = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  assert.ok(css.indexOf(".ep-panel-header-elements .k-combobox.k-input, .ep-panel-header-elements .k-dropdownlist.k-picker, .ep-panel-header-elements .k-picker-md.k-picker { padding-top: 0px !important; }") >= 0,
    "header-band picker host pad pinned to 0 (no floating label to make room for)");
  assert.ok(css.indexOf(".ep-panel-header-elements .k-combobox.k-picker .k-input-value-text, .ep-panel-header-elements .k-dropdownlist.k-picker .k-input-value-text, .ep-panel-header-elements .k-picker-md.k-picker .k-input-value-text { height: auto !important; padding-top: 0px !important; line-height: normal !important; }") >= 0,
    "header-band value text gets its stock auto-height flex-centred box back");
  assert.ok(css.indexOf(".ep-panel-card .ep-panel-header-elements .k-combobox.k-picker .k-input-button, .ep-panel-card .ep-panel-header-elements .k-dropdownlist.k-picker .k-input-button { top: 4px !important; }") >= 0,
    "header-band chevron recentres for a pad-0 host (top = (40f-20)/2 = 4 at f=0.7)");
  assert.equal(M.buildCss(cd({ dropdown: { height: 1 } })).indexOf(".ep-panel-header-elements"), -1,
    "header-band exception is inert at f=1 (stock untouched, exact revert)");
});

test("buildCss: dropdown height recentres + scales the date-calendar / time-clock picker glyph", () => {
  const css = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  // Toggle button is position:absolute top:10 (tuned for 40px); recentre via (40f-20)/2 -> 4 at f=0.7.
  // Also pin right:5 (base 0 const) so the time button (native right:7) aligns with the date buttons (right:5)
  // — the separator "vertical line" (button border-left) + glyph then line up across the column.
  assert.ok(css.indexOf(".ep-panel-card .k-datepicker .k-input-button, .ep-panel-card .k-timepicker .k-input-button { top: 4px !important; right: 5px !important; }") >= 0,
    "picker toggle button recentres (top:4) AND horizontally aligns (right:5) at f=0.7");
  // Date calendar = MDI ::before glyph (Kendo svg hidden): scale font-size + the pseudo's box.
  assert.ok(css.indexOf(".ep-panel-card .k-datepicker .k-input-button .k-svg-icon::before { font-size: 16.8px !important; width: 28px !important; height: 28px !important; }") >= 0,
    "date calendar ::before glyph scales 24->16.8 / 40->28");
  // Time clock = real Kendo <svg>: scale the icon AND the svg child (svg ignores the parent height alone).
  assert.ok(css.indexOf(".ep-panel-card .k-timepicker .k-input-button .k-svg-icon, .ep-panel-card .k-timepicker .k-input-button .k-svg-icon svg { height: 16.8px !important; width: 16.8px !important; }") >= 0,
    "time clock svg scales 24->16.8");
  // Recentre is geometrically correct on EXPANSION too (no clamp): (40*1.6-20)/2 = 22; right stays const 5.
  const expand = M.buildCss(cd({ dropdown: { height: 1.6 } }));
  assert.ok(expand.indexOf("{ top: 22px !important; right: 5px !important; }") >= 0, "button recentre stays correct on expansion (top 22 at f=1.6), right stays 5");
});

test("buildCss: dropdown height GRACEFULLY COMPACTS the panel-card-less login dropdown (stock-pin + zoom)", () => {
  // The Kinetic login auth-mode dropdown lives in .ep-login-view OUTSIDE any panel card, so the global value-
  // pull shrinks its value box while the panel-card label-lift never fires -> value glyphs overprint the
  // floating label (live-repro on Fifth). Fix: pin the login dropdown internals to STOCK (constant, immune to
  // factor) then zoom the whole field by the factor so it shrinks PROPORTIONALLY and can never overlap.
  const f07 = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  assert.ok(f07.indexOf(".ep-login-view .k-input-value-text { height: 40px !important; padding-top: 17px !important; line-height: 18px !important; }") >= 0,
    "login value-text pinned to stock 40/17/18 (the global rule shrinks it to 28/8.4/14)");
  assert.ok(f07.indexOf(".ep-login-view .k-dropdownlist.k-picker .k-input-inner, .ep-login-view .k-picker-md.k-picker .k-input-inner { height: 40px !important; min-height: 40px !important; }") >= 0,
    "login inner pinned to stock 40");
  assert.ok(f07.indexOf(".ep-login-view .k-dropdownlist.k-picker, .ep-login-view .k-picker-md.k-picker { height: 40px !important; min-height: 40px !important; padding-top: 16px !important; }") >= 0,
    "login picker pinned to stock 40 + value padding-top 16");
  assert.ok(f07.indexOf(".ep-login-view .k-floating-label-container:has(.k-combobox, .k-dropdownlist, .k-datepicker, .k-timepicker) { zoom: 0.7 !important; }") >= 0,
    "login field zoomed to the factor (0.7) -> proportional shrink, no overlap");
  // The pins are CONSTANT (base 0 + offset): at a DIFFERENT factor they do NOT scale — only the zoom changes.
  const f14 = M.buildCss(cd({ dropdown: { height: 1.4 } }));
  assert.ok(f14.indexOf(".ep-login-view .k-input-value-text { height: 40px !important; padding-top: 17px !important; line-height: 18px !important; }") >= 0,
    "login value-text stays stock 40/17/18 at f=1.4 (constant, not scaled)");
  assert.ok(f14.indexOf("zoom: 1.4 !important;") >= 0, "login zoom tracks the factor (1.4 on expansion)");
  // Inert at stock: no .ep-login-view rule when the dim is at default.
  assert.equal(M.buildCss(cd({ dropdown: { height: 1 } })).indexOf(".ep-login-view"), -1, "no login rules at factor 1 (inert)");
});

test("buildCss: dropdown height preserves shell account adaptive company/site action sheets", () => {
  const css = M.buildCss(cd({ dropdown: { height: 0.7 } }));
  assert.ok(css.indexOf(".ep-shell-account-panel kendo-dropdownlist.ep-adaptive-mode.k-dropdownlist.k-picker { height: 40px !important; min-height: 40px !important; padding-top: 16px !important; transform: none !important; overflow: visible !important; }") >= 0,
    "adaptive shell account picker host is stock-height, non-transformed, and overflow-visible");
  assert.ok(css.indexOf(".ep-shell-account-panel kendo-dropdownlist.ep-adaptive-mode.k-dropdownlist.k-picker > .k-input-inner { height: 40px !important; min-height: 40px !important; transform: none !important; }") >= 0,
    "adaptive shell account inner is stock-height and non-transformed");
  assert.ok(css.indexOf(".ep-shell-account-panel kendo-dropdownlist.ep-adaptive-mode.k-dropdownlist.k-picker > .k-input-inner .k-input-value-text { height: 40px !important; padding-top: 17px !important; line-height: 18px !important; }") >= 0,
    "adaptive shell account value text is pinned to stock so the action sheet is not clipped by compact field geometry");
  assert.equal(M.buildCss(cd({ dropdown: { height: 1 } })).indexOf(".ep-shell-account-panel"), -1,
    "shell account exception remains inert at stock factor");
});

test("buildCss: textbox height GRACEFULLY COMPACTS the login text fields (stock-pin + zoom), no combobox leak", () => {
  // Username/password auth modes render TEXT fields in the same panel-card-less .ep-login-view; the same fix
  // applies. Pin the login text input to stock 40 then zoom. Scoped to .k-textbox/.k-numerictextbox/
  // .k-maskedtextbox so it never touches the dropdown family (asserted globally too).
  const f07 = M.buildCss(cd({ textbox: { height: 0.7 } }));
  assert.ok(f07.indexOf(".ep-login-view .k-textbox .k-input-inner, .ep-login-view .k-numerictextbox .k-input-inner, .ep-login-view .k-maskedtextbox .k-input-inner { height: 40px !important; min-height: 40px !important; }") >= 0,
    "login text input pinned to stock 40");
  assert.ok(f07.indexOf(".ep-login-view .k-floating-label-container:has(.k-textbox, .k-numerictextbox, .k-maskedtextbox) { zoom: 0.7 !important; }") >= 0,
    "login text field zoomed to the factor");
  // The login zoom selector must NOT reference dropdown/combobox/picker controls (family isolation).
  const loginZoomLine = f07.split("\n").find((l) => l.indexOf(".ep-login-view .k-floating-label-container:has(.k-textbox") >= 0);
  assert.ok(loginZoomLine && loginZoomLine.indexOf(".k-combobox") < 0 && loginZoomLine.indexOf(".k-dropdownlist") < 0 && loginZoomLine.indexOf(".k-picker") < 0,
    "textbox login zoom stays scoped to text controls");
});

test("buildCss: textbox value inner keeps the global clip-edge-safe rule scoped", () => {
  // The kendo-numerictextbox wrapper is overflow:hidden with its top seated ~18px down; the OLD 17*f scaling
  // drove padding-top to 11.9 at f=0.7, centring the value text ABOVE that edge → shaved digit tops. The
  // inner rule now scales height/min-height ONLY; padding-top stays native 17, seating the value below the edge.
  const compact = M.buildCss(cd({ textbox: { height: 0.7 } }));
  assert.ok(compact.indexOf(".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner, .k-maskedtextbox .k-input-inner { height: 28px !important; min-height: 28px !important; }") >= 0,
    "value inner scales height/min-height only");
  // No padding-top on the .k-input-inner / .k-input GLOBAL rules — the clip-edge rationale protects the
  // older wrapped variants. Padding-top is allowed only on live-proven exceptions: direct text inputs,
  // numeric input inners, and the panel-bar-header direct-input search box.
  for (const line of compact.split("\n")) {
    if (line.indexOf("padding-top") === -1) { continue; }
    assert.ok(line.startsWith(".ep-component-top-element.ep-text-box input.k-textbox.k-input")
      || line.startsWith(".ep-component-top-element.ep-numeric-box .k-numerictextbox.k-input > .k-input-inner")
      || line.startsWith(".ep-panel-bar-title .erp-search-box"),
      "padding-top only on scoped direct/numeric/header exceptions, never the global inner/input rules: " + line);
  }
});

test("buildCss: emitProp extension (offset/wrap/clamp) is inert by default — non-extended rules unchanged", () => {
  // A plain proportional rule (no offset/wrap/clamp) must still emit exactly base*f + 'px'.
  const css = M.buildCss(cd({ textbox: { height: 0.7 } }));
  assert.ok(css.indexOf(".k-textbox.k-input, .k-numerictextbox.k-input, .k-maskedtextbox.k-input { height: 28px !important; min-height: 28px !important; }") >= 0,
    "plain control-height rule still emits base*f px (40*0.7=28), unaffected by the extension");
});

test("buildCss: page chrome family compacts the fixed page header separately from panel cards", () => {
  const css = M.buildCss(cd({ page: { header: 0.6, title: 0.75 } }));
  assert.ok(css.indexOf("#ep-view-header { min-height: 59.4px !important; }") >= 0, "outer fixed header min-height scales");
  assert.ok(css.indexOf("#ep-view-header .ep-view-header { height: 42px !important; min-height: 42px !important; padding-top: 6px !important; padding-bottom: 6px !important; margin-top: 4.8px !important; }") >= 0,
    "inner page header height/padding/margin scale together");
  assert.ok(css.indexOf("#ep-view-title { font-size: 25.5px !important; line-height: 22.5px !important; padding-bottom: 3.75px !important; }") >= 0,
    "title size scales without touching panel-card titles");
  assert.equal(M.ruleCount(cd({ page: { header: 0.6, title: 0.75 } })), 5, "page header(3) + title(2)");
});

test("buildCss: tabs padding reaches the fixed tabstrip header and high-specificity Kendo link", () => {
  const css = M.buildCss(cd({ tabs: { padding: 0.4 } }));
  assert.ok(css.indexOf(".ep-tab-strip .k-tabstrip-items { height: 28px !important; min-height: 28px !important; padding-top: 6.4px !important; padding-bottom: 6.4px !important; }") >= 0,
    "fixed tabstrip item band scales with padding");
  assert.ok(css.indexOf(".ep-tab-strip .k-tabstrip-items .k-tabstrip-item { margin-right: 8px !important; }") >= 0,
    "tab inter-item gap scales");
  assert.ok(css.indexOf("div.ep-component-top-element.ep-tab-strip kendo-tabstrip.k-tabstrip.k-tabstrip-md .k-tabstrip-items-wrapper.k-vstack .k-tabstrip-items.k-reset > li.k-tabstrip-item.k-item > span.k-link { padding-top: 4px !important; padding-bottom: 4px !important; padding-left: 6px !important; padding-right: 6px !important; }") >= 0,
    "specific tab link selector outranks Kendo's fixed padding");
});

test("buildCss: textbox + dropdown 'padding' scale the internal horizontal inset, scoped apart", () => {
  const tb = M.buildCss(cd({ textbox: { padding: 0.4 } }));
  assert.ok(tb.indexOf(".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner, .k-maskedtextbox .k-input-inner { padding-left: 6px !important; }") >= 0,
    "wrapped text/numeric insets clamp to the 6px compact usability floor");
  assert.ok(tb.indexOf(".ep-component-top-element.ep-text-box input.k-textbox.k-input { padding-left: 6px !important; }") >= 0,
    "direct text inputs share the same 6px compact floor");
  assert.ok(tb.indexOf(".ep-component-top-element.ep-text-box .k-floating-label") >= 0 && tb.indexOf("padding-right: 6px !important;") >= 0,
    "text/numeric floating labels align with the 6px compact floor");
  assert.ok(tb.indexOf(".k-combobox") < 0 && tb.indexOf(".k-picker") < 0, "textbox padding does not leak into dropdowns");
  const dd = M.buildCss(cd({ dropdown: { padding: 0.4 } }));
  assert.ok(dd.indexOf(".k-combobox.k-picker .k-input-inner, .k-dropdownlist.k-picker .k-input-inner, .k-picker-md.k-picker .k-input-inner, .k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner { padding-left: 4px !important; padding-right: 4px !important; }") >= 0, "dropdown inset 10 * 0.4 = 4");
  assert.ok(dd.indexOf(".k-textbox") < 0, "dropdown padding does not leak into text fields");
});

test("buildCss: tag family compacts Options status tags without touching global checkboxes", () => {
  const css = M.buildCss(cd({ tag: { height: 0.65, padding: 0.2, font: 0.8 } }));
  assert.ok(css.indexOf(".ep-panel-card .ep-component-top-element.ep-tag, .ep-panel-card ep-tag.ep-component, .ep-panel-card ep-tag-item, .ep-panel-card .ep-component-item-element.ep-tag-item { height: 27.3px !important; min-height: 27.3px !important; }") >= 0,
    "outer tag row compresses from 42px to 27.3px");
  assert.ok(css.indexOf(".ep-panel-card .ep-component-top-element.ep-tag .ep-tag-item-container.ep-shape-container { height: 24px !important; min-height: 11.7px !important; margin-top: 1.65px !important; margin-bottom: 1.65px !important; padding-top: 3.25px !important; padding-bottom: 3.25px !important; }") >= 0,
    "pill container keeps the native checkbox row floor while the outer tag still compacts");
  assert.ok(css.indexOf(".ep-panel-card .ep-tag ep-check-box.check-box-shape, .ep-panel-card .ep-tag .ep-component-top-element.ep-check-box, .ep-panel-card .ep-tag .ep-label-container, .ep-panel-card .ep-tag .ep-checkbox-label { height: 18px !important; min-height: 18px !important; line-height: 18px !important; font-size: 9.1px !important; }") >= 0,
    "checkbox host, label container, and label keep the native 18px line box at compact density");
  assert.ok(css.indexOf(".ep-panel-card .ep-tag .ep-component-top-element.ep-check-box input { height: 24px !important; min-height: 24px !important; }") >= 0,
    "invisible checkbox hit area keeps the native 24px floor");
  assert.ok(css.indexOf(".ep-panel-card .ep-component-top-element.ep-tag .ep-tag-item-container.ep-shape-container { padding-left: 1px !important; padding-right: 6px !important; }") >= 0,
    "horizontal padding removes the 30px right reserve when compacted");
  assert.ok(css.indexOf(".ep-panel-card .ep-tag .ep-checkbox-label { margin-left: 25px !important; }") >= 0,
    "checkbox-label offset remains native so the label clears the 18px icon");
  assert.ok(css.indexOf(".ep-panel-card .ep-tag .ep-checkbox-label { height: 18px !important; min-height: 18px !important; font-size: 11.2px !important; line-height: 18px !important; }") >= 0,
    "text-size slider reaches tag labels without shrinking the native label line box");
  assert.equal(M.ruleCount(cd({ tag: { height: 0.65, padding: 0.2, font: 0.8 } })), 7,
    "tag height(4) + padding(2) + font(1)");
  const fam = M.FAMILIES.find((f) => f.key === "tag");
  for (const dim of fam.dims) {
    for (const r of dim.rules) {
      assert.ok(r.sel.indexOf(".ep-panel-card") === 0,
        "tag selector is scoped to panel-card tag chrome: " + r.sel);
    }
  }
});

test("buildCss: tree family scales nav item padding (base 6) + text font (base 14)", () => {
  const css = M.buildCss(cd({ tree: { itemPad: 0.2, font: 0.8 } }));
  assert.ok(css.indexOf(".ep-menu-panel-link { padding-top: 1.2px !important; padding-bottom: 1.2px !important; }") >= 0, "6 * 0.2 = 1.2");
  assert.ok(css.indexOf(".ep-app-nav-main-map-item { padding-top: 0.4px !important; padding-bottom: 0.4px !important; }") >= 0, "in-app map rows compact too");
  assert.ok(css.indexOf(".ep-app-nav-main-map-item .ep-app-nav-icon { margin-right: 1.6px !important; }") >= 0, "nav icon gap scales with item spacing");
  assert.ok(css.indexOf(".ep-menu-panel-link-text, .ep-app-nav-main-map-item .ep-app-nav-text { font-size: 11.2px !important; }") >= 0, "14 * 0.8 = 11.2");
  assert.ok(css.indexOf(".ep-app-nav-main-map-item .ep-app-nav-icon { font-size: 12.8px !important; line-height: 12.8px !important; height: 12.8px !important; min-height: 12.8px !important; }") >= 0,
    "nav glyph scales with text and keeps line-height == height");
});

test("buildCss: tree itemPad ALSO compacts the main-menu Kendo TreeView (in-app tree + launcher menu)", () => {
  const css = M.buildCss(cd({ tree: { itemPad: 0.1 } }));
  // the Kendo treeview row padding (base 5) — the launcher menu's per-row inflation
  assert.ok(css.indexOf(".ep-tree-view .k-treeview .k-treeview-top { padding-top: 0.5px !important; padding-bottom: 0.5px !important; }") >= 0, "treeview row padding 5*0.1");
  // the inter-item gap rule MUST be specific enough (>= 0,3,0 with the .ep-tree-view prefix) to beat
  // Kendo's `.k-treeview .k-treeview-group .k-treeview-item { margin: 2px !important }`
  const group = M.FAMILIES.find((f) => f.key === "tree").dims.find((d) => d.key === "itemPad")
    .rules.find((r) => r.sel.indexOf(".k-treeview-group") >= 0);
  assert.ok(group, "has the group-item margin rule");
  assert.ok((group.sel.match(/\./g) || []).length >= 4, "group selector has >= 4 classes (outranks Kendo's 0,3,0 !important): " + group.sel);
  assert.ok(css.indexOf(".ep-tree-view .k-treeview .k-treeview-group .k-treeview-item { margin-top: 0.2px !important; margin-bottom: 0.2px !important; }") >= 0, "group-item margin 2*0.1");
  // all treeview rules are scoped to .ep-tree-view (no collateral on dialog/other Kendo treeviews)
  for (const r of M.FAMILIES.find((f) => f.key === "tree").dims.find((d) => d.key === "itemPad").rules) {
    if (r.sel.indexOf(".k-treeview") >= 0) {
      assert.ok(r.sel.indexOf(".ep-tree-view ") === 0, "treeview rule scoped to .ep-tree-view: " + r.sel);
    }
  }
  assert.equal(M.ruleCount(cd({ tree: { itemPad: 0.1 } })), 6, "itemPad = 6 rules (in-app link/map/icon gap + treeview top/group/leaf)");
});

test("buildCss: out-of-range factors are clamped before scaling", () => {
  const css = M.buildCss(cd({ grid: { rowHeight: 99 } })); // clamps to 1.8 -> 24*1.8 = 43.2
  assert.ok(css.indexOf("height: 43.2px !important;") >= 0);
});

// =====================================================================================================
// Grid family — bare-text-cell (dashboard) grid variant, e.g. SQL On The Fly's per-query Output grid.
// =====================================================================================================

test("buildCss: grid rowHeight also emits the bare-text-cell td rule at (0,3,2) specificity", () => {
  const css = M.buildCss(cd({ grid: { rowHeight: 0.6 } }));
  assert.ok(css.indexOf(".ep-grid .k-grid tbody tr td.k-table-td { height: 14.4px !important; line-height: 12px !important; }") >= 0,
    "bare-td rule outranks the page's injected 23px pin with the same scaled values as the generic rule");
  const generic = css.indexOf(".k-grid td.k-table-td, .k-grid th.k-table-th");
  assert.ok(generic >= 0 && css.indexOf("height: 14.4px !important; min-height: 14.4px !important") >= 0,
    "generic td/th rule still present with matching values (wrapped grids see no behavioral change)");
});

test("buildCss: grid cellPad scales the header's vertical Kendo padding-block", () => {
  const css = M.buildCss(cd({ grid: { cellPad: 0.3 } }));
  assert.ok(css.indexOf(".ep-grid .k-grid thead tr th.k-table-th { padding-top: 2.4px !important; padding-bottom: 2.4px !important; }") >= 0,
    "th padding-block 8 -> 2.4 at f=0.3 (header 29.9 -> 18.7 live)");
});

// =====================================================================================================
// Buttons family — Kinetic ep-buttons carry PINNED heights (medium 30 / small 22, live CDP survey
// 2026-06-11), so Height scales the pin itself; Spacing scales the stock 5/10/5/5 margins.
// =====================================================================================================

test("buildCss: button height scales the pinned ep-button heights with click-target floors", () => {
  const css = M.buildCss(cd({ button: { height: 0.7 } }));
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-medium { height: 21px !important; }") >= 0, "medium 30*0.7=21");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-small { height: 15.4px !important; }") >= 0, "small 22*0.7=15.4");
  const floor = M.buildCss(cd({ button: { height: 0.6 } }));
  assert.ok(floor.indexOf("button.ep-button.ep-btn-size-medium { height: 18px !important; }") >= 0, "medium floor 18 at min");
  assert.ok(floor.indexOf("button.ep-button.ep-btn-size-small { height: 14px !important; }") >= 0, "small floor 14 (22*0.6=13.2 clamped)");
});

test("buildCss: button padding also compacts ep-button horizontal padding (k-button rule unchanged)", () => {
  const css = M.buildCss(cd({ button: { padding: 0.5 } }));
  assert.ok(css.indexOf("padding-top: 2px !important; padding-bottom: 2px !important;") >= 0, "legacy k-button vertical rule intact");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-medium { padding-left: 10px !important; padding-right: 10px !important; }") >= 0, "medium padX 20*0.5");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-small { padding-left: 7.5px !important; padding-right: 7.5px !important; }") >= 0, "small padX 15*0.5");
  const floor = M.buildCss(cd({ button: { padding: 0.55 } })); // 20*0.55=11, 15*0.55=8.25 — above floors
  assert.ok(floor.indexOf("padding-left: 11px !important;") >= 0, "no clamp engaged above the floor");
});

test("buildCss: button spacing scales margins with a 2px right-margin merge floor", () => {
  const css = M.buildCss(cd({ button: { spacing: 0.4 } }));
  assert.ok(css.indexOf("button.ep-button { margin-top: 2px !important; margin-bottom: 2px !important; margin-left: 2px !important; margin-right: 4px !important; }") >= 0);
  const zero = M.buildCss(cd({ button: { spacing: 0 } }));
  assert.ok(zero.indexOf("margin-right: 2px !important;") >= 0, "right margin floors at 2 so buttons never merge");
  assert.ok(zero.indexOf("margin-left: 0px !important;") >= 0, "other margins reach 0");
});

test("buildCss: button font scales ep-button label + pinned 12px line-height + inline mdi glyph", () => {
  const css = M.buildCss(cd({ button: { font: 1.5 } }));
  assert.ok(css.indexOf(".k-button { font-size: 18px !important; }") >= 0, "legacy k-button font rule intact");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-medium { font-size: 18px !important; line-height: 18px !important; }") >= 0, "medium 12->18 with line box");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-small { font-size: 21px !important; line-height: 18px !important; }") >= 0, "small 14->21");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-medium .mdi { font-size: 24px !important; }") >= 0, "medium glyph 16->24 tracks label");
  assert.ok(css.indexOf("button.ep-button.ep-btn-size-small .mdi { font-size: 21px !important; }") >= 0, "small glyph keeps Epicor's 14px pin as its base");
});

test("buildCss: multi-family emits in FAMILIES order (grid before button)", () => {
  const css = M.buildCss(cd({ button: { padding: 1.5 }, grid: { rowHeight: 1.2 } }));
  assert.ok(css.indexOf(".k-grid") < css.indexOf(".k-button"), "grid rules precede button rules");
});

test("activeAdjustments: known family+dim + non-default clamped factor, in FAMILIES order", () => {
  assert.deepEqual(plain(M.activeAdjustments(cd({}))), []);
  assert.deepEqual(plain(M.activeAdjustments(cd({ grid: { rowHeight: 1 } }))), [], "default skipped");
  assert.deepEqual(
    plain(M.activeAdjustments(cd({ button: { padding: 1.5 }, grid: { rowHeight: 1.2, font: 1.1 } }))),
    [{ family: "grid", dim: "rowHeight", factor: 1.2 }, { family: "grid", dim: "font", factor: 1.1 }, { family: "button", dim: "padding", factor: 1.5 }]
  );
  assert.deepEqual(plain(M.activeAdjustments(cd({ grid: { rowHeight: 99 } }))), [{ family: "grid", dim: "rowHeight", factor: 1.8 }]);
});

test("gridRowHeightFactor: returns the active non-default clamped row factor only", () => {
  assert.equal(M.gridRowHeightFactor(cd({})), 1);
  assert.equal(M.gridRowHeightFactor(cd({ grid: { rowHeight: 1 } })), 1);
  assert.equal(M.gridRowHeightFactor(cd({ grid: { rowHeight: 0.6 } })), 0.6);
  assert.equal(M.gridRowHeightFactor(cd({ grid: { rowHeight: 99 } })), 1.8);
  assert.equal(M.gridRowHeightFactor(cd({ grid: { font: 1.2 } })), 1, "grid font does not affect the scroll spacer");
});

test("ruleCount: equals the number of emitted CSS rules", () => {
  assert.equal(M.ruleCount(cd({})), 0);
  assert.equal(M.ruleCount(cd({ grid: { rowHeight: 1.5 } })), 5, "grid rowHeight = 5 rules (td/th + bare-td + cell + input + checkbox glyph)");
  assert.equal(M.ruleCount(cd({ grid: { font: 1.2 } })), 2, "grid font = 2 rules (header/td + .ep-grid-cell row text)");
  assert.equal(M.ruleCount(cd({ grid: { cellPad: 0.5 } })), 3, "grid cellPad = 3 rules (data + header inline + header block)");
  assert.equal(M.ruleCount(cd({ dropdown: { height: 1.4 } })), 27, "dropdown height = 27 rules (base 17 + form-dropdown re-seat x3 + shell-account adaptive host/inner/value stock pins + combobox/dropdownlist toggle-arrow recentre + panel-bar-header label-less recentre x3)");
  assert.equal(M.ruleCount(cd({ textbox: { height: 0.7 } })), 14, "textbox height = 14 rules (inner + control + direct text/numeric re-seat x2 + wrap + currency-$ top + search-icon + floated-label lift + login-view stock-pin x2 + login-view zoom + panel-bar-header search-box x3)");
  assert.equal(M.ruleCount(cd({ grid: { rowHeight: 1.5, font: 1.2 } })), 7, "rowHeight(5) + font(2)");
});

// =====================================================================================================
// runtime (fake DOM) — the <style>.textContent applier, marker, host gate, live reactivity
// =====================================================================================================

function makeStyleEl() {
  return {
    nodeType: 1, nodeName: "STYLE", id: "", textContent: "", _attrs: {}, parentNode: null,
    setAttribute(k, v) { this._attrs[k] = v; }
  };
}

function makeTextArea({ scrollHeight = 80, height = "", maxHeight = "", overflowY = "", visible = true } = {}) {
  const attrs = {};
  return {
    nodeType: 1,
    tagName: "TEXTAREA",
    style: { height, maxHeight, overflowY },
    scrollTop: 0,
    scrollHeight,
    get clientHeight() {
      const n = Number.parseFloat(this.style.height || "0");
      return Number.isFinite(n) ? n : 0;
    },
    matches(sel) { return String(sel).indexOf("textarea") >= 0; },
    closest(sel) { return this._scrollHost && String(sel).indexOf(".ep-view-content") >= 0 ? this._scrollHost : null; },
    getBoundingClientRect() { return visible ? { width: 240, height: 155 } : { width: 0, height: 0 }; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    _attrs: attrs
  };
}

function makeWorld({ hostname = "centralusdtedu00.epicorsaas.com", store = {}, textareas = [], autoFlushTimers = true } = {}) {
  const headChildren = [];
  const docListeners = {};
  const observers = [];
  const timeouts = [];
  const scrollHost = { scrollTop: 0, scrollHeight: 1600, clientHeight: 986 };
  for (const ta of textareas) { ta._scrollHost = scrollHost; }
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
    querySelector(sel) { return String(sel || "") === ".ep-view-content" ? scrollHost : null; },
    getElementsByTagName(t) { return String(t).toLowerCase() === "head" ? [head] : []; },
    querySelectorAll(sel) {
      const s = String(sel || "");
      if (s.indexOf("textarea") < 0) return [];
      if (s.indexOf("data-kinetic-padding-textarea-original-height") >= 0) {
        return textareas.filter((ta) => ta.getAttribute("data-kinetic-padding-textarea-original-height") !== null);
      }
      return textareas;
    },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = docListeners[type] || [];
      const ix = arr.indexOf(fn);
      if (ix >= 0) { arr.splice(ix, 1); }
    }
  };
  const listeners = [];
  const chrome = {
    storage: {
      local: { get(keys, cb) { const out = {}; for (let i = 0; i < keys.length; i += 1) { if (Object.prototype.hasOwnProperty.call(store, keys[i])) { out[keys[i]] = store[keys[i]]; } } cb(out); } },
      onChanged: { addListener(fn) { listeners.push(fn); }, removeListener(fn) { const ix = listeners.indexOf(fn); if (ix >= 0) { listeners.splice(ix, 1); } } }
    }
  };
  function FakeMO(cb) { this._cb = cb; observers.push(this); }
  FakeMO.prototype.observe = function () {};
  FakeMO.prototype.disconnect = function () {};
  function setTimeoutFake(fn) {
    if (autoFlushTimers) { try { fn(); } catch (e) { /* ignore */ } return 0; }
    timeouts.push(fn);
    return timeouts.length;
  }
  function clearTimeoutFake(id) {
    if (!id || autoFlushTimers) return;
    const ix = id - 1;
    if (ix >= 0 && ix < timeouts.length) { timeouts[ix] = null; }
  }
  function flushTimers() {
    const pending = timeouts.splice(0);
    for (const fn of pending) { if (typeof fn === "function") { try { fn(); } catch (e) { /* ignore */ } } }
  }
  const W = {
    document, location: { hostname }, chrome, innerHeight: 986,
    MutationObserver: FakeMO,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake, setInterval() { return 0; }, clearInterval() {},
    _listeners: listeners, _docListeners: docListeners, _head: head, _docEl: documentElement, _store: store, _scrollHost: scrollHost,
    _observers: observers, _flushTimers: flushTimers
  };
  return W;
}

function readMarker(W) {
  try { return JSON.parse(W._docEl.dataset.kineticPaddingControl || "null"); } catch (e) { return null; }
}
function appliedCss(W) {
  const el = W.document.getElementById("kinetic-padding-control");
  return el ? el.textContent : null;
}

test("runtime: a grid adjustment installs the <style> with scaled !important CSS + marker", () => {
  const W = makeWorld({ store: { componentDensity: { grid: { rowHeight: 1.5 } } } });
  const api = M.install(W);
  assert.ok(api && api.__installed, "installed");
  const el = W.document.getElementById("kinetic-padding-control");
  assert.ok(el, "style element present");
  assert.equal(el._attrs["data-kinetic-grid-fix"], "padding-control");
  assert.equal(W._head.lastChild, el, "appended last in head");
  assert.ok(appliedCss(W).indexOf("height: 36px !important;") >= 0);

  const m = readMarker(W);
  assert.deepEqual(Object.keys(m).sort(), ["active", "adaptiveApplyAssists", "adaptiveApplyPending", "adaptiveApplySkips", "adjustments", "fullWidth", "reasserts", "ruleCount", "spacerFactor", "spacerFound", "spacerScans", "spacerWrites", "textAreaAutoSize", "textAreaAutoSizeCapped", "textAreaAutoSizeCount", "textAreaAutoSizeScans", "textAreaAutoSizeWrites", "textAreaWheelForwards", "version"]);
  assert.equal(m.active, true);
  assert.deepEqual(m.adjustments, [{ family: "grid", dim: "rowHeight", factor: 1.5 }]);
  assert.equal(m.ruleCount, 5);
  assert.equal(m.spacerWrites, 0);
  assert.equal(m.spacerFactor, 1.5);
  assert.equal(m.adaptiveApplyAssists, 0);
  assert.equal(m.adaptiveApplySkips, 0);
  assert.equal(m.adaptiveApplyPending, 0);
  assert.equal(m.textAreaAutoSize, false);
  assert.equal(m.textAreaAutoSizeCount, 0);
  assert.equal(m.textAreaAutoSizeCapped, 0);
  assert.equal(m.textAreaWheelForwards, 0);
  assert.equal(m.fullWidth, false);
  assert.equal(typeof m.version, "string");
});

test("runtime: empty componentDensity is fully inert (no <style>, marker active:false, 0 rules)", () => {
  const W = makeWorld({ store: { componentDensity: {} } });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-padding-control"), null);
  const m = readMarker(W);
  assert.equal(m.active, false);
  assert.equal(m.ruleCount, 0);
  assert.deepEqual(m.adjustments, []);
});

test("runtime: a factor at its default (grid.rowHeight:1) is inert", () => {
  const W = makeWorld({ store: { componentDensity: { grid: { rowHeight: 1 } } } });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-padding-control"), null);
  assert.equal(readMarker(W).active, false);
});

test("runtime: unsupported host is inert (no marker, no <style>)", () => {
  const W = makeWorld({ hostname: "evil.example.com", store: { componentDensity: { grid: { rowHeight: 1.5 } } } });
  const api = M.install(W);
  assert.ok(api && api.__installed, "runtime can install so it can read custom-host storage");
  assert.equal(W.document.getElementById("kinetic-padding-control"), null);
  assert.equal(W._docEl.dataset.kineticPaddingControl, undefined);
});

test("runtime: default epicorsaas host gate accepts; suffix-spoof stays inert", () => {
  assert.ok(M.install(makeWorld({ hostname: "epicorsaas.com", store: { componentDensity: { grid: { rowHeight: 1.2 } } } })));
  assert.ok(M.install(makeWorld({ hostname: "centralusdtadtl17.epicorsaas.com", store: { componentDensity: { grid: { rowHeight: 1.2 } } } })));
  const W = makeWorld({ hostname: "notepicorsaas.com.evil.com", store: { componentDensity: { grid: { rowHeight: 1.2 } } } });
  assert.ok(M.install(W), "runtime installed but must remain inert");
  assert.equal(W.document.getElementById("kinetic-padding-control"), null);
  assert.equal(W._docEl.dataset.kineticPaddingControl, undefined);
});

test("runtime: user-granted custom host pattern accepts exact and wildcard subdomains", () => {
  const W1 = makeWorld({
    hostname: "kinetic.example.com",
    store: { componentDensity: { grid: { rowHeight: 1.2 } }, customHostPatterns: ["*://kinetic.example.com/*"] }
  });
  M.install(W1);
  assert.ok(W1.document.getElementById("kinetic-padding-control"), "exact custom host applies");

  const W2 = makeWorld({
    hostname: "tenant.apps.example.com",
    store: { componentDensity: { grid: { rowHeight: 1.2 } }, customHostPatterns: ["*://*.apps.example.com/*"] }
  });
  M.install(W2);
  assert.ok(W2.document.getElementById("kinetic-padding-control"), "wildcard custom host applies");
});

test("runtime: live storage.onChanged rebuild (no reload) + revert removes <style> exactly", () => {
  const store = { componentDensity: {} };
  const W = makeWorld({ store });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "starts inert");

  // User drags the grid row-height slider to 130% -> onChanged -> live apply (no reload).
  store.componentDensity = { grid: { rowHeight: 1.3 } };
  W._listeners.forEach((fn) => fn({ componentDensity: { newValue: store.componentDensity } }, "local"));
  const el = W.document.getElementById("kinetic-padding-control");
  assert.ok(el, "style created live");
  assert.ok(appliedCss(W).indexOf("height: 31.2px !important;") >= 0, "24 * 1.3 = 31.2");
  assert.deepEqual(readMarker(W).adjustments, [{ family: "grid", dim: "rowHeight", factor: 1.3 }]);

  // User resets everything -> element removed, fully reverted.
  store.componentDensity = {};
  W._listeners.forEach((fn) => fn({ componentDensity: { newValue: {} } }, "local"));
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "reverted: no style element");
  assert.equal(readMarker(W).active, false);
});

test("runtime: full-width mode applies live and reverts without density sliders", () => {
  const store = { componentDensity: {}, fullWidthEnabled: false };
  const W = makeWorld({ store });
  M.install(W);
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "starts inert");

  store.fullWidthEnabled = true;
  W._listeners.forEach((fn) => fn({ fullWidthEnabled: { oldValue: false, newValue: true } }, "local"));
  assert.ok(W.document.getElementById("kinetic-padding-control"), "style created live");
  assert.ok(appliedCss(W).indexOf("ep-view.page-content.header-width") >= 0, "view-shell CSS applied");
  assert.ok(appliedCss(W).indexOf("ep-panel-card-grid") >= 0, "panel-card-grid CSS applied");
  assert.equal(readMarker(W).active, true);
  assert.equal(readMarker(W).fullWidth, true);
  assert.equal(readMarker(W).adjustments.length, 0, "not a spacing-slider adjustment");

  store.fullWidthEnabled = false;
  W._listeners.forEach((fn) => fn({ fullWidthEnabled: { oldValue: true, newValue: false } }, "local"));
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "style removed after disabling");
  assert.equal(readMarker(W).active, false);
  assert.equal(readMarker(W).fullWidth, false);
});

test("runtime: text-area auto-size writes measured height live and restores exactly on OFF", () => {
  const ta = makeTextArea({ scrollHeight: 115, height: "" });
  const store = { componentDensity: {}, textAreaAutoSizeEnabled: true };
  const W = makeWorld({ store, textareas: [ta] });
  M.install(W);

  assert.ok(W.document.getElementById("kinetic-padding-control"), "no-resize style is present while enabled");
  assert.equal(ta.style.height, "115px", "height set from scrollHeight");
  assert.equal(ta.style.maxHeight, "690.2px", "viewport-bounded max-height is recorded even when content fits");
  assert.equal(ta.style.overflowY, "hidden", "uncapped autosized textarea hides its internal scrollbar");
  assert.equal(ta.getAttribute("data-kinetic-padding-textarea-original-height"), "", "original inline height captured");
  assert.equal(ta.getAttribute("data-kinetic-padding-textarea-original-max-height"), "", "original inline max-height captured");
  assert.equal(ta.getAttribute("data-kinetic-padding-textarea-original-overflow-y"), "", "original inline overflow-y captured");
  assert.equal(readMarker(W).textAreaAutoSize, true);
  assert.equal(readMarker(W).active, true);
  assert.equal(readMarker(W).textAreaAutoSizeCount, 1);
  assert.equal(readMarker(W).textAreaAutoSizeCapped, 0);

  store.textAreaAutoSizeEnabled = false;
  W._listeners.forEach((fn) => fn({ textAreaAutoSizeEnabled: { oldValue: true, newValue: false } }, "local"));
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "style removed after disabling");
  assert.equal(ta.style.height, "", "original inline height restored");
  assert.equal(ta.style.maxHeight, "", "original inline max-height restored");
  assert.equal(ta.style.overflowY, "", "original inline overflow-y restored");
  assert.equal(ta.getAttribute("data-kinetic-padding-textarea-original-height"), null, "autosize bookkeeping removed");
  assert.equal(ta.getAttribute("data-kinetic-padding-textarea-original-max-height"), null, "max-height bookkeeping removed");
  assert.equal(ta.getAttribute("data-kinetic-padding-textarea-original-overflow-y"), null, "overflow-y bookkeeping removed");
  assert.equal(readMarker(W).textAreaAutoSize, false);
  assert.equal(readMarker(W).active, false);
});

test("runtime: text-area auto-size caps very tall content and restores prior inline scroll styles", () => {
  const ta = makeTextArea({ scrollHeight: 1475, height: "155px", maxHeight: "900px", overflowY: "scroll" });
  const store = { componentDensity: {}, textAreaAutoSizeEnabled: true };
  const W = makeWorld({ store, textareas: [ta] });
  M.install(W);

  assert.equal(ta.style.height, "690.2px", "height capped at 70vh on the 986px test viewport");
  assert.equal(ta.style.maxHeight, "690.2px", "max-height tracks the same cap for layout stability");
  assert.equal(ta.style.overflowY, "auto", "oversized textarea keeps internal scrolling");
  assert.equal(readMarker(W).textAreaAutoSizeCount, 1);
  assert.equal(readMarker(W).textAreaAutoSizeCapped, 1);

  store.textAreaAutoSizeEnabled = false;
  W._listeners.forEach((fn) => fn({ textAreaAutoSizeEnabled: { oldValue: true, newValue: false } }, "local"));
  assert.equal(ta.style.height, "155px", "pre-existing inline height restored");
  assert.equal(ta.style.maxHeight, "900px", "pre-existing inline max-height restored");
  assert.equal(ta.style.overflowY, "scroll", "pre-existing inline overflow-y restored");
  assert.equal(readMarker(W).textAreaAutoSizeCapped, 0);
});

test("runtime: text-area auto-size ignores unrelated mutation observer churn", () => {
  const ta = makeTextArea({ scrollHeight: 1475 });
  const store = { componentDensity: {}, textAreaAutoSizeEnabled: true };
  const W = makeWorld({ store, textareas: [ta] });
  M.install(W);

  const obs = W._observers[0];
  assert.ok(obs && typeof obs._cb === "function", "mutation observer is installed");
  const before = readMarker(W).textAreaAutoSizeScans;

  obs._cb([{ target: { nodeType: 1, nodeName: "DIV" }, addedNodes: [], removedNodes: [] }]);
  assert.equal(readMarker(W).textAreaAutoSizeScans, before, "unrelated style/class churn does not rescan textareas");

  obs._cb([{ target: ta, addedNodes: [], removedNodes: [] }]);
  assert.equal(readMarker(W).textAreaAutoSizeScans, before + 1, "textarea mutations still trigger autosize");
});

test("runtime: text-area auto-size does not replay stale preserved view scroll after later wheel", () => {
  const ta = makeTextArea({ scrollHeight: 1475 });
  const store = { componentDensity: {}, textAreaAutoSizeEnabled: true };
  const W = makeWorld({ store, textareas: [ta], autoFlushTimers: false });
  const api = M.install(W);

  W._scrollHost.scrollTop = 180;
  api.syncTextAreas();
  W._scrollHost.scrollTop = 360;
  W._flushTimers();

  assert.equal(W._scrollHost.scrollTop, 360, "deferred autosize scroll preservation must not pull back user wheel progress");
});

test("runtime: capped text-area boundary wheel forwards to the Kinetic view scroller", () => {
  const ta = makeTextArea({ scrollHeight: 1475 });
  const store = { componentDensity: {}, textAreaAutoSizeEnabled: true };
  const W = makeWorld({ store, textareas: [ta] });
  M.install(W);

  assert.equal(ta.style.height, "690.2px", "textarea starts capped");
  assert.equal(W._scrollHost.scrollTop, 0);
  const wheel = W._docListeners.wheel && W._docListeners.wheel[0];
  assert.equal(typeof wheel, "function", "wheel forwarder installed");

  let prevented = false;
  let stopped = false;
  ta.scrollTop = 200;
  wheel({ target: ta, deltaY: 300, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(W._scrollHost.scrollTop, 0, "normal in-textarea wheel is left alone before the boundary");
  assert.equal(prevented, false);
  assert.equal(stopped, false);

  ta.scrollTop = ta.scrollHeight - ta.clientHeight;
  wheel({ target: ta, deltaY: 300, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(W._scrollHost.scrollTop, 300, "downward boundary wheel advances the view scroller");
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(readMarker(W).textAreaWheelForwards, 1);
});

test("runtime: text-area auto-size coexists with component density CSS", () => {
  const ta = makeTextArea({ scrollHeight: 64 });
  const W = makeWorld({ store: { componentDensity: { grid: { rowHeight: 1.2 } }, textAreaAutoSizeEnabled: true }, textareas: [ta] });
  M.install(W);
  const css = appliedCss(W);
  assert.ok(css.indexOf(".k-grid td.k-table-td") >= 0, "density CSS still emitted");
  assert.ok(css.indexOf("resize: none !important;") >= 0, "text-area rule appended");
  assert.ok(css.indexOf("ep-view, .ep-view-content { overflow-y: auto !important;") >= 0,
    "view scroll rule is present for residual overflow");
  assert.equal(css.indexOf("ep-text-area textarea.k-textarea, .ep-text-area textarea.k-textarea { resize: none !important; overflow-y:"), -1,
    "textarea scrolling remains runtime-measured");
  assert.equal(ta.style.height, "64px");
  assert.equal(readMarker(W).active, true);
  assert.equal(readMarker(W).adjustments.length, 1);
  assert.equal(readMarker(W).textAreaAutoSize, true);
});

test("runtime: storage.onChanged ignores non-local areas and unrelated keys", () => {
  const store = { componentDensity: {} };
  const W = makeWorld({ store });
  M.install(W);
  store.componentDensity = { grid: { rowHeight: 1.5 } };
  W._listeners.forEach((fn) => fn({ componentDensity: { newValue: store.componentDensity } }, "sync"));
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "sync-area change ignored");
  W._listeners.forEach((fn) => fn({ colorOverrideValues: { newValue: {} } }, "local"));
  assert.equal(W.document.getElementById("kinetic-padding-control"), null, "unrelated key ignored");
});

test("runtime: idempotent install (second call returns same api, single element)", () => {
  const W = makeWorld({ store: { componentDensity: { grid: { rowHeight: 1.5 } } } });
  const a = M.install(W);
  const b = M.install(W);
  assert.equal(a, b, "same runtime api");
  assert.equal(W._head.children.filter((c) => c.id === "kinetic-padding-control").length, 1, "no double install");
});

test("runtime: uninstall removes <style> + marker and allows clean re-install", () => {
  const W = makeWorld({ store: { componentDensity: { grid: { rowHeight: 1.5 } } } });
  const api = M.install(W);
  api.uninstall();
  assert.equal(W.document.getElementById("kinetic-padding-control"), null);
  assert.equal(W._docEl.dataset.kineticPaddingControl, undefined);
  const api2 = M.install(W);
  assert.ok(api2 && api2.__installed, "re-install after uninstall works");
  assert.ok(W.document.getElementById("kinetic-padding-control"), "<style> back after re-install");
});

test("runtime: api.css()/state()/marker() reflect current state", () => {
  const W = makeWorld({ store: { componentDensity: { button: { font: 1.2 } } } });
  const api = M.install(W);
  assert.ok(api.css().indexOf("font-size") >= 0);
  assert.deepEqual(plain(api.state().componentDensity), { button: { font: 1.2 } });
  assert.equal(api.marker().active, true);
});
