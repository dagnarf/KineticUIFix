// padding-control.js — ISOLATED-world content script that adjusts Epicor Kinetic UI density
// PER COMPONENT FAMILY (grids, buttons, text fields, dropdowns, tabs, field labels) PLUS a
// "Cards & layout" family that scales the panel-card LAYOUT spacing to eliminate the grey white space
// BETWEEN components (column gutters, card padding, inter-field spacing). Each family exposes its own
// sliders (padding / field height / text size / layout spacing) that emit TARGETED, scoped CSS
// overrides matched to that family's real MetaUI/Kendo/Angular selectors. Sibling of
// src/theme-control.js and INDEPENDENT of the grid fixes: no debugger, no main.js rewrite, no tab
// reload — it applies LIVE. Default OFF (inert until the user moves a slider).
//
// WHY PER-FAMILY OVERRIDES, NOT TOKEN SCALING (investigation ground truth, live on CDP-9100
// Education SaaS950, 2026-06-05; see .tmp/padding-iter/*):
//   Kinetic ships the Kendo design-token system on :root, but Epicor's ep-*/erp-* Angular layer
//   OVERRIDES the visible chrome with HARDCODED px (much of it !important): e.g.
//     .ep-dropdown ... .k-input-inner { height: 40px }
//     .ep-short-control ... .k-input-inner { height: 24px !important }
//     ep-... .k-grid td { height: 22px; padding: 0 7px }
//   plus px font-size everywhere. So scaling --kendo-spacing-* / --kendo-font-size-* (the old v3.4
//   approach) was a near-NO-OP on real forms — PROVEN: spacing 1.8x and font 1.4x left the Order
//   Entry form visually identical; only pure-Kendo button/toolbar padding moved. The mechanism that
//   ACTUALLY reaches Epicor's chrome is a small set of `!important` rules matched to each family's
//   selectors, with values scaled by the user's per-family factor. A textbox height/font override
//   transformed the form live; a dropdown override needs COORDINATED handling of .k-input-value-text
//   (its value sits in a height:40/padding-top:17/overflow:hidden box, so a naive bigger font clips
//   the value — validated and fixed by scaling that box too).
//
// EMISSION MECHANISM:
//   one <style id="kinetic-padding-control"> whose textContent is buildCss(state) — plain CSS rules
//   like `.k-grid td.k-table-td { height: 38.4px !important; }`. Normal selectors + normal props, so
//   a text <style> is sufficient (unlike theme tokens there are no fractional custom-prop NAMES). It
//   wins via !important + last-in-<head> source order, reverts EXACTLY when the element is removed,
//   and never touches the inline <html style> attribute (where the tenant THEME tokens live), so an
//   Angular theme-rewrite cannot wipe it and it cannot disturb theme-control.
//
// NO-OP / VARIANT SAFETY: a dimension at its default factor (1) emits NO rule at all (true no-op);
//   only non-default factors produce CSS. Bases are the live-measured stock px for each family's main
//   size variant; forcing a rare off-size variant to base*factor is a minor visual quirk, never
//   breakage, and is bounded by the slider min/max.
//
// CONTRACT (mirrors theme-control.js so the popup + harness read a stable shape):
//   storage key: componentDensity — a nested map { familyKey: { dimKey: factor } }. The popup stores
//     ONLY non-default (factor !== 1) entries; an empty map => fully inert (no <style>, active:false).
//   storage key: textAreaAutoSizeEnabled — default false. When true, Kinetic text areas remove their
//     resize handle and the runtime writes reversible inline heights based on each textarea's scrollHeight.
//   storage key: fullWidthEnabled — default false. When true, Kinetic/AppStudio view shells, fixed headers,
//     panel cards, and panel-card grids can consume the full splitter pane width on ultrawide monitors.
//   marker (window.__KINETIC_PADDING_CONTROL__ + documentElement.dataset.kineticPaddingControl):
//     { version, active, adjustments:[{family,dim,factor}], ruleCount, reasserts, spacerWrites,
//       textAreaAutoSize, textAreaAutoSizeCount, textAreaAutoSizeWrites, fullWidth }.
//
// HYGIENE (CLAUDE.md Kinetic-runtime principles): explicit semicolons; fail-safe (never throws into
//   the page); idempotent (per-window install guard + single element id); observers/timers registered
//   for teardown; bounded loops. The pure engine has no DOM / no chrome.* and is dual-exported for
//   headless tests.

