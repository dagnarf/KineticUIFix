// grid-autofit.js — ISOLATED-world content script that AUTO-FITS Kinetic Kendo grid columns to their
// content whenever a fresh dataset loads. It replicates the "auto size all columns" one-shot that a user
// would otherwise invoke by hand after every Search / Get-More / refresh: it measures each column's
// natural text width across the rendered rows + the header title, then pins the matching <col> widths in
// the grid's header and body colgroups so every column is exactly as wide as its widest visible value
// (no truncation, no dead horizontal space). Sibling of src/theme-control.js + src/padding-control.js and
// INDEPENDENT of the grid fixes: no debugger, no main.js rewrite, no tab reload — it applies LIVE.
// Default OFF (inert until the user enables the toggle).
//
// WHY DOM MEASUREMENT, NOT THE NATIVE KENDO autoFitColumns() (investigation ground truth, live on
// CDP-9100 Education SaaS950 Order Tracker, 2026-06-06; see .tmp/probe-autofit-scroll.mjs):
//   The Kinetic grid is row-virtualized with `table-layout: fixed`, and the header + body tables each
//   carry a <colgroup> of <col style="width:Npx"> whose widths are kept in lockstep — so the <col>
//   widths ARE the single lever that controls column size. Production Angular ships with NO `ng` debug
//   global (`window.ng` is undefined), so the Kendo GridComponent instance (which owns autoFitColumns())
//   is not cheaply reachable from the page; reaching it would need the same heavy Ivy/webpack traversal
//   as the grid-revirtualize fix and a MAIN-world delivery (debugger / reload). Measuring rendered cells
//   with a <canvas> 2D context and writing the <col> widths reaches the SAME result from ISOLATED world,
//   live, with no new permissions — and matches the native semantics (Kendo's own autofit also only sees
//   the rendered/virtualized rows, never the un-rendered ones).
//
// MECHANISM:
//   We fit each column to the MAXIMUM width of the INITIALLY-VIEWABLE data and then hold it. For each
//   column we measure max(headerTitleWidth, max(cellTextWidth over the rendered rows)) via canvas
//   measureText using each element's own computed font, add the column's real horizontal padding + a small
//   header affordance for the sort/menu glyphs, clamp to [MIN,MAX]. We then CONSUME THE MAXIMUM WIDTH: if
//   the natural widths fall short of the grid's viewport, the leftover is distributed across the flexible
//   columns IN PROPORTION to their natural width so the table fills the viewport exactly — no dead
//   horizontal band on the right. (If the natural widths already meet or exceed the viewport, nothing is
//   added and the grid scrolls horizontally as usual; there is no white space to remove.) The resulting
//   width is written on the matching <col> in EVERY colgroup of the grid (header + body, including
//   locked/unlocked panes) plus the table width = sum-of-cols. Columns whose sampled cells carry NO text
//   (pure checkbox / icon columns) are LEFT ALONE so we never collapse a control column nor stretch it past
//   its glyph.
//
// FIT ONCE, DON'T RESIZE AS MORE DATA LOADS: the fit is keyed on the grid's LAYOUT (column count + viewport
//   width — see fitKey), NOT on its row count or row content. So loading more rows (Get-More) and
//   virtual-scrolling do NOT re-fit — the columns stay sized to the first rendered batch even if later rows
//   are wider/narrower. We re-fit only when shouldRefit() sees the layout change (resize / column add or
//   remove) or a genuinely NEW dataset (the grid's top row changes WHILE scrolled to the top — a new
//   Search; an append never changes the top row, and a mid-scroll first row is just a virtualization
//   artifact, so neither re-triggers).
//
// REACTS TO GRID SIZING: the viewport width is part of fitKey, and a ResizeObserver on each grid's content
//   element (plus a window 'resize' fallback) wakes the scanner when the grid is resized — widening the
//   window, dragging a splitter, collapsing a side panel, or any layout change that alters the grid's
//   available width. The settle gate (below) debounces a continuous drag so we re-fit once the new size
//   holds, not on every intermediate frame, and the proportional fill keeps the columns flush to the new
//   viewport edge in both directions (grow on widen, shrink back to the initial-data fit on narrow).
//
// HYGIENE (CLAUDE.md Kinetic-runtime principles): explicit semicolons; fail-safe (never throws into the
//   page); idempotent (per-window install guard); observers/timers registered for teardown; bounded loops;
//   per-grid state in a WeakMap so detached grids are GC'd. The pure engine (column-width math + signature)
//   has no DOM / no chrome.* and is dual-exported for headless tests.

(function (root) {
  "use strict";

  var VERSION = "1.5.0";
  var MARKER_KEY = "__KINETIC_GRID_AUTOFIT__";
  var DATASET_KEY = "kineticGridAutofit";              // -> attribute data-kinetic-grid-autofit
  var HOST_SUFFIX = ".epicorsaas.com";
  // gridHeaderWrapEnabled is read (not owned) here: when the "Wrap column headers" feature is on, the
  // sibling src/grid-header-wrap.js injects the wrap CSS and DEFERS column sizing to us, and we measure each
  // header by its WIDEST WORD (not the full one-line title) so a wrapped multi-word header narrows its
  // column to its widest word instead of forcing a wide one-line column. See measureColumns().
  var STORAGE_KEYS = ["gridAutoSizeEnabled", "gridAutoFitDensity", "gridHeaderWrapEnabled", "customHostPatterns"];

  // Width math constants. Bases are live-measured stock px on the Order-Entry/Order-Tracker size variant.
  var MIN_WIDTH = 24;                                   // never collapse a column below this
  var MAX_WIDTH = 600;                                  // base per-column cap at density 1 (density scales it)
  var CELL_PADDING = 16;                                // fallback ~ .ep-grid-cell padding (0 7px) + a hair of
                                                        // slack; the runtime MEASURES the real cell chrome and
                                                        // overrides this per grid (native parity — see below).
  var HEADER_AFFORDANCE = 22;                           // reserve for the sort arrow + column-menu glyph
  var HEADER_WRAP_MIN_CHROME = 10;                       // Kendo header inset floor so words do not clip at dense settings
  var SAFETY_PAD = 2;                                   // sub-pixel rounding guard against re-truncation
  var DATE_TEXT_PAD = 4;                                // body-text guard for dense mm/dd/yyyy cells at clip edge
  var MAX_SAMPLE_ROWS = 120;                            // bound the per-grid measurement loop
  var SETTLE_MS = 350;                                  // dataset signature must hold this long before a fit
  var FILL_MIN_GAP = 4;                                 // only distribute surplus when the viewport gap exceeds this
  var WIDTH_BUCKET = 4;                                 // round viewport width to this in the fit key (jitter guard)
  var TOP_EPS = 4;                                      // treat scrollTop <= this as "at the top of the grid"

  // DENSITY — the single "information density" lever the popup slider drives (storage gridAutoFitDensity).
  // A factor in [DENSITY_MIN, DENSITY_MAX] where DENSITY_DEF (1) reproduces the native-faithful fit EXACTLY
  // (so the default is a true no-op vs the prior behavior). It scales the chrome added beyond the measured
  // text (cell padding + header affordance) AND the per-column max cap, so dialing it DOWN packs more columns
  // into the viewport (tighter cells, wider columns truncate sooner via the cell's own overflow:hidden
  // ellipsis) and dialing it UP gives roomier columns. Mapping lives in clampDensity()/maxScale()/
  // densityOptions() (pure, exported, unit-tested).
  var DENSITY_MIN = 0.5;
  var DENSITY_MAX = 1.5;
  var DENSITY_DEF = 1;
  var NOW = function () { try { return Date.now(); } catch (e) { return 0; } };

  // ===================================================================================================
  // Pure engine (no DOM / no chrome.*; deterministic). Exported for unit tests.
  // ===================================================================================================

  function numOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  // clampDensity(d) -> a factor in [DENSITY_MIN, DENSITY_MAX]; undefined/NaN -> DENSITY_DEF (the no-op).
  function clampDensity(d) {
    var n = Number(d);
    if (!isFinite(n)) { return DENSITY_DEF; }
    if (n < DENSITY_MIN) { return DENSITY_MIN; }
    if (n > DENSITY_MAX) { return DENSITY_MAX; }
    return n;
  }

  // maxScale(d) -> how the per-column max cap scales with density. Denser (d<1) lowers the cap so a wide
  // free-text column truncates (cell overflow:hidden ellipsis) instead of dominating the row; roomier
  // (d>1) raises it. Linear, monotonic, =1 at d=1: 0.5 -> 0.75, 1 -> 1.0, 1.5 -> 1.25.
  function maxScale(d) {
    return 0.5 + 0.5 * clampDensity(d);
  }

  // densityOptions(density, base) -> the opts object computeColumnWidth() consumes. base supplies the
  // MEASURED cell chrome ({ cellPadding, headerAffordance }) for native parity; missing fields fall back to
  // the module constants. At density 1 with the default base this yields exactly the legacy constants, so
  // the default is a perfect no-op. Pure; exported for unit tests.
  function densityOptions(density, base) {
    var d = clampDensity(density);
    var b = (base && typeof base === "object") ? base : {};
    return {
      cellPadding: numOr(b.cellPadding, CELL_PADDING) * d,
      headerAffordance: numOr(b.headerAffordance, HEADER_AFFORDANCE) * d,
      minWidth: MIN_WIDTH,
      maxWidth: Math.round(MAX_WIDTH * maxScale(d)),
      safetyPad: SAFETY_PAD
    };
  }

  // wrappedHeaderOptions(density, base) -> opts for the auto-fit path when the sibling header-wrap feature
  // owns label wrapping but auto-fit owns widths. We still suppress the sort/menu affordance for compaction,
  // but keep a small header-inset floor before density scaling; at density 0.5 the live Kendo header leaves
  // roughly 5px less text area than the <col> width, so the floor prevents barely-fitted words like "UOM" or
  // "Renewal" from breaking or clipping by sub-pixel rounding.
  function wrappedHeaderOptions(density, base) {
    var b = (base && typeof base === "object") ? base : {};
    var chrome = numOr(b.cellPadding, CELL_PADDING);
    if (chrome < HEADER_WRAP_MIN_CHROME) { chrome = HEADER_WRAP_MIN_CHROME; }
    return densityOptions(density, { cellPadding: chrome, headerAffordance: 0 });
  }

  // computeColumnWidth(col, opts) -> integer px, or null to SKIP the column (leave its width untouched).
  //   col  = { headerWidth:number, contentWidths:number[], hasText:boolean }
  //   opts = { cellPadding, headerAffordance, minWidth, maxWidth, safetyPad } — any field falls back to the
  //          module constant, so computeColumnWidth(col) alone reproduces the original behavior.
  // headerWidth/contentWidths are RAW measured text widths (no padding). A column with no measurable text
  // in any sampled cell AND no header text is skipped (control/checkbox column). Otherwise the target is
  // the widest measured text + cell chrome (+ a header affordance when the header drives the width), clamped
  // to [minWidth, maxWidth]. opts is how the density slider + the per-grid measured chrome reach the math.
  function computeColumnWidth(col, opts) {
    if (!col || typeof col !== "object") { return null; }
    var o = opts || {};
    var cellPad = numOr(o.cellPadding, CELL_PADDING);
    var headerAff = numOr(o.headerAffordance, HEADER_AFFORDANCE);
    var bodyExtra = numOr(col.bodyExtraPad, 0);
    var safety = numOr(o.safetyPad, SAFETY_PAD);
    var minW = numOr(o.minWidth, MIN_WIDTH);
    var maxW = numOr(o.maxWidth, MAX_WIDTH);
    var header = (typeof col.headerWidth === "number" && isFinite(col.headerWidth) && col.headerWidth > 0)
      ? col.headerWidth : 0;
    var bodyMax = 0;
    var widths = Array.isArray(col.contentWidths) ? col.contentWidths : [];
    for (var i = 0; i < widths.length; i += 1) {
      var w = widths[i];
      if (typeof w === "number" && isFinite(w) && w > bodyMax) { bodyMax = w; }
    }
    var hasText = col.hasText === true || header > 0 || bodyMax > 0;
    if (!hasText) { return null; }                     // pure control column -> leave alone
    var headerTarget = header > 0 ? header + cellPad + headerAff : 0;
    var bodyTarget = bodyMax > 0 ? bodyMax + cellPad + bodyExtra : 0;
    var target = Math.max(headerTarget, bodyTarget) + safety;
    return clampWidth(Math.ceil(target), minW, maxW);
  }

  function clampWidth(n, minW, maxW) {
    var lo = numOr(minW, MIN_WIDTH);
    var hi = numOr(maxW, MAX_WIDTH);
    var v = Number(n);
    if (!isFinite(v)) { return lo; }
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return Math.round(v);
  }

  // computeColumnWidths(cols, opts) -> array aligned with cols; each entry is an integer px or null (skip).
  function computeColumnWidths(cols, opts) {
    var out = [];
    if (!Array.isArray(cols)) { return out; }
    for (var i = 0; i < cols.length; i += 1) { out.push(computeColumnWidth(cols[i], opts)); }
    return out;
  }

  // fillToAvailable(widths, controlWidth, available) — distribute leftover viewport width so the table
  // fills its grid exactly, removing dead horizontal space. Pure; exported for unit tests.
  //   widths:       array of integer px or null (null = control/checkbox column to LEAVE untouched)
  //   controlWidth: summed current px of the null columns (the runtime supplies this from the live <col>s)
  //   available:    the grid viewport inner width (content clientWidth); falsey -> no fill
  // If the flexible widths + controlWidth fall short of `available` by more than FILL_MIN_GAP, the surplus
  // is added to the flexible (non-null) columns IN PROPORTION to their natural width — wider columns absorb
  // more — so the column total equals `available` and no white space remains. When the natural fit already
  // meets or exceeds `available` (content wider than the viewport -> horizontal scroll), the widths are
  // returned unchanged: there is no dead space to remove. Returns a NEW array; null entries are preserved.
  function fillToAvailable(widths, controlWidth, available) {
    var out = Array.isArray(widths) ? widths.slice() : [];
    var avail = Number(available);
    if (!isFinite(avail) || avail <= 0) { return out; }
    var idx = [];
    var flexSum = 0;
    for (var i = 0; i < out.length; i += 1) {
      var w = out[i];
      if (typeof w === "number" && isFinite(w) && w > 0) { idx.push(i); flexSum += w; }
    }
    if (idx.length === 0 || flexSum <= 0) { return out; }
    var control = (isFinite(controlWidth) && controlWidth > 0) ? controlWidth : 0;
    var surplus = Math.floor(avail - (flexSum + control));
    if (surplus <= FILL_MIN_GAP) { return out; }         // already fills/overflows (or a trivial gap)
    var added = 0;
    for (var k = 0; k < idx.length; k += 1) {
      var j = idx[k];
      // Last flexible column takes the rounding remainder so the total lands exactly on `available`.
      var share = (k === idx.length - 1) ? (surplus - added) : Math.floor(surplus * (out[j] / flexSum));
      added += share;
      out[j] = out[j] + share;
    }
    return out;
  }

  // fitKey(info) — the LAYOUT identity of a grid: column count + viewport width (bucketed to WIDTH_BUCKET
  // px against sub-pixel jitter). It deliberately EXCLUDES row count and row content, so loading more rows
  // (Get-More) or virtual-scrolling does NOT change it — only a real grid resize or a column add/remove
  // does. This is the spine of "fit once to the initially-viewable data and don't resize as more data
  // loads": the columns are sized from the first rendered batch and then left alone unless the layout (not
  // the data) changes.
  function fitKey(info) {
    if (!info || typeof info !== "object") { return ""; }
    var cols = (typeof info.colCount === "number") ? info.colCount : 0;
    var avail = (typeof info.availableWidth === "number" && isFinite(info.availableWidth))
      ? Math.round(info.availableWidth / WIDTH_BUCKET) * WIDTH_BUCKET : 0;
    return cols + "|" + avail;
  }

  // shouldRefit(prev, cur) — decide whether to (re)fit a grid. Pure; exported for unit tests.
  //   prev: null | { key, topRow }  — the state recorded at the last fit (topRow may be null if that fit
  //         happened while the grid was scrolled, i.e. the true top row was unknown).
  //   cur:  { key, atTop, topRow, hasData } — the grid's current state.
  // Re-fit when: (1) we have never fitted this grid; (2) the layout key changed (viewport resize or a
  // column add/remove); or (3) a genuinely NEW dataset appeared — detected ONLY when the grid is scrolled
  // to the TOP and its first row differs from the first row at the last fit. We trust the first-row
  // identity only at the top because mid-scroll the "first rendered row" is a virtualization artifact, not
  // a new dataset; and a Get-More APPEND never changes the top row. So neither scrolling nor loading more
  // rows ever triggers a re-fit — exactly the requested "size to initial data, hold as more loads".
  function shouldRefit(prev, cur) {
    if (!cur || cur.hasData !== true) { return false; }
    if (!prev) { return true; }
    if (prev.key !== cur.key) { return true; }
    if (cur.atTop === true && typeof prev.topRow === "string" && cur.topRow !== prev.topRow) { return true; }
    return false;
  }

  // ===================================================================================================
  // Runtime (DOM + chrome.storage). ISOLATED world only. Fully inert when gridAutoSizeEnabled is false.
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

  function installRuntime(W) {
    try {
      if (!W || typeof W !== "object" || !W.document) { return null; }
      if (!defaultHostAllowed(W) && !chromeOf(W)) { return null; }
      if (W[MARKER_KEY + "_RUNTIME"] && W[MARKER_KEY + "_RUNTIME"].__installed === true) {
        return W[MARKER_KEY + "_RUNTIME"];
      }

      var D = W.document;
      var enabled = false;
      var density = DENSITY_DEF;                        // gridAutoFitDensity (the popup slider)
      var headerWrap = false;                           // gridHeaderWrapEnabled — measure headers by widest word
      var customHostPatterns = [];
      var observers = [];
      var timers = [];
      var storageListener = null;
      var scanTimer = null;
      var resizeObs = null;                             // ResizeObserver watching each grid's content element
      var windowResize = null;                          // { fn } window 'resize' fallback listener
      var observedGrids = new W.WeakSet();              // content elements already handed to resizeObs
      var fits = 0;                                     // total fit operations performed
      var lastGridCount = 0;
      var lastColWidths = null;                         // most recent applied widths (diagnostics)
      var stateByGrid = new W.WeakMap();               // grid element -> { key, topRow } recorded at last fit
      var pendingByGrid = new W.WeakMap();              // grid element -> { sig, since } awaiting settle
      var measureCanvas = null;
      var measureCtx = null;

      function ctx() {
        try {
          if (!measureCtx) {
            measureCanvas = D.createElement("canvas");
            measureCtx = measureCanvas.getContext("2d");
          }
          return measureCtx;
        } catch (e) { return null; }
      }

      function fontOf(el) {
        try {
          var s = W.getComputedStyle(el);
          if (!s) { return "14px sans-serif"; }
          return (s.fontStyle || "normal") + " " + (s.fontWeight || "400") + " "
            + (s.fontSize || "14px") + " " + (s.fontFamily || "sans-serif");
        } catch (e) { return "14px sans-serif"; }
      }

      function measureText(text, el) {
        var c = ctx();
        if (!c || !text) { return 0; }
        try { c.font = fontOf(el); return c.measureText(text).width; } catch (e) { return 0; }
      }

      function isDateLikeText(text) {
        try {
          var s = String(text || "").trim();
          return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s);
        } catch (e) { return false; }
      }

      // The header + body tables of one logical pane share a colgroup; a grid may have a locked pane
      // (header-locked + content-locked) AND an unlocked pane (header + content). Return the colgroups
      // grouped so each group's <col>s map to the same logical columns.
      function colgroupsOf(grid) {
        var groups = [];
        try {
          var tables = grid.querySelectorAll(".k-grid-header table, .k-grid-table");
          for (var i = 0; i < tables.length; i += 1) {
            var cg = tables[i].querySelector("colgroup");
            if (cg) { groups.push({ table: tables[i], cols: cg.querySelectorAll("col") }); }
          }
        } catch (e) { /* ignore */ }
        return groups;
      }

      function contentOf(grid) {
        return grid.querySelector(".k-grid-content-virtual")
          || grid.querySelector(".k-grid-content.k-virtual-content")
          || grid.querySelector(".k-grid-content")
          || grid;
      }

      function headerThs(grid) {
        try { return grid.querySelectorAll(".k-grid-header thead th"); }
        catch (e) { return []; }
      }

      // A real DATA row only. Kendo renders single full-width PLACEHOLDER rows during load — a
      // `.k-grid-norecords` row whose lone cell holds "Loading Records" / "No records available." — and
      // GROUP / DETAIL / aggregate rows whose cells don't map 1:1 to the columns. Measuring any of those
      // mis-sizes a column (e.g. the loading text lands in column 0). Only `.k-table-row`/`.k-master-row`
      // data rows have one <td> per column, so we measure exclusively those.
      function isDataRow(tr) {
        try {
          if (!tr || tr.nodeName !== "TR") { return false; }
          var cls = " " + String(tr.className || "") + " ";
          if (cls.indexOf(" k-grid-norecords ") >= 0 || cls.indexOf(" k-grouping-row ") >= 0
            || cls.indexOf(" k-group-footer ") >= 0 || cls.indexOf(" k-detail-row ") >= 0) { return false; }
          return cls.indexOf(" k-table-row ") >= 0 || cls.indexOf(" k-master-row ") >= 0;
        } catch (e) { return false; }
      }

      function dataRowsOf(content) {
        var out = [];
        try {
          var tb = content ? content.querySelector("tbody") : null;
          if (!tb || !tb.children) { return out; }
          for (var i = 0; i < tb.children.length && out.length < MAX_SAMPLE_ROWS; i += 1) {
            if (isDataRow(tb.children[i])) { out.push(tb.children[i]); }
          }
        } catch (e) { /* ignore */ }
        return out;
      }

      // Build the fit-decision info for a grid (cheap; no measurement). firstRowText comes from the first
      // DATA row so the loading placeholder never looks like real data; scrollTop lets us trust that row as
      // the dataset's true top only when the grid is actually scrolled to the top.
      function gridInfo(grid) {
        try {
          var content = contentOf(grid);
          var ths = headerThs(grid);
          var rows = dataRowsOf(content);
          return {
            colCount: ths.length,
            availableWidth: content ? content.clientWidth : 0,
            scrollTop: content ? content.scrollTop : 0,
            dataRowCount: rows.length,
            firstRowText: rows.length ? (rows[0].textContent || "").trim() : ""
          };
        } catch (e) { return null; }
      }

      function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

      // Measure the REAL horizontal chrome of a data cell (native parity). Kendo's own autoFit reads each
      // cell's laid-out offsetWidth, which already includes the cell's actual padding + border around the
      // text; we replicate that by measuring a sample cell's computed padding + border (on both the <td> and
      // its .ep-grid-cell wrapper) instead of trusting the hardcoded CELL_PADDING. This keeps the fit correct
      // across grid size variants (compact .ep-short-control vs roomy) where the stock padding differs. The
      // header affordance stays a reserve constant (room for the sort/menu glyph, which is often not rendered
      // at measure time and so cannot be measured). Returns { cellPadding, headerAffordance }; on any failure
      // it falls back to the module constants so the fit degrades safely.
      function measureCellChrome(grid) {
        try {
          var content = contentOf(grid);
          var rows = dataRowsOf(content);
          for (var r = 0; r < rows.length; r += 1) {
            var tds = rows[r].children;
            for (var c = 0; c < tds.length; c += 1) {
              var td = tds[c];
              if (!(td.textContent || "").trim()) { continue; }
              var inner = td.querySelector(".ep-grid-cell") || td;
              var ics = W.getComputedStyle(inner);
              var tcs = (inner === td) ? null : W.getComputedStyle(td);
              var chrome = px(ics.paddingLeft) + px(ics.paddingRight)
                + px(ics.borderLeftWidth) + px(ics.borderRightWidth);
              if (tcs) {
                chrome += px(tcs.paddingLeft) + px(tcs.paddingRight)
                  + px(tcs.borderLeftWidth) + px(tcs.borderRightWidth);
              }
              if (isFinite(chrome) && chrome > 0) {
                return { cellPadding: chrome, headerAffordance: HEADER_AFFORDANCE };
              }
            }
          }
        } catch (e) { /* ignore */ }
        return { cellPadding: CELL_PADDING, headerAffordance: HEADER_AFFORDANCE };
      }

      // Measure each column's natural text widths over the rendered rows + header title. Returns the
      // per-column descriptor array consumed by computeColumnWidths().
      function measureColumns(grid) {
        var cols = [];
        try {
          var ths = headerThs(grid);
          var n = ths.length;
          if (n === 0) { return cols; }
          for (var h = 0; h < n; h += 1) {
            var th = ths[h];
            var titleEl = th.querySelector(".k-column-title") || th.querySelector(".k-link") || th;
            var headerText = (titleEl.textContent || "").trim();
            // When header wrapping is on, the title is allowed to stack across lines, so the column only
            // needs to be as wide as the WIDEST WORD — not the full one-line string. Measuring the widest
            // word lets a multi-word title (e.g. "Exclude from Cycle Count" on a checkbox column) narrow to
            // its widest word and stack vertically instead of pinning a wide one-line column.
            var headerWidth;
            if (headerWrap && headerText.indexOf(" ") >= 0) {
              var words = headerText.split(/\s+/);
              headerWidth = 0;
              for (var wi = 0; wi < words.length; wi += 1) {
                if (!words[wi]) { continue; }
                var ww = measureText(words[wi], titleEl);
                if (ww > headerWidth) { headerWidth = ww; }
              }
            } else {
              headerWidth = measureText(headerText, titleEl);
            }
            cols.push({ headerWidth: headerWidth, contentWidths: [], hasText: headerText.length > 0, bodyExtraPad: 0 });
          }
          var content = contentOf(grid);
          var rows = dataRowsOf(content);
          if (rows.length) {
            for (var r = 0; r < rows.length; r += 1) {
              var tds = rows[r].children;
              for (var ci = 0; ci < tds.length && ci < n; ci += 1) {
                var td = tds[ci];
                var inner = td.querySelector(".ep-grid-cell") || td;
                var text = (td.textContent || "").trim();
                if (!text) { continue; }
                cols[ci].hasText = true;
                if (isDateLikeText(text)) { cols[ci].bodyExtraPad = DATE_TEXT_PAD; }
                cols[ci].contentWidths.push(measureText(text, inner));
              }
            }
          }
        } catch (e) { /* ignore */ }
        return cols;
      }

      // Sum the live <col> widths of the CONTROL columns (those `widths[i] === null` — the ones we leave
      // untouched). Used so fillToAvailable() knows how much of the viewport the control columns already
      // claim before it distributes the surplus across the flexible columns.
      function controlColsWidth(grid, widths) {
        var sum = 0;
        try {
          var groups = colgroupsOf(grid);
          if (!groups.length) { return 0; }
          var cols = groups[0].cols;
          for (var i = 0; i < cols.length; i += 1) {
            if (i < widths.length && widths[i] !== null) { continue; }   // flexible column, not control
            var cur = parseFloat(cols[i].style.width || "0");
            sum += (isFinite(cur) && cur > 0) ? cur : MIN_WIDTH;
          }
        } catch (e) { /* ignore */ }
        return sum;
      }

      // Apply per-column widths (null entries skipped) to every colgroup + table width on the grid.
      function applyWidths(grid, widths) {
        var applied = 0;
        try {
          var groups = colgroupsOf(grid);
          for (var g = 0; g < groups.length; g += 1) {
            var cols = groups[g].cols;
            var sum = 0;
            var measured = true;
            for (var i = 0; i < cols.length; i += 1) {
              var target = (i < widths.length) ? widths[i] : null;
              var cur = parseFloat(cols[i].style.width || "0");
              if (target === null || !isFinite(target)) {
                // Skipped column: keep its current width but still count it toward the table width.
                sum += (isFinite(cur) && cur > 0) ? cur : MIN_WIDTH;
                continue;
              }
              if (cols[i].style.width !== target + "px") { cols[i].style.width = target + "px"; applied += 1; }
              sum += target;
            }
            // Pin the table width to the sum so table-layout:fixed honors the new column widths and the
            // header/body panes stay aligned. Guard against a degenerate 0 (no measurable cols).
            if (measured && sum > 0) {
              try { groups[g].table.style.width = sum + "px"; } catch (eT) { /* ignore */ }
            }
          }
        } catch (e) { /* ignore */ }
        return applied;
      }

      function publishMarker() {
        try {
          var marker = {
            version: VERSION,
            active: enabled === true,
            density: density,
            fits: fits,
            grids: lastGridCount,
            lastColWidths: Array.isArray(lastColWidths) ? lastColWidths.slice(0, 64) : null
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
          if (D.documentElement && D.documentElement.dataset) { delete D.documentElement.dataset[DATASET_KEY]; }
        } catch (e) { /* ignore */ }
      }

      // Fit one grid IF shouldRefit() says its LAYOUT changed (resize / column change) or a NEW dataset
      // appeared (top row changed at the top) AND the trigger state has held stable through the settle
      // window (so we never fit a transient/loading render). Loading more rows or virtual-scrolling never
      // re-fits: the columns stay sized to the initially-viewable data. Returns "fit" | "settling" | "skip".
      //   force=true bypasses the shouldRefit gate, so a manual re-fit / toggle-on re-measures the current
      //   view. It does NOT bypass the settle gate: EVERY fit waits for the trigger state to hold SETTLE_MS.
      function fitGrid(grid, force) {
        try {
          var info = gridInfo(grid);
          if (!info || info.colCount === 0) { return "skip"; }
          // Need real DATA rows to measure; a grid showing only the loading/no-records placeholder is not
          // ready — wait (settling) so we never fit the placeholder.
          if (!info.dataRowCount) { return "settling"; }

          var key = fitKey(info);
          var atTop = info.scrollTop <= TOP_EPS;
          var cur = { key: key, atTop: atTop, topRow: info.firstRowText, hasData: true };
          var prev = stateByGrid.get(grid) || null;

          if (force !== true && !shouldRefit(prev, cur)) {
            // No re-fit. If we'd fitted earlier while scrolled (topRow unknown) and the user is now at the
            // top, quietly record the true top row as the dataset baseline WITHOUT resizing anything.
            if (prev && atTop && typeof prev.topRow !== "string") {
              stateByGrid.set(grid, { key: prev.key, topRow: info.firstRowText });
            }
            return "skip";
          }

          // Stability gate (always): the trigger state must hold for SETTLE_MS across scans before we fit,
          // so a resize drag / dataset load settles to one fit instead of fitting every intermediate frame.
          var settleSig = key + "|" + (atTop ? String(info.firstRowText).slice(0, 160) : "~scrolled");
          var p = pendingByGrid.get(grid);
          var now = NOW();
          if (!p || p.sig !== settleSig) { pendingByGrid.set(grid, { sig: settleSig, since: now }); return "settling"; }
          if (now - p.since < SETTLE_MS) { return "settling"; }          // still settling -> wait

          var cols = measureColumns(grid);
          // Density slider + per-grid measured cell chrome flow into the width math through opts.
          var chrome = measureCellChrome(grid);
          // In wrapped-header mode we size header-driven columns to the widest word and let the title stack.
          // Suppress the sort/menu affordance, but preserve a small header-inset floor so whole words remain
          // intact even at the densest setting.
          var opts = headerWrap ? wrappedHeaderOptions(density, chrome) : densityOptions(density, chrome);
          var natural = computeColumnWidths(cols, opts);
          // Consume the maximum width: size each column to its widest INITIALLY-VIEWABLE content, then grow
          // the flexible columns to fill the viewport (no dead space). Control columns keep their live width
          // and bound the surplus.
          var controlWidth = controlColsWidth(grid, natural);
          var widths = fillToAvailable(natural, controlWidth, info.availableWidth);
          var applied = applyWidths(grid, widths);
          // Record the baseline: the top row only counts as the dataset identity when we were at the top.
          stateByGrid.set(grid, { key: key, topRow: atTop ? info.firstRowText : (prev ? prev.topRow : null) });
          pendingByGrid.delete(grid);
          if (applied > 0) {
            fits += 1;
            lastColWidths = widths;
            publishMarker();
          }
          return "fit";
        } catch (e) { return "skip"; }
      }

      function scanAndFit(force) {
        if (!enabled) { return; }
        try {
          if (!hostAllowed(W, { customHostPatterns: customHostPatterns })) { return; }
          var grids = D.querySelectorAll(".k-grid");
          lastGridCount = grids.length;
          var anySettling = false;
          for (var i = 0; i < grids.length; i += 1) {
            // Watch each grid's content element for resize so a layout change (window/splitter/panel) wakes
            // the scanner — the changed viewport width flips the signature and we re-fit + re-fill.
            if (resizeObs) {
              try {
                var cel = contentOf(grids[i]);
                if (cel && !observedGrids.has(cel)) { resizeObs.observe(cel); observedGrids.add(cel); }
              } catch (eR) { /* ignore */ }
            }
            if (fitGrid(grids[i], force === true) === "settling") { anySettling = true; }
          }
          // A grid is mid-load (rows still streaming, or its signature just changed / is settling): re-check
          // soon so the fit lands promptly once it settles, instead of waiting for the slow safety interval.
          if (anySettling) { scheduleScan(false); }
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      function scheduleScan(force) {
        if (scanTimer) { W.clearTimeout(scanTimer); }
        scanTimer = W.setTimeout(function () { scanTimer = null; scanAndFit(force === true); }, 160);
      }

      // Relevance filter: only re-scan when grid rows/tables churn (a load), not on page-wide SPA churn.
      function isGridRelevant(muts) {
        try {
          for (var i = 0; i < muts.length; i += 1) {
            var m = muts[i];
            var t = m.target;
            if (t && t.nodeType === 1) {
              var tn = t.nodeName;
              if (tn === "TBODY" || tn === "TR" || tn === "TABLE" || tn === "COLGROUP") { return true; }
              var cls = String(t.className || "");
              if (cls.indexOf("k-grid") >= 0 || cls.indexOf("k-table") >= 0) { return true; }
            }
            var added = m.addedNodes;
            if (added && added.length) {
              for (var j = 0; j < added.length && j < 12; j += 1) {
                var nn = added[j] && added[j].nodeName;
                if (nn === "TR" || nn === "TABLE" || nn === "TBODY" || nn === "KENDO-GRID") { return true; }
                var ac = added[j] && added[j].className ? String(added[j].className) : "";
                if (ac.indexOf("k-grid") >= 0 || ac.indexOf("k-table") >= 0) { return true; }
              }
            }
          }
        } catch (e) { return true; }
        return false;
      }

      function teardownReactive() {
        for (var i = 0; i < observers.length; i += 1) { try { observers[i].disconnect(); } catch (e) { /* ignore */ } }
        observers = [];
        for (var j = 0; j < timers.length; j += 1) { try { W.clearInterval(timers[j]); } catch (e) { /* ignore */ } }
        timers = [];
        if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { /* ignore */ } resizeObs = null; }
        observedGrids = new W.WeakSet();
        if (windowResize) {
          try { W.removeEventListener("resize", windowResize.fn); } catch (e) { /* ignore */ }
          windowResize = null;
        }
        if (scanTimer) { try { W.clearTimeout(scanTimer); } catch (e) { /* ignore */ } scanTimer = null; }
      }

      // Bring the reactive layer up (observer + safety interval) only while enabled; tear it down when off.
      function setEnabled(next) {
        var was = enabled;
        enabled = next === true;
        if (enabled && !was) {
          try {
            var MO = W.MutationObserver;
            var watchRoot = D.body || D.documentElement;
            if (MO && watchRoot) {
              var obs = new MO(function (muts) { if (isGridRelevant(muts)) { scheduleScan(false); } });
              obs.observe(watchRoot, { childList: true, subtree: true });
              observers.push(obs);
            }
          } catch (e) { /* ignore */ }
          // Resize reactivity: a ResizeObserver on each grid's content element catches splitter/panel/window
          // size changes that emit NO DOM mutation, so the autofit re-fills to the new viewport edge.
          try {
            var RO = W.ResizeObserver;
            if (RO) { resizeObs = new RO(function () { scheduleScan(false); }); observedGrids = new W.WeakSet(); }
          } catch (eRO) { /* ignore */ }
          try {
            var onResize = function () { scheduleScan(false); };
            W.addEventListener("resize", onResize, { passive: true });
            windowResize = { fn: onResize };
          } catch (eWR) { /* ignore */ }
          try { var iv = W.setInterval(function () { scanAndFit(false); }, 1500); timers.push(iv); } catch (e2) { /* ignore */ }
          scheduleScan(true);
        } else if (!enabled && was) {
          teardownReactive();
        }
        publishMarker();
      }

      function readAndApply() {
        try {
          var c = chromeOf(W);
          if (!c || !c.storage || !c.storage.local || !c.storage.local.get) { return; }
          c.storage.local.get(STORAGE_KEYS, function (v) {
            try {
              customHostPatterns = normalizeHostPatterns(v && v.customHostPatterns);
              density = clampDensity(v && v.gridAutoFitDensity);
              headerWrap = !!(v && v.gridHeaderWrapEnabled === true);
              var on = !!(v && v.gridAutoSizeEnabled === true);
              setEnabled(on);
              // Force a re-fit on every (re)read while enabled so a density-slider change (which leaves the
              // layout key + dataset unchanged, so shouldRefit would skip it) actually re-packs the columns.
              if (on) { scheduleScan(true); }
            } catch (eN) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }
      }

      // 1) Initial state.
      readAndApply();

      // 2) Live reactivity: re-read when the toggle (or host list) changes.
      try {
        var cc = chromeOf(W);
        if (cc && cc.storage && cc.storage.onChanged && cc.storage.onChanged.addListener) {
          var onChanged = function (changes, area) {
            try {
              if (area !== "local" || !changes) { return; }
              if (changes.gridAutoSizeEnabled || changes.gridAutoFitDensity || changes.gridHeaderWrapEnabled || changes.customHostPatterns) { readAndApply(); }
            } catch (e) { /* ignore */ }
          };
          cc.storage.onChanged.addListener(onChanged);
          storageListener = { target: cc.storage.onChanged, fn: onChanged };
        }
      } catch (e) { /* ignore */ }

      function uninstall() {
        try {
          teardownReactive();
          if (storageListener && storageListener.target && storageListener.target.removeListener) {
            try { storageListener.target.removeListener(storageListener.fn); } catch (eS) { /* ignore */ }
          }
          clearMarker();
          api.__installed = false;
          if (W[MARKER_KEY + "_RUNTIME"] === api) {
            try { delete W[MARKER_KEY + "_RUNTIME"]; } catch (eW) { W[MARKER_KEY + "_RUNTIME"] = null; }
          }
        } catch (e) { /* ignore */ }
      }

      var api = {
        version: VERSION,
        __installed: true,
        refresh: function () { readAndApply(); },
        fitNow: function () { scanAndFit(true); },           // force a fit (manual / test)
        fits: function () { return fits; },
        marker: function () {
          try { return JSON.parse(D.documentElement.dataset[DATASET_KEY] || "null"); } catch (e) { return null; }
        },
        uninstall: uninstall
      };
      W[MARKER_KEY + "_RUNTIME"] = api;
      publishMarker();
      return api;
    } catch (e) { return null; }
  }

  // ===================================================================================================
  // Exports + auto-boot.
  // ===================================================================================================

  var MODULE = {
    version: VERSION,
    MIN_WIDTH: MIN_WIDTH,
    MAX_WIDTH: MAX_WIDTH,
    CELL_PADDING: CELL_PADDING,
    HEADER_AFFORDANCE: HEADER_AFFORDANCE,
    HEADER_WRAP_MIN_CHROME: HEADER_WRAP_MIN_CHROME,
    DATE_TEXT_PAD: DATE_TEXT_PAD,
    FILL_MIN_GAP: FILL_MIN_GAP,
    WIDTH_BUCKET: WIDTH_BUCKET,
    TOP_EPS: TOP_EPS,
    DENSITY_MIN: DENSITY_MIN,
    DENSITY_MAX: DENSITY_MAX,
    DENSITY_DEF: DENSITY_DEF,
    computeColumnWidth: computeColumnWidth,
    computeColumnWidths: computeColumnWidths,
    fillToAvailable: fillToAvailable,
    clampWidth: clampWidth,
    clampDensity: clampDensity,
    maxScale: maxScale,
    densityOptions: densityOptions,
    wrappedHeaderOptions: wrappedHeaderOptions,
    fitKey: fitKey,
    shouldRefit: shouldRefit,
    install: installRuntime
  };

  root[MARKER_KEY + "_MODULE"] = MODULE;
  if (typeof module !== "undefined" && module.exports) { module.exports = MODULE; }

  try {
    if (root && root.document && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      installRuntime(root);
    }
  } catch (e) { /* never throw into the page */ }
})(typeof self !== "undefined" ? self : globalThis);