(function (root) {
  "use strict";

  var VERSION = "3.31.0";                               // full-width AppStudio view/card mode (CDP-9100, 2026-06-10)
  var STYLE_ID = "kinetic-padding-control";
  var MARKER_KEY = "__KINETIC_PADDING_CONTROL__";
  var DATASET_KEY = "kineticPaddingControl";            // -> attribute data-kinetic-padding-control
  var HOST_SUFFIX = ".epicorsaas.com";                  // only adjust Epicor SaaS origins (Safety)
  var STORAGE_KEYS = ["componentDensity", "textAreaAutoSizeEnabled", "fullWidthEnabled", "customHostPatterns"];
  var EPS = 1e-9;                                       // a factor within EPS of its default is "off"
  var TEXTAREA_SELECTOR = "ep-text-area textarea.k-textarea, .ep-text-area textarea.k-textarea";
  var TEXTAREA_ORIGINAL_HEIGHT_ATTR = "data-kinetic-padding-textarea-original-height";
  var TEXTAREA_AUTOSIZED_ATTR = "data-kinetic-padding-textarea-autosized";
  var FULL_WIDTH_CSS = [
    "ep-view.page-content.header-width, ep-view.page-content, .ep-component-top-element.ep-view, .ep-view-content { width: 100% !important; max-width: none !important; }",
    "#ep-view-header, #ep-view-header.ep-view-fixed-header { width: auto !important; max-width: none !important; right: 10px !important; }",
    "ep-panel-card, ep-panel-card-grid, erp-panel-card-grid, metafx-panel-card, metafx-panel-card-grid, .ep-component-top-element.ep-panel-card, .ep-component-top-element.ep-panel-card-grid, .ep-panel-card, .ep-panel-card-grid, .erp-panel-card-grid { display: block !important; width: 100% !important; max-width: none !important; }",
    ".ep-panel-card .ep-content, .ep-panel-card-grid .ep-content { width: 100% !important; max-width: none !important; }"
  ].join("\n");

  // ===================================================================================================
  // FAMILIES — the single source of truth. Each family groups one Epicor/Kendo component type and the
  // dimensions a user can scale for it. Each dimension declares the CSS RULES it emits: a selector plus
  // the properties to pin, each with its live-measured stock px `base`. Emitted value = round(base*f)+px,
  // !important. key/label/min/max/step/def are mirrored verbatim into popup.js FAMILIES (lockstep,
  // asserted by the popup-logic test). The `rules` table lives here only (runtime's stock data).
  //
  // Selectors are deliberately SCOPED so a family's slider only moves that family (e.g. text fields use
  // .k-textbox/.k-numerictextbox; dropdowns use .k-combobox/.k-dropdownlist/.k-picker; they never share
  // a bare .k-input-inner). Live-validated selectors + bases — see .tmp/padding-iter/fam.mjs.
  // ===================================================================================================

  var DIM_FONT = { min: 0.8, max: 1.6, step: 0.05, def: 1 };   // shared range for "Text size" dims

  var FAMILIES = [
    {
      key: "grid", label: "Grids", dims: [
        {
          key: "rowHeight", label: "Row height", min: 0.6, max: 1.8, step: 0.05, def: 1,
          rules: [
            // height/min-height set the cell box; line-height lets the row actually COMPRESS below the
            // stock content height (compact) and adds breathing room (roomy) — a fixed height alone
            // can't shrink a row below its content's line-height (live-validated). Covers pure-Kendo
            // grids + headers (stock td/th ~24px on the Order-Entry size variant).
            { sel: ".k-grid td.k-table-td, .k-grid th.k-table-th", props: [
              { name: "height", base: 24 }, { name: "min-height", base: 24 }, { name: "line-height", base: 20 }
            ] },
            // THE REAL ROW-HEIGHT FLOOR in Epicor grids: the data cell wrapper is pinned by
            //   `.ep-grid .k-grid tr td .ep-grid-cell { line-height: 22px }`   (specificity 0,3,1)
            // and `... > .ep-grid-cell { height: 100% }`, so scaling only the <td> can't shrink the row
            // below the cell's 22px content box (live-proven: td 24->14.4 left the row at 23px until the
            // cell line-height was scaled too -> row 23->17 at f=0.6). Match at >= 0,3,1 and scale the
            // cell's line-height + height by the SAME factor so the row truly compacts/expands. This is
            // what makes the lever effective on real forms (Order Tracker / Sales Order virtual grids).
            // Coexists with Kendo virtual scrolling through the runtime spacer synchronizer below:
            // Kendo can measure/build its .k-height-container before chrome.storage applies the saved
            // density factor, so CSS alone can compress rows while leaving the stock scroll range behind
            // (live-repro: rowHeight 0.6 -> spacer 2328px, table ~1397px, blank tail at wheel bottom).
            // syncGridScrollSpacers() scales that spacer by the SAME factor and restores it on revert.
            { sel: ".ep-grid .k-grid tr td .ep-grid-cell", props: [
              { name: "line-height", base: 22 }, { name: "height", base: 22 }
            ] },
            // The row's true floor is the TALLEST cell. Epicor select/edit columns embed a fixed-height
            // <input> (live: a 24px field) that the cell rules above don't touch, so without this the
            // row can't shrink below ~24px even when every text cell is scaled (live-proven: row stuck at
            // 23px until the input was scaled too -> row 25->15 at f=0.6, glyphs/checkboxes uncliped).
            // Scale in-cell inputs by the SAME factor so the whole row compacts uniformly.
            { sel: ".ep-grid .k-grid tbody td.k-table-td input", props: [
              { name: "height", base: 24 }, { name: "min-height", base: 24 }
            ] },
            // The Kinetic boolean-cell checkbox is an MDI ICON-FONT glyph (.ep-grid-cell-check.mdi),
            // sized purely by its font-size — the ::before icon INHERITS that size (live-proven: a
            // font-size override on the span moved the rendered icon). At stock it is a fixed ~24px that
            // does NOT track the row, so a compacted row clips the glyph and an expanded row leaves it
            // tiny. Scale the glyph's font-size (the icon size lever) + line-height by the SAME rowHeight
            // factor so the checkbox fits the row at every density (24/12 are the live-measured stock px,
            // shared with grid-checkbox-style-fix.js's canonical). The selector carries ONE class MORE
            // than that standardizer's `.ep-grid-cell-check.mdi` pin, so when BOTH features run this
            // density scale WINS the cascade (higher specificity beats source order); the standardizer
            // then samples the already-scaled glyph and agrees, so they coexist without fighting.
            { sel: ".k-grid .ep-grid-cell-check.mdi", props: [
              { name: "font-size", base: 24 }, { name: "line-height", base: 12 }
            ] }
          ]
        },
        {
          // HORIZONTAL information density — the strongest lever for fitting more columns on screen.
          // The cell's horizontal inset does NOT live on the <td> (its padding is 0 in Epicor grids);
          // it lives on the Epicor wrapper span. The winning stock rule is
          //   `.ep-grid .k-grid td > .ep-grid-cell { padding: 0 7px !important; }`   (specificity 0,3,1)
          // so a scoped !important <td> rule LOSES — we must match at >= that specificity + !important.
          // Headers are pinned by `.ep-grid .k-grid .k-header { padding-left: 7px !important; }` (0,3,1);
          // scale the header inset with the SAME factor so column titles stay aligned with the data
          // cells beneath them (header's internal .k-cell-inner -9 / .k-link +9 margins self-cancel, so
          // only the th's own padding-inline needs scaling). Both bases are the live-measured stock 7px.
          // Live-validated on CDP-9100 Education (Order Tracker / Sales Order grid): 7 -> 2.1 (compact)
          // and 7 -> 12.6 (roomy) on both data + header, columns repack cleanly, exact revert. See
          // .tmp/padding-iter/cellpad-live2.mjs + .tmp/padding-iter/matched3.mjs (cascade proof).
          key: "cellPad", label: "Cell padding", min: 0.3, max: 2, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-grid .k-grid td.k-table-td > .ep-grid-cell", props: [
              { name: "padding-left", base: 7 }, { name: "padding-right", base: 7 }
            ] },
            { sel: ".ep-grid .k-grid th.k-header.k-table-th", props: [
              { name: "padding-left", base: 7 }, { name: "padding-right", base: 7 }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: 1.5, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            // Header text (.k-column-title) scales here — but this rule ALONE moved ONLY the header:
            // Epicor pins an explicit `font-size: 14px` on the .ep-grid-cell data wrapper that overrides
            // the <td>'s inherited size, so a <td> font override never reaches the row values
            // (live-proven on Order Tracker: <td> -> 21px left the cell text stuck at 14px).
            { sel: ".k-grid .k-table-td, .k-grid .k-table-th, .k-grid .k-column-title", props: [
              { name: "font-size", base: 14 }
            ] },
            // THE ROW-TEXT FIX: pin the data-cell wrapper's font-size at >= its stock specificity +
            // !important so the lever reaches the VISIBLE row values, not just the column headers
            // (live-proven: this moved the cell text 14 -> 21 at f=1.5 where the <td> rule did not).
            // Inner text spans carry no own font-size, so they inherit this scaled value.
            { sel: ".ep-grid .k-grid td.k-table-td .ep-grid-cell", props: [
              { name: "font-size", base: 14 }
            ] }
          ]
        }
      ]
    },
    {
      key: "button", label: "Buttons", dims: [
        {
          key: "padding", label: "Padding", min: 0.5, max: 2, step: 0.05, def: 1,
          rules: [
            { sel: ".k-button.k-button-md, .k-button.k-button-sm, .k-button.k-button-lg, .k-button", props: [
              { name: "padding-top", base: 4 }, { name: "padding-bottom", base: 4 }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: DIM_FONT.max, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: ".k-button", props: [ { name: "font-size", base: 12 } ] }
          ]
        }
      ]
    },
    {
      key: "textbox", label: "Text fields", dims: [
        {
          // Compacts the WHOLE field, eliminating the white space below the value. The value sits near
          // the top (inner padding-top floats it under the label), so scaling the inner box height + the
          // field control + the floating-label WRAP by the factor trims the dead space from the bottom.
          // NOTE the wrap is the PARENT of `.k-textbox`/`.k-numerictextbox` (a `kendo-floatinglabel`), so
          // it must be matched with `:has()` (Chrome 114+, our min) — a descendant
          // `.k-textbox .k-floating-label-container` NEVER matches and left the 40px wrap un-compacted.
          // Scoped to .ep-panel-card so only form fields compact (search/login floating labels untouched).
          //
          // VALUE padding-top is deliberately NOT scaled (left at Epicor's native 17). The value control
          // (`.k-numerictextbox`/`.k-textbox`) is `overflow:hidden` and the floating-label layout seats its
          // TOP ~18px below the field top (room for the floated label), while the inner input is pulled up to
          // the field top — so that wrapper's top edge is a FIXED clip ~18px down. The original `17*f` scaling
          // drove padding-top to 11.9 at f=0.7, which centred the value text ABOVE that clip edge → the digit
          // TOPS were shaved (live-confirmed by pixel scan on Order Tracker's "5413"). Keeping the native 17
          // re-centres the value in the clean band BELOW the clip edge: full digit, ~1.75px top clearance,
          // ~1.3px bottom. The field still compacts via height/min-height; dead space is trimmed from the
          // bottom, not by moving the value. Pairs with the floated-label LIFT rule below (clears the label
          // off the value — gap ~9px). Live-pixel-validated full 7px digit at f=0.7. See .tmp/glyph-iter/.
          key: "height", label: "Field height", min: 0.7, max: 1.6, step: 0.05, def: 1,
          rules: [
            { sel: ".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner, .k-maskedtextbox .k-input-inner", props: [
              { name: "height", base: 40 }, { name: "min-height", base: 40 }
            ] },
            { sel: ".k-textbox.k-input, .k-numerictextbox.k-input, .k-maskedtextbox.k-input", props: [
              { name: "height", base: 40 }, { name: "min-height", base: 40 }
            ] },
            { sel: ".ep-panel-card .k-floating-label-container:has(.k-textbox, .k-numerictextbox, .k-maskedtextbox)", props: [
              { name: "height", base: 40 }, { name: "min-height", base: 40 }
            ] },
            // SUMMARY CURRENCY "$" PREFIX alignment. The summary boxes (Charges/Discount/Misc/Tax/...) are
            // an `.erp-currency` flex row of a `.currency-symbol` ($ prefix) + an `.erp-numeric-box` value.
            // The $ prefix is `position:absolute; top:20px` — a constant tuned for the STOCK 40px field. As
            // the field compacts, the value rises (padding-top 17→17*f) but the $ stayed pinned at 20px, so
            // it printed too low and cascaded into the NEXT row's label (live-seen at all-min). Scale that
            // top with the SAME height factor so the $ tracks the value. Base 12 (not 20): the $ box is
            // vertically-centered while the value sits at padding-top, so a proportional 20*f left the $ a
            // few px low at the compact end; 12 (→8.4 at f=0.7) centers the $ on the value. Inert at f=1 so
            // the native 20px is untouched at stock. Live-validated: $ aligns with 0.00, no row overlap.
            { sel: ".erp-currency .currency-symbol", props: [
              { name: "top", base: 12 }
            ] },
            // EMBEDDED SEARCH ICON (the magnify / file-find glyph on key-field search boxes, e.g. Order
            // Tracker's "Sales Order"). It's an absolutely-positioned, flex-centered 40×40 box (stock
            // padding 20) that does NOT track the field height — so once the field compacts to 28px the
            // 40px icon overflowed the bottom by 12px and its centered glyph sat ~6px BELOW the field
            // centre (looked cut off + off-centre, the user-reported defect). Scale the box height + padding
            // by the SAME height factor so the flex-centered glyph re-centres in the shrunk box with no
            // overflow (40→28 / 20→14 at f=0.7 = glyph dead-centre, 0 overflow — live-validated). Scoped to
            // .ep-panel-card text/numeric boxes so the global top-bar search icon (a different 20×18 glyph,
            // never in a panel card) is untouched. Inert at f=1 (stock 40/20).
            { sel: ".ep-panel-card ep-numeric-box .ep-search-icon, .ep-panel-card ep-text-box .ep-search-icon", props: [
              { name: "height", base: 40 }, { name: "padding", base: 20 }
            ] },
            // FLOATED-LABEL LIFT (anti-collision). The floated label is anchored to the container top by a
            // Kendo inline `transform: translateY(4px)` that does NOT change with field height; as the field
            // compacts the value rises toward it until "Sales Order" overlapped "5413" (the user-reported
            // collision; reproduced on every compacted floating-label field). Lift the floated label so it
            // clears the value: translateY = AFFINE base 20, offset -16 → +4 (stock) at f=1, -2 at f=0.7,
            // clampMax 4 so it NEVER pushes the label DOWN on expansion (f>1, where there's already room).
            // Our !important beats Kendo's non-important inline transform. Scoped with :not(.k-empty) so it
            // touches FLOATED labels only — empty-field PLACEHOLDERS (which use the transform to centre) are
            // left alone. :has() limits it to this family's controls so it scales by the textbox factor.
            // Live-validated: label/value ink gap +8px at f=0.7, no animation regression on focus.
            { sel: ".ep-panel-card .k-floating-label-container:not(.k-empty):has(.k-textbox, .k-numerictextbox, .k-maskedtextbox) .k-floating-label", props: [
              { name: "transform", base: 20, offset: -16, clampMax: 4, wrap: "translateY(@)" }
            ] },
            // LOGIN SCREEN EXCEPTION — graceful proportional compaction (parallels the dropdown family's login
            // exception; see the dropdown `height` dim for the full rationale). A non-default auth mode (native
            // Epicor / IdentityServer account) renders username/password TEXT fields in the same panel-card-less
            // `.ep-login-view`, so the global text-input height rules above would shrink them while the panel-
            // card label-lift never fires — the identical label/value collision class. PIN the login text input
            // to STOCK 40px (base:0 + offset constant) so it is a clean stock field again, then `zoom: f` the
            // field so it compacts PROPORTIONALLY without overlap. The Azure-AD login on Fifth exposes only the
            // dropdown (that path is live-validated); this is the structurally-identical text-field parallel,
            // scoped to .ep-login-view so it can never touch panel-card form fields.
            { sel: ".ep-login-view .k-textbox .k-input-inner, .ep-login-view .k-numerictextbox .k-input-inner, .ep-login-view .k-maskedtextbox .k-input-inner", props: [
              { name: "height", base: 0, offset: 40 }, { name: "min-height", base: 0, offset: 40 }
            ] },
            { sel: ".ep-login-view .k-textbox.k-input, .ep-login-view .k-numerictextbox.k-input, .ep-login-view .k-maskedtextbox.k-input", props: [
              { name: "height", base: 0, offset: 40 }, { name: "min-height", base: 0, offset: 40 }
            ] },
            { sel: ".ep-login-view .k-floating-label-container:has(.k-textbox, .k-numerictextbox, .k-maskedtextbox)", props: [
              { name: "zoom", base: 1, offset: 0, unit: "" }
            ] },
            // PANEL-BAR HEADER SEARCH-BOX EXCEPTION — the key-field search textbox in a panel-card
            // expanded-header band (`.ep-panel-bar-title .erp-search-box`, e.g. Supplier Tracker's
            // "Supplier" box) is the DIRECT-input markup variant: the `<input>` itself carries
            // `.k-textbox.k-input` (no `.k-input-inner` child), so the form-field clip-edge rationale
            // above (keep padding-top at native 17) does NOT hold — the input IS the visible 40f box, and
            // the stock padding-top 17 / line-height 18 seated the typed value ON the underline, 7px past
            // the 28px box bottom at f=0.7 (live-repro QAGO1090, 2026-06-10). Kendo state machine here:
            // resting placeholder = label `top:19 + translateY(-12)` (a +7 CONSTANT seat, ink ~2.5px low
            // of centre in the compacted box); floated (`.k-focus` on the wrap — k-empty persists while
            // typing because the model binds on blur — or `:not(.k-empty)` after commit) = `top:0 +
            // translateY(4)` with the label line STACKED 0.1px above the value band in stock. Fix =
            // stock-PROPORTIONAL vertical scaling (value padding/line/font and floated-label line/font
            // all ×f) plus an affine separation that vanishes at f=1: value padding-top 12f+5 (17 stock,
            // 13.4 at min) and floated-label translateY(9f-5) (4 stock, 1.3 at min) open a ~4px ink gap
            // where pure proportion left 0.07px (reads as collision at small sizes); empty-resting
            // placeholder re-seats to top 7f+12 (net 7f against the constant translateY(-12)) so its ink
            // centres. The `.k-focus`/`:not(.k-empty)` split must NOT touch `top` — Epicor's own floated
            // state pins `top:0` and an !important top here breaks the float (live-burned). All-states
            // live-validated (rest-empty / focus-empty / focus-text / blur-text) at f=0.7.
            { sel: ".ep-panel-bar-title .erp-search-box input.k-textbox.k-input", props: [
              { name: "padding-top", base: 12, offset: 5 }, { name: "line-height", base: 18 }, { name: "font-size", base: 14 }
            ] },
            { sel: ".ep-panel-bar-title .erp-search-box .k-floating-label-container.k-empty:not(.k-focus) .k-floating-label", props: [
              { name: "top", base: 7, offset: 12 }
            ] },
            { sel: ".ep-panel-bar-title .erp-search-box .k-floating-label-container.k-focus .k-floating-label, .ep-panel-bar-title .erp-search-box .k-floating-label-container:not(.k-empty) .k-floating-label", props: [
              { name: "font-size", base: 11.2 }, { name: "line-height", base: 18 }, { name: "transform", base: 9, offset: -5, wrap: "translateY(@)" }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: DIM_FONT.max, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: ".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner, .k-maskedtextbox .k-input-inner", props: [
              { name: "font-size", base: 14 }
            ] },
            // Scale the summary "$" prefix font with the value font so they match size (else the unscaled
            // 14px $ sits visually lower than the smaller value digits).
            { sel: ".erp-currency .currency-symbol input", props: [
              { name: "font-size", base: 14 }
            ] }
          ]
        },
        {
          // Internal HORIZONTAL inset — the "white space to margins" inside a text field. Both the value
          // (`.k-input-inner`) and the floating label sit 10px in from the border (live-measured stock);
          // scale both by the same factor so they stay left-aligned. Scoped away from comboboxes/pickers
          // (those are the dropdown family's). Live-validated 10→4 on Order Entry, value/label readable.
          key: "padding", label: "Inner padding", min: 0.2, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".k-textbox .k-input-inner, .k-numerictextbox .k-input-inner, .k-maskedtextbox .k-input-inner", props: [
              { name: "padding-left", base: 10 }
            ] },
            { sel: ".k-textbox .k-floating-label, .k-numerictextbox .k-floating-label", props: [
              { name: "padding-left", base: 10 }, { name: "padding-right", base: 10 }
            ] }
          ]
        }
      ]
    },
    {
      key: "dropdown", label: "Dropdowns", dims: [
        {
          // Compacts the WHOLE dropdown/date/time field. Like the textbox the floating-label WRAP is the
          // PARENT (matched via :has, scoped to .ep-panel-card). The selected value sits LOW (the picker's
          // padding-top:17 floats it under the label, and its box overflows the wrap bottom), so trimming
          // the wrap alone CLIPS the value — we must also pull the value up by scaling that padding-top by
          // the SAME factor (combobox/dropdownlist only; date/time position their value via the inner, so
          // they need only the wrap trim). Live-validated 40→30 on Order Entry: value hugs label, no clip.
          key: "height", label: "Field height", min: 0.7, max: 1.6, step: 0.05, def: 1,
          rules: [
            { sel: ".k-combobox.k-picker .k-input-inner, .k-dropdownlist.k-picker .k-input-inner, .k-picker-md.k-picker .k-input-inner, .k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner", props: [
              { name: "height", base: 40 }, { name: "min-height", base: 40 }
            ] },
            { sel: ".k-combobox.k-picker, .k-dropdownlist.k-picker, .k-picker-md.k-picker, .k-datepicker.k-picker, .k-timepicker.k-picker, .k-datepicker.k-input, .k-timepicker.k-input", props: [
              { name: "height", base: 40 }, { name: "min-height", base: 40 }
            ] },
            // Coordinated: the value text lives in a fixed height:40/padding-top:17/overflow:hidden box;
            // scale it too or a bigger value clips (live-validated fix).
            { sel: ".k-combobox.k-picker .k-input-value-text, .k-dropdownlist.k-picker .k-input-value-text, .k-picker-md.k-picker .k-input-value-text", props: [
              { name: "height", base: 40 }, { name: "padding-top", base: 12 }, { name: "line-height", base: 20 }
            ] },
            // The floating-label WRAP (combobox/dropdownlist/date/time) — trims the dead space below value.
            { sel: ".ep-panel-card .k-floating-label-container:has(.k-combobox, .k-dropdownlist, .k-datepicker, .k-timepicker)", props: [
              { name: "height", base: 40 }, { name: "min-height", base: 40 }
            ] },
            // Value-pull: the combobox/dropdownlist control's padding-top floats the value under the label;
            // scale it so the value rises as the wrap shrinks (prevents bottom clipping). Date/time excluded.
            // Base is 12 (not the native 17): the value box is an 18px line, so a proportional 17*0.7≈12
            // still left it 2px below the 28px compact wrap (live-clipped); pulling from 12 (→8.4 at min)
            // clears it. Inert at factor 1 (the dim emits nothing), so the native 17 is untouched at stock.
            { sel: ".k-combobox.k-input, .k-dropdownlist.k-picker", props: [
              { name: "padding-top", base: 12 }
            ] },
            // Date/time picker inputs carry their own larger value padding and escaped the combobox
            // value-pull rule. Scale the padding/line-height so compact date fields remain readable.
            { sel: ".k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner", props: [
              { name: "padding-top", base: 15 }, { name: "line-height", base: 20 }
            ] },
            // HOME SETTINGS FLYOUT EXCEPTION. The left user settings menu uses short 28px dropdowns
            // outside panel cards, but Kendo still applies floating-label translateY offsets to the
            // dropdown and inner value. The global dropdown height rules make those offsets visible as
            // value/label overlap. Reset only that flyout; panel-card form fields keep the density lift.
            { sel: ".ep-user-settings .k-dropdownlist.k-picker, .ep-user-settings .k-picker-md.k-picker", props: [
              { name: "transform", base: 0, wrap: "translateY(@)" }, { name: "padding-top", base: 0 }
            ] },
            { sel: ".ep-user-settings .k-dropdownlist.k-picker .k-input-inner, .ep-user-settings .k-picker-md.k-picker .k-input-inner", props: [
              { name: "transform", base: 0, wrap: "translateY(@)" }
            ] },
            // LOGIN SCREEN EXCEPTION — graceful proportional compaction. The Kinetic login view
            // (`khp-login` > `ep-erp-login` > `.ep-login-view`) hosts an auth-mode dropdown OUTSIDE any panel
            // card, so the panel-card-scoped value-pull (line ~310) and label-lift (line ~348) never fire —
            // while the GLOBAL value-text/inner/picker height rules above still shrink its value box and drop
            // the value's padding-top (17→8.4 at f=0.7), raising the value glyphs INTO the floating label.
            // Live-repro on Fifth (CDP-9100, 2026-06-08): the "User Account Type" label overprinted the
            // "Azure Active Directory: FIFTH" value. Epicor restyles this label to `position:relative;order:1;
            // translateY(4px)` (a mid-field caption, NOT the panel-card float-above), so neither a label-lift
            // affine nor a value-padding reserve clears it robustly across the factor range (both verified to
            // fail mid-range live). The user wants the login box SHRUNK like the rest, just not overlapping.
            // SOLUTION: (1) PIN the dropdown internals back to STOCK (base:0 + offset = a constant regardless
            // of factor, per emitProp) so the field is a CLEAN stock login again, immune to the global value-
            // pull; then (2) `zoom: f` the whole floating-label field so it shrinks PROPORTIONALLY — label,
            // value and spacing scale together. A scaled CLEAN login can't overlap (it is stock at scale f),
            // and it is continuous with stock at f=1. Live-validated across f∈{0.7..0.99}: visual height
            // 28→40px, value padding-top stays 17, only the benign stock box-overlap (text sits low) remains;
            // screenshot at f=0.7 shows a tidy 28px field, label cleanly above value. Scoped to .ep-login-view
            // (+ the global compound) so specificity AND later source order beat the global rules.
            { sel: ".ep-login-view .k-input-value-text", props: [
              { name: "height", base: 0, offset: 40 }, { name: "padding-top", base: 0, offset: 17 }, { name: "line-height", base: 0, offset: 18 }
            ] },
            { sel: ".ep-login-view .k-dropdownlist.k-picker .k-input-inner, .ep-login-view .k-picker-md.k-picker .k-input-inner", props: [
              { name: "height", base: 0, offset: 40 }, { name: "min-height", base: 0, offset: 40 }
            ] },
            { sel: ".ep-login-view .k-dropdownlist.k-picker, .ep-login-view .k-picker-md.k-picker", props: [
              { name: "height", base: 0, offset: 40 }, { name: "min-height", base: 0, offset: 40 }, { name: "padding-top", base: 0, offset: 16 }
            ] },
            { sel: ".ep-login-view .k-floating-label-container:has(.k-combobox, .k-dropdownlist, .k-datepicker, .k-timepicker)", props: [
              { name: "zoom", base: 1, offset: 0, unit: "" }
            ] },
            // SHELL ACCOUNT PANEL EXCEPTION — company/site/workstation dropdowns are Kendo
            // `ep-adaptive-mode` pickers whose action sheet is rendered INSIDE the dropdown host. The
            // compact field rules make that host 28px tall; Kendo also leaves an identity transform on the
            // host, so Chrome treats the fixed-position action sheet as contained by that tiny transformed
            // box. Result: the bottom sheet collapses to the field rectangle and list item hit-testing needs
            // repeated clicks. Pin only these shell-account adaptive hosts back to stock geometry, remove
            // the containing-block transform, and allow overflow so the action sheet can cover the panel.
            { sel: ".ep-shell-account-panel kendo-dropdownlist.ep-adaptive-mode.k-dropdownlist.k-picker", props: [
              { name: "height", base: 0, offset: 40 }, { name: "min-height", base: 0, offset: 40 },
              { name: "padding-top", base: 0, offset: 16 }, { name: "transform", base: 0, unit: "", wrap: "none" },
              { name: "overflow", base: 0, unit: "", wrap: "visible" }
            ] },
            { sel: ".ep-shell-account-panel kendo-dropdownlist.ep-adaptive-mode.k-dropdownlist.k-picker > .k-input-inner", props: [
              { name: "height", base: 0, offset: 40 }, { name: "min-height", base: 0, offset: 40 },
              { name: "transform", base: 0, unit: "", wrap: "none" }
            ] },
            { sel: ".ep-shell-account-panel kendo-dropdownlist.ep-adaptive-mode.k-dropdownlist.k-picker > .k-input-inner .k-input-value-text", props: [
              { name: "height", base: 0, offset: 40 }, { name: "padding-top", base: 0, offset: 17 }, { name: "line-height", base: 0, offset: 18 }
            ] },
            // EMBEDDED SEARCH ICON on searchable comboboxes (customer/part/etc. lookups) — same 40×40
            // flex-centred glyph as the textbox family; scale it so it re-centres in the compacted field
            // (see the textbox icon rule for the full rationale). Scoped to combobox wrappers in panel cards.
            { sel: ".ep-panel-card ep-combo-box .ep-search-icon", props: [
              { name: "height", base: 40 }, { name: "padding", base: 20 }
            ] },
            // FLOATED-LABEL LIFT (anti-collision) — comboboxes/dropdowns float a label exactly like text
            // fields, and the value-pull above raises the value even higher, so their labels collided WORSE
            // (live-seen ~14px on BTCustID/PrcConNum/ShpConNum). Same affine translateY as the textbox lift
            // (base 20, offset -16, clampMax 4): +4 stock, -2 at f=0.7, never pushed down on expansion.
            // :not(.k-empty) keeps empty placeholders centred; :has() scopes it to dropdown-family controls
            // so it scales by the dropdown factor. Live-validated: the 3 colliding comboboxes clear.
            { sel: ".ep-panel-card .k-floating-label-container:not(.k-empty):has(.k-combobox, .k-dropdownlist, .k-datepicker, .k-timepicker) .k-floating-label", props: [
              { name: "transform", base: 20, offset: -16, clampMax: 4, wrap: "translateY(@)" }
            ] },
            // COMBOBOX/DROPDOWNLIST TOGGLE-ARROW re-centre — the chevron toggle button (`.k-input-button`)
            // is `position:relative; top:12px` (stock), which seats the 20px chevron in the 40px field
            // (12→32, fits with ~8px to spare). UNLIKE the date/time button (which is position:ABSOLUTE,
            // so its `top` is measured from the host top and padding-independent), this button is a flex
            // CHILD of the host, so its in-flow start moves down by the host's padding-top. The value-pull
            // rule above adds `padding-top: 12f` to the host flex container to raise the value; that same
            // padding pushes THIS button down too, and the host simultaneously shrinks to 40f. At f=0.7 the
            // button landed at 8.4(pad)+12 = 20px in a 28px host and overflowed the bottom by 12px — the
            // chevron glyph was clipped (live-repro on the panel-bar-header "All" dropdownlist, CDP-9100
            // 2026-06-08). Re-centre accounting for the flow offset: final top = hostPad(12f) + top_css must
            // equal the centred (40f-20)/2, so top_css = 8f-10 (base 8, offset -10): -4.4 at f=0.7 →
            // btnTopRel 8.4-4.4 = 4 in a 28px host (chevron dead-centre, 4px clearance each side), correct at
            // any factor since pad and host both scale linearly with f. Inert at f=1 (dim skipped → stock
            // top:12px, exact revert). EXCLUDES date/time (different class) — those keep their absolute rule
            // below. `.ep-panel-card`-scoped so the login/user-settings/shell-account exceptions (which pin
            // the host back to 40px and are NOT panel cards) are untouched. Live-validated 2026-06-08.
            { sel: ".ep-panel-card .k-combobox.k-picker .k-input-button, .ep-panel-card .k-dropdownlist.k-picker .k-input-button", props: [
              { name: "top", base: 8, offset: -10 }
            ] },
            // PANEL-BAR HEADER EXCEPTION — dropdowns hosted in a panel-card expanded-header band
            // (`.ep-panel-header-elements`, e.g. the Supplier Tracker "All" view picker) have NO floating
            // label: stock host padding-top is 0 and the auto-height value text is flex-CENTRED in the
            // 40px host. The global value-pull (`padding-top: 12f` on the host) plus the value-text box
            // rule (height 40f / padding-top 12f / line-height 20f) assume the panel-card floating-label
            // geometry and pushed this label-less value 2×8.4px DOWN at f=0.7 — text overflowed the 28px
            // host bottom (live-repro Supplier Tracker QAGO1090, CDP-9100, 2026-06-10; the v3.25.0 chevron
            // re-centre fixed the arrow in this exact spot but not the text). Restore the stock centring
            // MODEL while keeping the compaction: zero the host pad, give the value back its auto-height/
            // normal-line flex-centred box, and re-centre the chevron for a pad-0 host (top = (40f-20)/2 =
            // 20f-10, vs the global 8f-10 which assumes a 12f host pad). Constant pins are factor-
            // independent; rules emit only while the dim is active so stock is untouched at f=1.
            { sel: ".ep-panel-header-elements .k-combobox.k-input, .ep-panel-header-elements .k-dropdownlist.k-picker, .ep-panel-header-elements .k-picker-md.k-picker", props: [
              { name: "padding-top", base: 0 }
            ] },
            { sel: ".ep-panel-header-elements .k-combobox.k-picker .k-input-value-text, .ep-panel-header-elements .k-dropdownlist.k-picker .k-input-value-text, .ep-panel-header-elements .k-picker-md.k-picker .k-input-value-text", props: [
              { name: "height", base: 0, unit: "", wrap: "auto" }, { name: "padding-top", base: 0 }, { name: "line-height", base: 0, unit: "", wrap: "normal" }
            ] },
            { sel: ".ep-panel-card .ep-panel-header-elements .k-combobox.k-picker .k-input-button, .ep-panel-card .ep-panel-header-elements .k-dropdownlist.k-picker .k-input-button", props: [
              { name: "top", base: 20, offset: -10 }
            ] },
            // DATE-PICKER CALENDAR + TIME-PICKER CLOCK glyph — the toggle button (`.k-input-button`) is
            // `position:absolute; top:10px`, a constant that centres a 20px button in the STOCK 40px field;
            // at the compacted field it sat ~6px too LOW and overflowed the bottom (live: Order Date calendar
            // bled into the next row). RE-CENTRE: `top` AFFINE base 20, offset -10 = (40f-20)/2 → 10 at f=1,
            // 4 at f=0.7 — centres the 20px button at ANY field height (no clamp needed; correct on expansion).
            // HORIZONTAL ALIGN: Kendo natively gives the TIME button `right:7px` but the DATE button `right:5px`,
            // so the clock's separator line + glyph sat 2px LEFT of the calendars' (live-measured: line x1129 vs
            // x1131). Pin both to a constant 5px (base 0 = does NOT scale; offset 5 = the date's native gap) so
            // the toggle button — and with it the border-left "vertical line" + the glyph — line up across every
            // date/time field in the column. Live: all lines at x1131, all glyph centres at x1142.
            { sel: ".ep-panel-card .k-datepicker .k-input-button, .ep-panel-card .k-timepicker .k-input-button", props: [
              { name: "top", base: 20, offset: -10 }, { name: "right", base: 0, offset: 5 }
            ] },
            // SCALE the glyph with the field (stock 24px is oversized for a 28px field). Two DIFFERENT render
            // paths: the date calendar is an MDI font glyph on the icon's `::before` (24px in a 40×40 box —
            // the Kendo SVG is hidden), so scale that pseudo's font-size + box; the time clock is the real
            // Kendo `<svg>` (24×24, no `::before`), so scale the icon AND the svg child (the svg ignores the
            // parent's height alone). Both → ~16.8px at f=0.7, matched to the search-icon glyph. Inert at f=1.
            { sel: ".ep-panel-card .k-datepicker .k-input-button .k-svg-icon::before", props: [
              { name: "font-size", base: 24 }, { name: "width", base: 40 }, { name: "height", base: 40 }
            ] },
            { sel: ".ep-panel-card .k-timepicker .k-input-button .k-svg-icon, .ep-panel-card .k-timepicker .k-input-button .k-svg-icon svg", props: [
              { name: "height", base: 24 }, { name: "width", base: 24 }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: DIM_FONT.max, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: ".k-combobox.k-picker .k-input-value-text, .k-dropdownlist.k-picker .k-input-value-text, .k-picker-md.k-picker .k-input-value-text, .k-combobox.k-picker .k-input-inner, .k-dropdownlist.k-picker .k-input-inner, .k-picker-md.k-picker .k-input-inner, .k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner", props: [
              { name: "font-size", base: 14 }, { name: "line-height", base: 18 }
            ] }
          ]
        },
        {
          // Internal HORIZONTAL inset — the "white space to margins" inside a dropdown. The selected
          // value (`.k-input-inner`) sits 10px in from the border (live-measured stock); scale it so the
          // value hugs the edge. Scoped to combobox/dropdownlist/picker so it never touches plain text
          // fields. Live-validated 10→4 on Order Entry, value readable.
          key: "padding", label: "Inner padding", min: 0.2, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".k-combobox.k-picker .k-input-inner, .k-dropdownlist.k-picker .k-input-inner, .k-picker-md.k-picker .k-input-inner, .k-datepicker.k-picker .k-input-inner, .k-timepicker.k-picker .k-input-inner, .k-datepicker.k-input .k-input-inner, .k-timepicker.k-input .k-input-inner", props: [
              { name: "padding-left", base: 10 }, { name: "padding-right", base: 10 }
            ] }
          ]
        }
      ]
    },
    {
      // PAGE CHROME — the fixed top page header (breadcrumb/title/hero bar). This was the main remaining
      // white-space band on Order 5413 after all component families were at their compact end. Keep it
      // separate from panel-card headers so users can compress app chrome without changing form panels.
      key: "page", label: "Page chrome", dims: [
        {
          key: "header", label: "Header height", min: 0.6, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: "#ep-view-header", props: [
              { name: "min-height", base: 99 }
            ] },
            { sel: "#ep-view-header .ep-view-header", props: [
              { name: "height", base: 70 }, { name: "min-height", base: 70 },
              { name: "padding-top", base: 10 }, { name: "padding-bottom", base: 10 },
              { name: "margin-top", base: 8 }
            ] },
            { sel: "#ep-view-header .ep-hero-bar-column", props: [
              { name: "padding-left", base: 8 }, { name: "padding-right", base: 8 }
            ] }
          ]
        },
        {
          key: "title", label: "Title size", min: 0.75, max: 1.2, step: 0.05, def: 1,
          rules: [
            { sel: "#ep-view-title", props: [
              { name: "font-size", base: 34 }, { name: "line-height", base: 30 }, { name: "padding-bottom", base: 5 }
            ] },
            { sel: "#ep-view-header .ep-view-title", props: [
              { name: "height", base: 35 }, { name: "min-height", base: 35 }
            ] }
          ]
        }
      ]
    },
    {
      key: "tabs", label: "Tabs", dims: [
        {
          key: "padding", label: "Padding", min: 0.4, max: 2, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-tab-strip .k-tabstrip-items", props: [
              { name: "height", base: 70 }, { name: "min-height", base: 70 },
              { name: "padding-top", base: 16 }, { name: "padding-bottom", base: 16 }
            ] },
            { sel: ".ep-tab-strip .k-tabstrip-items .k-tabstrip-item", props: [
              { name: "margin-right", base: 20 }
            ] },
            { sel: "div.ep-component-top-element.ep-tab-strip kendo-tabstrip.k-tabstrip.k-tabstrip-md .k-tabstrip-items-wrapper.k-vstack .k-tabstrip-items.k-reset > li.k-tabstrip-item.k-item > span.k-link", props: [
              { name: "padding-top", base: 10 }, { name: "padding-bottom", base: 10 },
              { name: "padding-left", base: 15 }, { name: "padding-right", base: 15 }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: 1.5, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: ".k-tabstrip-items .k-link", props: [ { name: "font-size", base: 16 } ] }
          ]
        }
      ]
    },
    {
      key: "label", label: "Field labels", dims: [
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: DIM_FONT.max, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: "label.ep-shape-label, .k-label, .k-floating-label", props: [ { name: "font-size", base: 14 } ] }
          ]
        }
      ]
    },
    {
      // TAGS & OPTIONS — compact the pill-style option tags shown in panels such as Order Tracker's
      // "Options" section (Ready To Process / Ready To Fulfill / Hold). These are not ordinary stacked
      // checkboxes: each .ep-tag row is a 42px block containing a 32px flex pill with 5px vertical margins,
      // 5px internal padding, a 30px right reserve, and an 18px checkbox label. Card fieldGap can remove
      // the gap BETWEEN rows, but it cannot reduce this per-tag chrome. Keep the selectors scoped to
      // .ep-panel-card .ep-tag so global checkboxes and non-tag status fields retain their native affordance.
      key: "tag", label: "Tags & options", dims: [
        {
          key: "height", label: "Tag height", min: 0.65, max: 1.4, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-panel-card .ep-component-top-element.ep-tag, .ep-panel-card ep-tag.ep-component, .ep-panel-card ep-tag-item, .ep-panel-card .ep-component-item-element.ep-tag-item", props: [
              { name: "height", base: 42 }, { name: "min-height", base: 42 }
            ] },
            { sel: ".ep-panel-card .ep-component-top-element.ep-tag .ep-tag-item-container.ep-shape-container", props: [
              { name: "height", base: 32 }, { name: "min-height", base: 18 },
              { name: "margin-top", base: 5 }, { name: "margin-bottom", base: 5 },
              { name: "padding-top", base: 5 }, { name: "padding-bottom", base: 5 }
            ] },
            { sel: ".ep-panel-card .ep-tag ep-check-box.check-box-shape, .ep-panel-card .ep-tag .ep-component-top-element.ep-check-box, .ep-panel-card .ep-tag .ep-label-container, .ep-panel-card .ep-tag .ep-checkbox-label", props: [
              { name: "height", base: 18 }, { name: "min-height", base: 18 },
              { name: "line-height", base: 18 }, { name: "font-size", base: 14 }
            ] },
            { sel: ".ep-panel-card .ep-tag .ep-component-top-element.ep-check-box input", props: [
              { name: "height", base: 24 }, { name: "min-height", base: 24 }
            ] }
          ]
        },
        {
          key: "padding", label: "Tag padding", min: 0.2, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-panel-card .ep-component-top-element.ep-tag .ep-tag-item-container.ep-shape-container", props: [
              { name: "padding-left", base: 5 }, { name: "padding-right", base: 30 }
            ] },
            { sel: ".ep-panel-card .ep-tag .ep-checkbox-label", props: [
              { name: "margin-left", base: 25 }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: 1.4, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: ".ep-panel-card .ep-tag .ep-checkbox-label", props: [
              { name: "height", base: 18 }, { name: "min-height", base: 18 },
              { name: "font-size", base: 14 }, { name: "line-height", base: 18 }
            ] }
          ]
        }
      ]
    },
    {
      // CARDS & LAYOUT — the WHITE-SPACE lever. Unlike the per-control families above (which size a
      // single component's chrome), this family scales the panel-card LAYOUT spacing: the grey
      // ".ep-content" background that shows BETWEEN components. A factor < 1 tightens the layout so the
      // grey gaps shrink and the field controls (which are width:100% of their cell) WIDEN to fill the
      // reclaimed horizontal space — i.e. components consume the white space. Live-verified on CDP-9100
      // Order Entry (order 5413, "Order Header" card, 2026-06-06; see .tmp/whitespace-iter/): a dense
      // point-sample of the card measured 56.1% grey at stock; gutter/card-pad/field-spacing → ~0.3
      // dropped it to ~49% with NO distortion and exact revert. (The remaining grey below short columns
      // is structural — unequal column heights — and can only be "filled" by flexing generic Angular
      // wrapper divs or JS reflow, which would distort the form, so it is deliberately left alone.)
      //
      // IMPORTANT — this is the CORRECT lever for white space, NOT the field-height families: shrinking a
      // control's height (textbox/dropdown) makes its column SHORTER, which ADDS bottom-of-column grey
      // (live-proven: layout-compaction 49% rose to 54% once field heights were also cut). So the
      // white-space family scales layout spacing only and never touches control heights.
      key: "card", label: "Cards & layout", dims: [
        {
          // Column gutter — the horizontal grey between the panel-card columns. The Bootstrap-style
          // layout pins `.col.col-container { padding: 0 15px }` and offsets `.row.row-container {
          // margin: 0 -15px }`; scale BOTH by the same factor (base 15 / -15) so columns pack closer and
          // the fields inside them (width:100%) grow to fill — the row's negative margin must track the
          // column padding or the row overflows its container. Scoped to .ep-panel-card so only form
          // cards move; grid-only cards have no col-container and are untouched. Live: 15→4.5 packs
          // cleanly, exact revert (.tmp/whitespace-iter/c1-gutters.css).
          key: "gutter", label: "Column gutter", min: 0.1, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-panel-card .col.col-container", props: [
              { name: "padding-left", base: 15 }, { name: "padding-right", base: 15 }
            ] },
            { sel: ".ep-panel-card .row.row-container", props: [
              { name: "margin-left", base: -15 }, { name: "margin-right", base: -15 }
            ] }
          ]
        },
        {
          // Card padding — the grey margin between the card border and its content. Stock
          // `.ep-content { padding: 10px 20px 5px }` (top 10 / inline 20 / bottom 5). Scale each side by
          // the factor so the form extends closer to the card edge. Live: 0.25 → 2.5/5/1.25, clean.
          key: "cardPad", label: "Card padding", min: 0, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-panel-card .ep-content", props: [
              { name: "padding-top", base: 10 }, { name: "padding-right", base: 20 },
              { name: "padding-bottom", base: 5 }, { name: "padding-left", base: 20 }
            ] },
            // The grey BETWEEN stacked cards (e.g. Order Header / Lines): each `.ep-panel-card` has a
            // stock margin-bottom of 10px. Scale it with the card padding so reducing one reduces the
            // other in step — "the margins of the panel" the user named. Base 10 (live-measured).
            { sel: ".ep-panel-card", props: [ { name: "margin-bottom", base: 10 } ] }
          ]
        },
        {
          // Panel-card HEADER height — the grey band around the card title ("Order Header"). Stock
          // `.ep-panelcard-header` is ~50px tall while the title is only 24px, leaving ~26px of vertical
          // grey; scale its height + min-height (base 50) so the header hugs the title. min 0.5 keeps it
          // >= the 24px title (never clips). Live-validated 50→28 on Order Entry, title + buttons intact.
          key: "header", label: "Header height", min: 0.8, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-panel-card .k-panelbar-item > .k-link", props: [
              { name: "height", base: 50 }, { name: "min-height", base: 50 },
              { name: "padding-left", base: 50 }, { name: "padding-right", base: 15 }
            ] },
            { sel: ".ep-panel-card .ep-panelcard-header", props: [
              { name: "height", base: 50 }, { name: "min-height", base: 50 }
            ] }
          ]
        },
        {
          // Field spacing — the vertical grey BETWEEN stacked components. Each field control's
          // ".ep-component-top-element" carries a fixed margin-bottom (live-measured: 10px on
          // text/numeric/date/time/combo/textarea controls, 5px on checkboxes); scaling it by the factor
          // pulls fields together so the inter-component grey collapses. Two rules because the two stock
          // bases differ. Scoped to .ep-panel-card. Live-validated 10→3 / 5→1.5, exact revert.
          key: "fieldGap", label: "Field spacing", min: 0, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-panel-card .ep-component-top-element.ep-text-box, .ep-panel-card .ep-component-top-element.ep-numeric-box, .ep-panel-card .ep-component-top-element.ep-date-picker, .ep-panel-card .ep-component-top-element.ep-time-picker, .ep-panel-card .ep-component-top-element.ep-combo-box, .ep-panel-card .ep-component-top-element.ep-text-area", props: [
              { name: "margin-bottom", base: 10 }
            ] },
            { sel: ".ep-panel-card .ep-component-top-element.ep-check-box", props: [
              { name: "margin-bottom", base: 5 }
            ] },
            // PANEL-BAR HEADER EXCEPTION — in a panel-card expanded-header band the top-element's
            // margins are NOT a stacked-field gap: they're SYMMETRIC 5px/5px centring geometry (the
            // band flex-centres the control's outer box). The global rule above zeroed the textbox's
            // margin-bottom at fieldGap 0, shrinking its outer box 38→33 and seating it 2.5px LOWER
            // than the sibling "All" dropdown (whose .ep-dropdown class the global rule doesn't list) —
            // live-repro QAGO1090 2026-06-10. Pin the header-band stock 5 (constant, factor-independent:
            // there is no field-below to gap against in a single-row band). Outranks the globals (0,4,0
            // vs 0,2,0).
            { sel: ".ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-text-box, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-numeric-box, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-date-picker, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-time-picker, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-combo-box, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-text-area, .ep-panel-card .ep-panel-bar-title .ep-component-top-element.ep-check-box", props: [
              { name: "margin-bottom", base: 0, offset: 5 }
            ] }
          ]
        }
      ]
    },
    {
      // NAVIGATION TREE — both left-hand trees: the in-app "Related Pages" tree (Sales Order > Order
      // Header / Lines / ...) AND the main MENU launcher (Home: Main Menu > Sales Management / ...).
      //
      // BEHAVIOR ANALYSIS (CDP-9100 Home + Order Entry, 2026-06-06): these are TWO different DOM shapes,
      // so one selector can't cover both —
      //   * In-app Related Pages tree = `.ep-menu-panel-link` rows (~42px, 6px top/bottom padding).
      //   * Main MENU launcher = a Kendo TreeView (`.ep-tree-view .k-treeview`): each row is a
      //     `.k-treeview-top` (5px top/bottom padding) inside a `li.k-treeview-item`, and the inter-item
      //     gap is `.k-treeview .k-treeview-group .k-treeview-item { margin: 2px !important }` (specificity
      //     0,3,0 — so our override must be >= that: .ep-tree-view prefix makes it 0,4,0 and wins). The
      //     leaf text in BOTH is `.ep-menu-panel-link-text`, so the `font` dim already reached the menu;
      //     `itemPad` did NOT (it only had `.ep-menu-panel-link`, absent from the treeview rows) — that was
      //     the "menu vs sliders" gap. itemPad now scales the treeview row padding (base 5) + the group-
      //     item margin (base 2) + the leaf padding (base 2) too, so ONE slider compacts BOTH trees.
      //     Live-validated: menu row rhythm 34px -> ~25px, even, text readable, exact revert. Scoped to
      //     `.ep-tree-view` so non-Epicor Kendo treeviews (dialogs) are untouched. (The ~22px toggle-arrow
      //     and the 18px text line-height are the residual floor; they are NOT factor-scaled because base*
      //     factor would shrink the arrow to nothing / clip the text at low factors — padding/margin go to
      //     0 safely, content floors do not.)
      key: "tree", label: "Navigation tree", dims: [
        {
          key: "itemPad", label: "Item spacing", min: 0.1, max: 1.5, step: 0.05, def: 1,
          rules: [
            { sel: ".ep-menu-panel-link", props: [
              { name: "padding-top", base: 6 }, { name: "padding-bottom", base: 6 }
            ] },
            { sel: ".ep-app-nav-main-map-item", props: [
              { name: "padding-top", base: 2 }, { name: "padding-bottom", base: 2 }
            ] },
            { sel: ".ep-app-nav-main-map-item .ep-app-nav-icon", props: [
              { name: "margin-right", base: 8 }
            ] },
            { sel: ".ep-tree-view .k-treeview .k-treeview-top", props: [
              { name: "padding-top", base: 5 }, { name: "padding-bottom", base: 5 }
            ] },
            { sel: ".ep-tree-view .k-treeview .k-treeview-group .k-treeview-item", props: [
              { name: "margin-top", base: 2 }, { name: "margin-bottom", base: 2 }
            ] },
            { sel: ".ep-tree-view .k-treeview .k-treeview-leaf", props: [
              { name: "padding-top", base: 2 }, { name: "padding-bottom", base: 2 }
            ] }
          ]
        },
        {
          key: "font", label: "Text size", min: DIM_FONT.min, max: DIM_FONT.max, step: DIM_FONT.step, def: DIM_FONT.def,
          rules: [
            { sel: ".ep-menu-panel-link-text, .ep-app-nav-main-map-item .ep-app-nav-text", props: [
              { name: "font-size", base: 14 }
            ] },
            { sel: ".ep-app-nav-main-map-item .ep-app-nav-icon", props: [
              { name: "font-size", base: 16 }, { name: "line-height", base: 16 },
              { name: "height", base: 16 }, { name: "min-height", base: 16 }
            ] }
          ]
        }
      ]
    }
  ];

  // Index for O(1) lookup: FAM_BY_KEY[fam] = family; DIM_BY_KEY[fam][dim] = dimension.
  var FAM_BY_KEY = {};
  var DIM_BY_KEY = {};
  (function indexFamilies() {
    for (var i = 0; i < FAMILIES.length; i += 1) {
      var f = FAMILIES[i];
      FAM_BY_KEY[f.key] = f;
      DIM_BY_KEY[f.key] = {};
      for (var j = 0; j < f.dims.length; j += 1) { DIM_BY_KEY[f.key][f.dims[j].key] = f.dims[j]; }
    }
  })();

  // ===================================================================================================
  // Pure engine (no DOM / no chrome.*; deterministic). Exported for unit tests.
  // ===================================================================================================

  function clampFactor(famKey, dimKey, factor) {
    var fam = FAM_BY_KEY[famKey];
    if (!fam) { return null; }
    var d = DIM_BY_KEY[famKey][dimKey];
    if (!d) { return null; }
    var n = Number(factor);
    if (isNaN(n)) { return null; }
    if (n < d.min) { n = d.min; }
    if (n > d.max) { n = d.max; }
    return n;
  }

  function isDefaultFactor(famKey, dimKey, factor) {
    var d = DIM_BY_KEY[famKey] ? DIM_BY_KEY[famKey][dimKey] : null;
    if (!d) { return false; }
    var n = Number(factor);
    if (isNaN(n)) { return false; }
    return Math.abs(n - d.def) <= EPS;
  }

  // Round to 2 decimals, no float dust ("38.4", "6", "21.25").
  function round2(x) {
    var r = Math.round(Number(x) * 100) / 100;
    if (!isFinite(r)) { return "0"; }
    return String(r);
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function isAdaptivePickerTag(tagName) {
    return /^(KENDO-DROPDOWNLIST|KENDO-COMBOBOX|KENDO-MULTICOLUMNCOMBOBOX|KENDO-MULTISELECT|KENDO-AUTOCOMPLETE)$/.test(String(tagName || "").toUpperCase());
  }

  function normalizeState(v) {
    v = (v && typeof v === "object") ? v : {};
    var raw = (v.componentDensity && typeof v.componentDensity === "object") ? v.componentDensity : {};
    return {
      componentDensity: raw,
      textAreaAutoSizeEnabled: v.textAreaAutoSizeEnabled === true,
      fullWidthEnabled: v.fullWidthEnabled === true,
      customHostPatterns: normalizeHostPatterns(v.customHostPatterns)
    };
  }

  // Adjustments that actually contribute (known family+dim + a clamped factor differing from default),
  // returned in FAMILIES/dims order so the marker + emitted CSS are deterministic.
  function activeAdjustments(state) {
    var out = [];
    var vals = (state && state.componentDensity && typeof state.componentDensity === "object") ? state.componentDensity : {};
    for (var i = 0; i < FAMILIES.length; i += 1) {
      var fam = FAMILIES[i];
      var famVals = (vals[fam.key] && typeof vals[fam.key] === "object") ? vals[fam.key] : null;
      if (!famVals) { continue; }
      for (var j = 0; j < fam.dims.length; j += 1) {
        var d = fam.dims[j];
        if (!Object.prototype.hasOwnProperty.call(famVals, d.key)) { continue; }
        var f = clampFactor(fam.key, d.key, famVals[d.key]);
        if (f === null) { continue; }
        if (Math.abs(f - d.def) <= EPS) { continue; }
        out.push({ family: fam.key, dim: d.key, factor: f });
      }
    }
    return out;
  }

  function gridRowHeightFactor(state) {
    try {
      var vals = (state && state.componentDensity && typeof state.componentDensity === "object") ? state.componentDensity : {};
      var grid = (vals.grid && typeof vals.grid === "object") ? vals.grid : null;
      if (!grid || !Object.prototype.hasOwnProperty.call(grid, "rowHeight")) { return 1; }
      var f = clampFactor("grid", "rowHeight", grid.rowHeight);
      if (f === null || Math.abs(f - 1) <= EPS) { return 1; }
      return f;
    } catch (e) { return 1; }
  }

  // emitProp(prop, f) -> one "name: value !important;" declaration for a rule prop at factor f.
  // The default path is the original `base * f` px scaling. Three OPTIONAL fields extend it for props
  // whose value isn't a simple proportional length (added 2026-06 for the compact floating-label fixes):
  //   offset   — additive constant, so the value is the AFFINE `base*f + offset` instead of `base*f`.
  //              Lets a value land on a chosen pair of endpoints AND stay continuous with stock at f=1
  //              (e.g. the search-field value padding-top: 17 at f=1, ~15 at f=0.7 — a pure scale would
  //              jump at the first slider notch). Pure scaling is just offset:0.
  //   clampMin/clampMax — clamp the (possibly affine) number into a range. Used so the floated-label LIFT
  //              only engages while COMPACTING (f<1) and never pushes the label DOWN on expansion (f>1).
  //   unit     — value suffix, default "px".
  //   wrap     — a template with "@" replaced by the numeric+unit value, e.g. "translateY(@)". Lets a
  //              prop emit a function value (transform) rather than a bare length.
  // Defaults (offset 0, no clamp, unit "px", no wrap) reproduce the original byte output exactly.
  function emitProp(prop, f) {
    var n = prop.base * f + (prop.offset || 0);
    if (typeof prop.clampMax === "number" && n > prop.clampMax) { n = prop.clampMax; }
    if (typeof prop.clampMin === "number" && n < prop.clampMin) { n = prop.clampMin; }
    var unit = (prop.unit !== undefined) ? prop.unit : "px";
    var valueStr = round2(n) + unit;
    if (prop.wrap) { valueStr = prop.wrap.replace("@", valueStr); }
    return prop.name + ": " + valueStr + " !important;";
  }

  // buildCss(state) -> the full CSS text for the <style>. Empty string => inert (caller removes style).
  // PURE: this is the byte output the tests + harness assert.
  function buildCss(rawState) {
    var state = normalizeState(rawState);
    var adj = activeAdjustments(state);
    var lines = [];
    for (var a = 0; a < adj.length; a += 1) {
      var fam = FAM_BY_KEY[adj[a].family];
      var d = DIM_BY_KEY[adj[a].family][adj[a].dim];
      var f = adj[a].factor;
      for (var r = 0; r < d.rules.length; r += 1) {
        var rule = d.rules[r];
        var decls = [];
        for (var p = 0; p < rule.props.length; p += 1) {
          decls.push(emitProp(rule.props[p], f));
        }
        lines.push(rule.sel + " { " + decls.join(" ") + " }");
      }
    }
    if (state.textAreaAutoSizeEnabled === true) {
      lines.push(TEXTAREA_SELECTOR + " { resize: none !important; overflow-y: hidden !important; }");
    }
    if (state.fullWidthEnabled === true) {
      lines.push(FULL_WIDTH_CSS);
    }
    return lines.join("\n");
  }

  // Count of CSS rules emitted (one per family-dim rule entry) — for the marker readout.
  function ruleCount(state) {
    var css = buildCss(state);
    if (!css) { return 0; }
    return css.split("\n").length;
  }

  // ===================================================================================================
  // Runtime (DOM + chrome.storage). ISOLATED world only. Fully inert when componentDensity is empty.
  // ===================================================================================================

  function chromeOf(W) {
    if (typeof chrome !== "undefined" && chrome) { return chrome; }
    if (W && W.chrome) { return W.chrome; }
    return null;
  }

  function normalizeHostPatterns(value) {
    var out = [];
    var seen = {};
    if (!Array.isArray(value)) { return out; }
    for (var i = 0; i < value.length; i += 1) {
      var pattern = typeof value[i] === "string" ? value[i].toLowerCase() : "";
      if (!pattern || seen[pattern]) { continue; }
      if (!/^(\*|https?):\/\/(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+\/\*$/.test(pattern)) { continue; }
      seen[pattern] = true;
      out.push(pattern);
    }
    return out;
  }

  function patternHost(pattern) {
    var match = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(pattern || "");
    return match ? match[2] : "";
  }

  function patternMatchesHost(hostname, pattern) {
    var host = (hostname || "").toLowerCase();
    var allowed = patternHost(pattern).toLowerCase();
    if (!host || !allowed) { return false; }
    if (allowed.indexOf("*.") === 0) {
      var suffix = allowed.slice(2);
      return host === suffix || host.lastIndexOf("." + suffix) === host.length - suffix.length - 1;
    }
    return host === allowed;
  }

  function defaultHostAllowed(W) {
    try {
      var h = (W && W.location && W.location.hostname) ? String(W.location.hostname).toLowerCase() : "";
      if (h === "epicorsaas.com") { return true; }
      return h.length >= HOST_SUFFIX.length && h.slice(h.length - HOST_SUFFIX.length) === HOST_SUFFIX;
    } catch (e) { return false; }
  }

  function hostAllowed(W, state) {
    if (defaultHostAllowed(W)) { return true; }
    try {
      var h = (W && W.location && W.location.hostname) ? String(W.location.hostname).toLowerCase() : "";
      var patterns = normalizeHostPatterns(state && state.customHostPatterns);
      for (var i = 0; i < patterns.length; i += 1) {
        if (patternMatchesHost(h, patterns[i])) { return true; }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // Cheap relevance filter for the MutationObserver: re-assert only when OUR <style> was removed or the
  // <head> churns (so we can re-append last) — not on page-wide SPA churn. Bounded loops.
  function isRelevant(muts) {
    try {
      for (var i = 0; i < muts.length; i += 1) {
        var m = muts[i];
        var t = m.target;
        if (t && t.nodeType === 1 && t.nodeName === "HEAD") { return true; }
        var added = m.addedNodes;
        if (added && added.length) {
          for (var j = 0; j < added.length && j < 16; j += 1) {
            var an = added[j] ? added[j].nodeName : "";
            if (an === "HEAD" || an === "BODY" || an === "STYLE" || an === "LINK") { return true; }
          }
        }
        var removed = m.removedNodes;
        if (removed && removed.length) {
          for (var r = 0; r < removed.length && r < 16; r += 1) {
            var rn = removed[r];
            if (rn && (rn.id === STYLE_ID || rn.nodeName === "HEAD")) { return true; }
          }
        }
      }
    } catch (e) { return true; }
    return false;
  }

  function installRuntime(W) {
    try {
      if (!W || typeof W !== "object" || !W.document) { return null; }
      if (!defaultHostAllowed(W) && !chromeOf(W)) { return null; }
      if (W[MARKER_KEY + "_RUNTIME"] && W[MARKER_KEY + "_RUNTIME"].__installed === true) {
        return W[MARKER_KEY + "_RUNTIME"];
      }

      var D = W.document;
      var state = normalizeState(null);
      var currentCss = "";
      var reasserts = 0;
      var spacerWrites = 0;
      var spacerScans = 0;
      var spacerFound = 0;
      var spacerFactor = 1;
      var observers = [];
      var timers = [];
      var refreshTimer = null;
      var reassertTimer = null;
      var spacerTimer = null;
      var storageListener = null;
      var pendingReady = null;
      var adaptiveApplyAssists = 0;
      var adaptiveApplySkips = 0;
      var adaptiveApplyPending = 0;
      var adaptiveApplyListener = null;
      var adaptiveApplyAutoClicking = false;
      var textAreaAutoSizeScans = 0;
      var textAreaAutoSizeCount = 0;
      var textAreaAutoSizeWrites = 0;
      var textAreaTimer = null;
      var textAreaInputListener = null;

      function publishMarker() {
        try {
          var adj = activeAdjustments(state);
          var marker = {
            version: VERSION,
            active: adj.length > 0 || state.textAreaAutoSizeEnabled === true || state.fullWidthEnabled === true,
            adjustments: adj,
            ruleCount: currentCss ? currentCss.split("\n").length : 0,
            reasserts: reasserts,
            spacerWrites: spacerWrites,
            spacerScans: spacerScans,
            spacerFound: spacerFound,
            spacerFactor: spacerFactor,
            adaptiveApplyAssists: adaptiveApplyAssists,
            adaptiveApplySkips: adaptiveApplySkips,
            adaptiveApplyPending: adaptiveApplyPending,
            textAreaAutoSize: state.textAreaAutoSizeEnabled === true,
            textAreaAutoSizeCount: textAreaAutoSizeCount,
            textAreaAutoSizeScans: textAreaAutoSizeScans,
            textAreaAutoSizeWrites: textAreaAutoSizeWrites,
            fullWidth: state.fullWidthEnabled === true
          };
          W[MARKER_KEY] = marker;
          if (D.documentElement && D.documentElement.dataset) {
            D.documentElement.dataset[DATASET_KEY] = JSON.stringify(marker);
          }
        } catch (e) { /* ignore */ }
      }

      function clearMarker() {
        try {
          delete W[MARKER_KEY];
          if (D.documentElement && D.documentElement.dataset) {
            delete D.documentElement.dataset[DATASET_KEY];
          }
        } catch (e) { /* ignore */ }
      }

      // Idempotent applier: one #kinetic-padding-control <style>, last in <head>; empty css => removed.
      function ensureStyle(css) {
        try {
          var el = D.getElementById(STYLE_ID);
          if (!css) {
            if (el && el.parentNode) { el.parentNode.removeChild(el); }
            return;
          }
          var head = D.head || (D.getElementsByTagName ? D.getElementsByTagName("head")[0] : null) || D.documentElement;
          if (!head) { return; }
          if (!el) {
            el = D.createElement("style");
            el.id = STYLE_ID;
            el.setAttribute("data-kinetic-grid-fix", "padding-control");
          }
          if (el.textContent !== css) { el.textContent = css; }
          // Keep it LAST in <head> so its !important rules win source-order ties against later CSS.
          if (el.parentNode !== head || head.lastChild !== el) { head.appendChild(el); reasserts += 1; }
        } catch (e) { /* ignore */ }
      }

      function parsePx(value) {
        var m = String(value == null ? "" : value).match(/-?\d*\.?\d+/);
        return m ? Number(m[0]) : null;
      }

      function spacerHeightOf(el) {
        try {
          var n = parsePx(el && el.style ? el.style.height : null);
          if (n !== null && isFinite(n) && n > 0) { return n; }
          n = el && el.offsetHeight ? Number(el.offsetHeight) : null;
          if (n !== null && isFinite(n) && n > 0) { return n; }
        } catch (e) { /* ignore */ }
        return null;
      }

      function clearGridScrollSpacers() {
        try {
          var nodes = D.querySelectorAll ? D.querySelectorAll(".k-grid .k-height-container[data-kinetic-padding-spacer-original]") : [];
          for (var i = 0; i < nodes.length; i += 1) {
            var el = nodes[i];
            var original = parsePx(el.getAttribute("data-kinetic-padding-spacer-original"));
            if (original !== null && isFinite(original) && original > 0) {
              el.style.height = round2(original) + "px";
              spacerWrites += 1;
            }
            try {
              el.removeAttribute("data-kinetic-padding-spacer-original");
              el.removeAttribute("data-kinetic-padding-spacer-adjusted");
            } catch (eA) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      }

      function syncGridScrollSpacers() {
        try {
          var factor = gridRowHeightFactor(state);
          spacerScans += 1;
          spacerFactor = factor;
          if (Math.abs(factor - 1) <= EPS || !hostAllowed(W, state)) {
            clearGridScrollSpacers();
            publishMarker();
            return;
          }
          var nodes = D.querySelectorAll ? D.querySelectorAll(".k-grid .k-height-container") : [];
          spacerFound = nodes.length || 0;
          for (var i = 0; i < nodes.length; i += 1) {
            var el = nodes[i];
            var current = spacerHeightOf(el);
            if (current === null) { continue; }
            var original = parsePx(el.getAttribute("data-kinetic-padding-spacer-original"));
            var adjusted = parsePx(el.getAttribute("data-kinetic-padding-spacer-adjusted"));
            if (original === null || !isFinite(original) || original <= 0) {
              original = current;
            } else if (adjusted !== null && Math.abs(current - adjusted) > 1) {
              original = current;
            }
            var next = original * factor;
            if (!isFinite(next) || next <= 0) { continue; }
            if (Math.abs(current - next) > 0.5) {
              el.style.height = round2(next) + "px";
              spacerWrites += 1;
            }
            try {
              var originalStr = round2(original);
              var nextStr = round2(next);
              if (el.getAttribute("data-kinetic-padding-spacer-original") !== originalStr) {
                el.setAttribute("data-kinetic-padding-spacer-original", originalStr);
              }
              if (el.getAttribute("data-kinetic-padding-spacer-adjusted") !== nextStr) {
                el.setAttribute("data-kinetic-padding-spacer-adjusted", nextStr);
              }
            } catch (eA) { /* ignore */ }
          }
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      function scheduleSpacerSync() {
        if (spacerTimer) { W.clearTimeout(spacerTimer); }
        spacerTimer = W.setTimeout(function () { spacerTimer = null; syncGridScrollSpacers(); }, 80);
      }

      function textAreaNodes() {
        try {
          return D.querySelectorAll ? D.querySelectorAll(TEXTAREA_SELECTOR) : [];
        } catch (e) { return []; }
      }

      function isVisibleTextArea(ta) {
        try {
          if (!ta || !ta.matches || !ta.matches(TEXTAREA_SELECTOR)) { return false; }
          var rect = ta.getBoundingClientRect ? ta.getBoundingClientRect() : null;
          if (rect && rect.width <= 0 && rect.height <= 0 && !ta.scrollHeight) { return false; }
          return true;
        } catch (e) { return false; }
      }

      function rememberTextAreaHeight(ta) {
        try {
          if (!ta || !ta.getAttribute || !ta.setAttribute) { return; }
          if (ta.getAttribute(TEXTAREA_ORIGINAL_HEIGHT_ATTR) === null) {
            ta.setAttribute(TEXTAREA_ORIGINAL_HEIGHT_ATTR, (ta.style && ta.style.height) ? ta.style.height : "");
          }
        } catch (e) { /* ignore */ }
      }

      function autoSizeTextArea(ta) {
        try {
          if (!isVisibleTextArea(ta) || !ta.style) { return false; }
          rememberTextAreaHeight(ta);
          ta.setAttribute(TEXTAREA_AUTOSIZED_ATTR, "true");
          var previousHeight = ta.style.height || "";
          ta.style.height = "1px";
          var next = Number(ta.scrollHeight || 0);
          if (!isFinite(next) || next <= 0) {
            var original = ta.getAttribute(TEXTAREA_ORIGINAL_HEIGHT_ATTR);
            ta.style.height = original || "";
            return false;
          }
          var height = round2(next) + "px";
          ta.style.height = height;
          if (previousHeight !== height) { textAreaAutoSizeWrites += 1; }
          return true;
        } catch (e) { return false; }
      }

      function restoreTextAreas() {
        try {
          var nodes = D.querySelectorAll ? D.querySelectorAll("textarea[" + TEXTAREA_ORIGINAL_HEIGHT_ATTR + "]") : [];
          for (var i = 0; i < nodes.length; i += 1) {
            var ta = nodes[i];
            try {
              var original = ta.getAttribute(TEXTAREA_ORIGINAL_HEIGHT_ATTR);
              if (ta.style) { ta.style.height = original || ""; }
              ta.removeAttribute(TEXTAREA_ORIGINAL_HEIGHT_ATTR);
              ta.removeAttribute(TEXTAREA_AUTOSIZED_ATTR);
            } catch (eA) { /* ignore */ }
          }
          textAreaAutoSizeCount = 0;
        } catch (e) { /* ignore */ }
      }

      function syncTextAreas() {
        try {
          textAreaAutoSizeScans += 1;
          if (state.textAreaAutoSizeEnabled !== true || !hostAllowed(W, state)) {
            restoreTextAreas();
            return;
          }
          var nodes = textAreaNodes();
          var count = 0;
          for (var i = 0; i < nodes.length; i += 1) {
            if (autoSizeTextArea(nodes[i])) { count += 1; }
          }
          textAreaAutoSizeCount = count;
        } catch (e) { /* ignore */ }
      }

      function scheduleTextAreaSync() {
        if (textAreaTimer) { W.clearTimeout(textAreaTimer); }
        textAreaTimer = W.setTimeout(function () {
          textAreaTimer = null;
          syncTextAreas();
          publishMarker();
        }, 80);
      }

      function apply() {
        try {
          if (!hostAllowed(W, state)) {
            currentCss = "";
            ensureStyle("");
            restoreTextAreas();
            clearMarker();
            return;
          }
          currentCss = buildCss(state);
          ensureStyle(currentCss);
          syncGridScrollSpacers();
          syncTextAreas();
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      // DOM-only re-assert using the cached css (SPA re-mount / head churn) — no storage read.
      function reassert() {
        try {
          ensureStyle(currentCss);
          syncGridScrollSpacers();
          syncTextAreas();
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      function readAndApply() {
        try {
          var c = chromeOf(W);
          if (!c || !c.storage || !c.storage.local || !c.storage.local.get) { apply(); return; }
          c.storage.local.get(STORAGE_KEYS, function (v) {
            try { state = normalizeState(v); } catch (eN) { state = normalizeState(null); }
            apply();
          });
        } catch (e) { apply(); }
      }

      // Debounced live refresh (re-read storage + rebuild) — keeps a dragged slider from thrashing.
      function scheduleRefresh() {
        if (refreshTimer) { W.clearTimeout(refreshTimer); }
        refreshTimer = W.setTimeout(function () { refreshTimer = null; readAndApply(); }, 90);
      }

      function scheduleReassert() {
        if (reassertTimer) { W.clearTimeout(reassertTimer); }
        reassertTimer = W.setTimeout(function () { reassertTimer = null; reassert(); }, 80);
      }

      function adaptivePickerText(host) {
        try {
          var value = host && host.querySelector ? host.querySelector(".k-input-value-text") : null;
          if (value) { return normalizeText(value.textContent); }
          var input = host && host.querySelector ? host.querySelector("input.k-input-inner, input.k-input, input") : null;
          if (input && input.value !== undefined) { return normalizeText(input.value); }
          var inner = host && host.querySelector ? host.querySelector(".k-input-inner") : null;
          return normalizeText(inner ? inner.textContent : (host ? host.textContent : ""));
        } catch (e) { return ""; }
      }

      function adaptivePickerHost(host) {
        try {
          if (!host || !host.matches) { return null; }
          if (host.matches(".ep-adaptive-mode.k-picker, kendo-dropdownlist.ep-adaptive-mode, kendo-combobox.ep-adaptive-mode, kendo-multicolumncombobox.ep-adaptive-mode, kendo-multiselect.ep-adaptive-mode, kendo-autocomplete.ep-adaptive-mode") && isAdaptivePickerTag(host.tagName)) { return host; }
        } catch (e) { /* ignore */ }
        return null;
      }

      function findAdaptivePickerFromActionSheetTarget(target) {
        try {
          if (!target || !target.closest) { return null; }
          var option = target.closest("li[role='option'], .k-list-item");
          if (!option) { return null; }
          var sheet = option.closest("kendo-actionsheet, .k-actionsheet");
          if (!sheet) { return null; }
          var host = sheet.closest(".ep-adaptive-mode.k-picker, kendo-dropdownlist.ep-adaptive-mode, kendo-combobox.ep-adaptive-mode, kendo-multicolumncombobox.ep-adaptive-mode, kendo-multiselect.ep-adaptive-mode, kendo-autocomplete.ep-adaptive-mode");
          host = adaptivePickerHost(host);
          if (!host) { return null; }
          return { host: host, option: option, text: normalizeText(option.textContent) };
        } catch (e) { return null; }
      }

      function dispatchMouseSequence(el) {
        try {
          if (!el || !el.dispatchEvent) { return false; }
          adaptiveApplyAutoClicking = true;
          var opts = { bubbles: true, cancelable: true, composed: true, view: W };
          var names = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
          for (var i = 0; i < names.length; i += 1) {
            var name = names[i];
            var ev = null;
            try {
              ev = (name.indexOf("pointer") === 0 && W.PointerEvent) ? new W.PointerEvent(name, opts) : new W.MouseEvent(name, opts);
            } catch (eP) {
              try { ev = new W.MouseEvent(name, opts); } catch (eM) { ev = D.createEvent ? D.createEvent("MouseEvents") : null; }
              if (ev && ev.initMouseEvent) {
                try { ev.initMouseEvent(name, true, true, W, 1, 0, 0, 0, 0, false, false, false, false, 0, null); } catch (eI) { /* ignore */ }
              }
            }
            if (ev) { el.dispatchEvent(ev); }
          }
          return true;
        } catch (e) { return false; }
        finally {
          try { W.setTimeout(function () { adaptiveApplyAutoClicking = false; }, 0); } catch (eT) { adaptiveApplyAutoClicking = false; }
        }
      }

      function findAdaptiveOptionByText(host, expectedText) {
        try {
          var selector = "li[role='option'], .k-list-item";
          var nodes = [];
          if (host && host.querySelectorAll) { nodes = host.querySelectorAll(selector); }
          for (var i = 0; i < nodes.length; i += 1) {
            if (normalizeText(nodes[i].textContent) === expectedText) { return nodes[i]; }
          }
          var global = D.querySelectorAll ? D.querySelectorAll(".k-actionsheet li[role='option'], .k-actionsheet .k-list-item, kendo-actionsheet li[role='option'], kendo-actionsheet .k-list-item") : [];
          for (var g = 0; g < global.length; g += 1) {
            if (normalizeText(global[g].textContent) === expectedText) { return global[g]; }
          }
        } catch (e) { /* ignore */ }
        return null;
      }

      function scheduleAdaptiveApplyAssist(host, expectedText, beforeText) {
        try {
          if (!host || !expectedText) { return; }
          adaptiveApplyPending += 1;
          publishMarker();
          W.setTimeout(function () {
            try {
              adaptiveApplyPending = Math.max(0, adaptiveApplyPending - 1);
              if (!hostAllowed(W, state)) { adaptiveApplySkips += 1; publishMarker(); return; }
              if (!host.ownerDocument || !D.documentElement || !D.documentElement.contains(host)) { adaptiveApplySkips += 1; publishMarker(); return; }
              if (adaptivePickerText(host) !== expectedText) { adaptiveApplySkips += 1; publishMarker(); return; }
              if (beforeText && beforeText === expectedText) { adaptiveApplySkips += 1; publishMarker(); return; }
              var opener = (host.querySelector && (host.querySelector(".k-input-inner") || host.querySelector(".k-input-value-text"))) || host;
              var option = findAdaptiveOptionByText(host, expectedText);
              if (!option && !dispatchMouseSequence(opener)) { adaptiveApplySkips += 1; publishMarker(); return; }
              W.setTimeout(function () {
                try {
                  var item = option || findAdaptiveOptionByText(host, expectedText);
                  if (!item) { adaptiveApplySkips += 1; publishMarker(); return; }
                  if (adaptivePickerText(host) !== expectedText) { adaptiveApplySkips += 1; publishMarker(); return; }
                  if (dispatchMouseSequence(item)) { adaptiveApplyAssists += 1; } else { adaptiveApplySkips += 1; }
                  publishMarker();
                } catch (eI) { adaptiveApplySkips += 1; publishMarker(); }
              }, 320);
            } catch (eO) {
              adaptiveApplyPending = Math.max(0, adaptiveApplyPending - 1);
              adaptiveApplySkips += 1;
              publishMarker();
            }
          }, 450);
        } catch (e) { /* ignore */ }
      }

      function installAdaptiveApplyAssist() {
        try {
          if (!D.addEventListener || adaptiveApplyListener) { return; }
          adaptiveApplyListener = function (ev) {
            try {
              if (adaptiveApplyAutoClicking || !hostAllowed(W, state)) { return; }
              var found = findAdaptivePickerFromActionSheetTarget(ev && ev.target);
              if (!found || !found.text) { return; }
              scheduleAdaptiveApplyAssist(found.host, found.text, adaptivePickerText(found.host));
            } catch (eL) { /* ignore */ }
          };
          D.addEventListener("click", adaptiveApplyListener, true);
        } catch (e) { /* ignore */ }
      }

      function installTextAreaInputSync() {
        try {
          if (!D.addEventListener || textAreaInputListener) { return; }
          textAreaInputListener = function (ev) {
            try {
              if (state.textAreaAutoSizeEnabled !== true || !hostAllowed(W, state)) { return; }
              var target = ev && ev.target;
              if (target && target.matches && target.matches(TEXTAREA_SELECTOR)) { scheduleTextAreaSync(); }
            } catch (eL) { /* ignore */ }
          };
          D.addEventListener("input", textAreaInputListener, true);
        } catch (e) { /* ignore */ }
      }

      // 1) Initial state at document_start.
      readAndApply();

      // Adaptive Kendo action-sheet lists can update their displayed value on the first option click
      // without firing Epicor's bound selection action. When the displayed value changes, reopen the same
      // adaptive host once and click the now-selected option; Kendo's own selected-option path fires the
      // missing Epicor action. Scoped to ep-adaptive-mode picker hosts, not to any one shell panel.
      installAdaptiveApplyAssist();
      installTextAreaInputSync();

      // 2) Live reactivity: rebuild immediately when componentDensity/textAreaAutoSizeEnabled/fullWidthEnabled changes.
      try {
        var cc = chromeOf(W);
        if (cc && cc.storage && cc.storage.onChanged && cc.storage.onChanged.addListener) {
          var onChanged = function (changes, area) {
            try {
              if (area !== "local" || !changes) { return; }
              if (changes.componentDensity || changes.textAreaAutoSizeEnabled || changes.fullWidthEnabled || changes.customHostPatterns) { scheduleRefresh(); }
            } catch (e) { /* ignore */ }
          };
          cc.storage.onChanged.addListener(onChanged);
          storageListener = { target: cc.storage.onChanged, fn: onChanged };
        }
      } catch (e) { /* ignore */ }

      // 3) SPA re-assert: filtered MutationObserver (our element removed / <head> churn) — debounced.
      // It also watches Kendo grid/spacer churn so rowHeight density keeps the scroll range in sync.
      try {
        var MO = W.MutationObserver;
        var watchRoot = D.documentElement || D.body;
        if (MO && watchRoot) {
          var obs = new MO(function (muts) {
            if (isRelevant(muts)) { scheduleReassert(); }
            if (gridRowHeightFactor(state) !== 1) { scheduleSpacerSync(); }
            if (state.textAreaAutoSizeEnabled === true) { scheduleTextAreaSync(); }
          });
          obs.observe(watchRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
          observers.push(obs);
        }
      } catch (e) { /* ignore */ }

      // 4) Low-frequency safety re-assert (covers no-mutation re-mounts + late <head> at document_start).
      try {
        var iv = W.setInterval(function () { reassert(); }, 2000);
        timers.push(iv);
      } catch (e) { /* ignore */ }

      // 5) Prompt re-assert once the document finishes parsing (land last in <head> quickly).
      try {
        if (D.readyState === "loading" && D.addEventListener) {
          pendingReady = function () { try { reassert(); } catch (eR) { /* ignore */ } };
          D.addEventListener("DOMContentLoaded", pendingReady, { once: true });
        }
      } catch (e) { /* ignore */ }

      function uninstall() {
        try {
          for (var i = 0; i < observers.length; i += 1) { try { observers[i].disconnect(); } catch (eO) { /* ignore */ } }
          for (var j = 0; j < timers.length; j += 1) { try { W.clearInterval(timers[j]); } catch (eT) { /* ignore */ } }
          if (refreshTimer) { try { W.clearTimeout(refreshTimer); } catch (eR) { /* ignore */ } }
          if (reassertTimer) { try { W.clearTimeout(reassertTimer); } catch (eA) { /* ignore */ } }
          if (spacerTimer) { try { W.clearTimeout(spacerTimer); } catch (eP) { /* ignore */ } }
          if (textAreaTimer) { try { W.clearTimeout(textAreaTimer); } catch (eTA) { /* ignore */ } }
          if (storageListener && storageListener.target && storageListener.target.removeListener) {
            try { storageListener.target.removeListener(storageListener.fn); } catch (eS) { /* ignore */ }
          }
          if (pendingReady && D.removeEventListener) {
            try { D.removeEventListener("DOMContentLoaded", pendingReady); } catch (eD) { /* ignore */ }
          }
          if (adaptiveApplyListener && D.removeEventListener) {
            try { D.removeEventListener("click", adaptiveApplyListener, true); } catch (eL) { /* ignore */ }
          }
          if (textAreaInputListener && D.removeEventListener) {
            try { D.removeEventListener("input", textAreaInputListener, true); } catch (eI) { /* ignore */ }
          }
          var el = D.getElementById(STYLE_ID);
          if (el && el.parentNode) { el.parentNode.removeChild(el); }
          clearGridScrollSpacers();
          restoreTextAreas();
          try {
            if (D.documentElement && D.documentElement.dataset) { delete D.documentElement.dataset[DATASET_KEY]; }
          } catch (eX) { /* ignore */ }
          api.__installed = false;
          if (W[MARKER_KEY + "_RUNTIME"] === api) {
            try { delete W[MARKER_KEY + "_RUNTIME"]; } catch (eW) { W[MARKER_KEY + "_RUNTIME"] = null; }
          }
        } catch (e) { /* ignore */ }
      }

      var api = {
        version: VERSION,
        __installed: true,
        apply: function () { readAndApply(); },
        reassert: reassert,
        css: function () { return currentCss; },
        state: function () { return normalizeState(state); },
        marker: function () {
          try { return JSON.parse(D.documentElement.dataset[DATASET_KEY] || "null"); } catch (e) { return null; }
        },
        reasserts: function () { return reasserts; },
        spacerWrites: function () { return spacerWrites; },
        syncGridScrollSpacers: syncGridScrollSpacers,
        syncTextAreas: syncTextAreas,
        uninstall: uninstall
      };
      W[MARKER_KEY + "_RUNTIME"] = api;
      return api;
    } catch (e) { return null; }
  }

  // ===================================================================================================
  // Exports + auto-boot.
  // ===================================================================================================

  var MODULE = {
    version: VERSION,
    FAMILIES: FAMILIES,
    clampFactor: clampFactor,
    isDefaultFactor: isDefaultFactor,
    round2: round2,
    normalizeText: normalizeText,
    isAdaptivePickerTag: isAdaptivePickerTag,
    normalizeState: normalizeState,
    activeAdjustments: activeAdjustments,
    gridRowHeightFactor: gridRowHeightFactor,
    buildCss: buildCss,
    ruleCount: ruleCount,
    install: installRuntime
  };

  // Dual export (mirrors theme-control.js): global for vm-based tests + CommonJS guard.
  root[MARKER_KEY + "_MODULE"] = MODULE;
  if (typeof module !== "undefined" && module.exports) { module.exports = MODULE; }

  // Auto-boot only as a real content script (a browser page with chrome.storage). Inert under Node tests.
  try {
    if (root && root.document && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      installRuntime(root);
    }
  } catch (e) { /* never throw into the page */ }
})(typeof self !== "undefined" ? self : globalThis);
