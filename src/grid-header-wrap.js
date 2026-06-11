// grid-header-wrap.js — ISOLATED-world content script that LINE-WRAPS Kinetic grid column-header titles
// (instead of forcing each title onto one line with an ellipsis) and NARROWS the columns whose width was
// only being dictated by a long multi-word header. Sibling of src/theme-control.js / src/padding-control.js
// / src/grid-autofit.js and INDEPENDENT of the grid fixes: no debugger, no main.js rewrite, no tab reload —
// it applies LIVE. Default OFF (inert until the user enables the toggle).
//
// SYMPTOM / MOTIVATION (live ground truth, CDP-9100 Education SaaS950, ABC Code Maintenance grid IMMT1005,
//   2026-06-09): every header title renders on ONE line — the title element carries
//   `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` via `.ep-grid-hdr.ep-text-truncate`, and
//   the grid is `table-layout:fixed` with explicit `<col style="width:Npx">`. A boolean column whose DATA is
//   just a checkbox glyph is therefore sized to fit its WHOLE title on one line — e.g. "Exclude from Cycle
//   Count" pins that column to 229px while its content needs ~20px. The wide single-line headers waste a lot
//   of horizontal space and push later columns off-screen behind a horizontal scrollbar.
//
// CURE (two coordinated levers):
//   1) WRAP CSS — inject ONE scoped stylesheet that flips the header title to `white-space:normal` (clip the
//      ellipsis, allow overflow, top-align the cell) so a multi-word title STACKS VERTICALLY instead of
//      truncating. This alone makes the full title legible; combined with (2) it lets the column shrink to
//      the width of its widest single WORD so e.g. "Exclude / from / Cycle / Count" stacks at natural word
//      boundaries in a narrow column. Purely visual, theme-safe, a no-op on single-line headers.
//   2) WIDTH NARROWING — for each column whose header is the BINDING width constraint (a multi-word title
//      wider than the column's own content), pin the matching `<col>` width DOWN to max(widestWord, content)
//      + header chrome, in EVERY colgroup (header + body) plus the table width, so table-layout:fixed honors
//      it. We only ever SHRINK (never widen) and only when wrapping frees real space, so columns whose width
//      is driven by their data are left exactly as they were.
//
// RACE-FREE COORDINATION WITH AUTO-FIT (src/grid-autofit.js): both features write `<col>` widths, so exactly
//   ONE may own them at a time. When `gridAutoSizeEnabled` is ON, this script writes NO widths — it injects
//   only the wrap CSS and DEFERS sizing to grid-autofit, which (when `gridHeaderWrapEnabled` is set) measures
//   header titles by their widest WORD and narrows them as part of its own fit. When auto-fit is OFF, this
//   script owns the narrowing itself (shrink-only). Toggling auto-fit flips ownership cleanly via the storage
//   change listener. The two never write widths simultaneously.
//
// RESTORE ON DISABLE: the first time a column is narrowed, its original `<col>` width is stashed on the
//   element (data-kinetic-hw-orig). Turning the feature off removes the wrap CSS and restores every stashed
//   width + the table width, so the grid returns to its native layout without a reload (best-effort — Kinetic
//   re-asserts its own widths on the next dataset render regardless).
//
// HYGIENE (CLAUDE.md Kinetic-runtime principles): explicit semicolons; fail-safe (never throws into the
//   page); idempotent (per-window install guard + single styled element id); observers/timers registered for
//   teardown; bounded loops. The pure engine (word split + wrap-width math) has no DOM / no chrome.* and is
//   dual-exported for headless tests.

(function (root) {
  "use strict";

  var VERSION = "1.0.0";
  var MARKER_KEY = "__KINETIC_GRID_HEADER_WRAP__";
  var DATASET_KEY = "kineticGridHeaderWrap";            // -> attribute data-kinetic-grid-header-wrap
  var STYLE_ID = "kinetic-grid-header-wrap-style";
  var ORIG_ATTR = "data-kinetic-hw-orig";               // stash a col's pre-narrow width for restore
  var HOST_SUFFIX = ".epicorsaas.com";
  var STORAGE_KEYS = ["gridHeaderWrapEnabled", "gridAutoSizeEnabled", "customHostPatterns"];

  // Width math constants (px). For wrapping we hug the WIDEST WORD so a short-word multi-word title (e.g.
  // "Exclude from Cycle Count") stacks at word boundaries and frees horizontal space without breaking
  // whole words. We deliberately do NOT reserve the sort/menu affordance in the width (unlike autofit): a
  // wrapped header is an explicit compaction, and the title's wrap width tracks the column width.
  var MIN_WIDTH = 24;                                   // never collapse a column below this (boolean glyph still fits)
  var CELL_PADDING = 16;                                // fallback header cell horizontal chrome
  var WORD_FIT_PAD = 4;                                 // breathing room added beyond the measured cell padding + widest word
  var SHRINK_THRESHOLD = 8;                             // only narrow when it frees more than this many px
  var SAFETY_PAD = 2;                                   // sub-pixel rounding guard
  var MAX_SAMPLE_ROWS = 120;                            // bound the per-grid content measurement loop
  var INTERVAL_MS = 1500;                               // low-frequency safety re-assert period

  // ===================================================================================================
  // Pure engine (no DOM / no chrome.*; deterministic). Exported for unit tests.
  // ===================================================================================================

  function numOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  // splitWords(title) -> the whitespace-delimited tokens of a header title (empties dropped). A header with
  // fewer than two words cannot benefit from wrapping, so callers skip those columns.
  function splitWords(title) {
    if (typeof title !== "string") { return []; }
    var parts = title.replace(/\s+/g, " ").trim().split(" ");
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i]) { out.push(parts[i]); }
    }
    return out;
  }

  // widestWordWidth(words, measure) -> the max measured px of any single word. `measure` is a (text)->px
  // function (the runtime passes a canvas measureText bound to the header font; tests pass a stub).
  function widestWordWidth(words, measure) {
    if (!Array.isArray(words) || typeof measure !== "function") { return 0; }
    var max = 0;
    for (var i = 0; i < words.length; i += 1) {
      var w = measure(words[i]);
      if (typeof w === "number" && isFinite(w) && w > max) { max = w; }
    }
    return max;
  }

  // computeWrapWidth(col, opts) -> the integer px to SHRINK this column to, or null to LEAVE IT UNTOUCHED.
  //   col  = { words:string[], widestWordPx:number, contentPx:number, currentWidth:number }
  //   opts = { chrome, minWidth, threshold, safetyPad } — any field falls back to the module constant.
  // A column is narrowed only when (a) its header has >= 2 words (so wrapping is meaningful), AND (b) the
  // wrap target — max(widestWord, content) + header chrome — is at least `threshold` px SMALLER than the
  // column's current width (so wrapping genuinely frees space). The widest WORD (not the full title) is the
  // floor so every word still fits on its own line; the column's own content is also a floor so we never
  // clip the data. We never widen: if the target is not meaningfully smaller, return null. Pure; exported.
  function computeWrapWidth(col, opts) {
    if (!col || typeof col !== "object") { return null; }
    var o = opts || {};
    var chrome = numOr(o.chrome, CELL_PADDING + WORD_FIT_PAD);
    var minW = numOr(o.minWidth, MIN_WIDTH);
    var threshold = numOr(o.threshold, SHRINK_THRESHOLD);
    var safety = numOr(o.safetyPad, SAFETY_PAD);
    var words = Array.isArray(col.words) ? col.words : [];
    if (words.length < 2) { return null; }              // single-word header: wrapping can't narrow it
    var current = numOr(col.currentWidth, 0);
    if (current <= 0) { return null; }
    var widestWord = numOr(col.widestWordPx, 0);
    var content = numOr(col.contentPx, 0);
    var target = Math.ceil(Math.max(widestWord, content) + chrome + safety);
    if (target < minW) { target = minW; }
    if (target <= current - threshold) { return target; }
    return null;
  }

  // computeWrapWidths(cols, opts) -> array aligned with cols; each entry is an integer px or null (skip).
  function computeWrapWidths(cols, opts) {
    var out = [];
    if (!Array.isArray(cols)) { return out; }
    for (var i = 0; i < cols.length; i += 1) { out.push(computeWrapWidth(cols[i], opts)); }
    return out;
  }

  // The scoped wrap stylesheet. Targets the Kinetic header title wrapper (.ep-grid-hdr.ep-text-truncate) and
  // its inner text span, plus the generic Kendo header title fallbacks, so multi-word titles wrap + stack.
  // Appended LAST in <head> with !important so it wins source-order ties over Kinetic's truncation rules.
  function wrapCss() {
    return [
      // Let the title wrap instead of truncating with an ellipsis.
      ".k-grid-header .ep-grid-hdr.ep-text-truncate,",
      ".k-grid-header .ep-grid-cell-text,",
      ".k-grid-header .k-column-title,",
      ".k-grid-header .k-link{",
      "white-space:normal !important;",
      "text-overflow:clip !important;",
      "overflow:visible !important;",
      "overflow-wrap:normal !important;",
      "word-break:normal !important;",
      "hyphens:none !important;",
      "line-height:1.15 !important;",
      "text-align:center !important;",
      "}",
      // The truncate container is laid out for a single line; let it grow vertically.
      ".k-grid-header .ep-grid-hdr.ep-text-truncate{display:block !important;height:auto !important;max-height:none !important;}",
      // Center the header label independently from the body-data alignment, top-align stacked titles, and
      // let the row grow to the tallest title.
      ".k-grid-header .k-cell-inner{align-items:flex-start !important;justify-content:center !important;text-align:center !important;}",
      ".k-grid-header .k-link{justify-content:center !important;text-align:center !important;}",
      ".k-grid-header thead th,",
      ".k-grid-header .k-table-th{height:auto !important;white-space:normal !important;vertical-align:top !important;text-align:center !important;}"
    ].join("");
  }

  // ===================================================================================================
  // Runtime (DOM + chrome.storage). ISOLATED world only. Fully inert when gridHeaderWrapEnabled is false.
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
      var wrapOn = false;                                // gridHeaderWrapEnabled
      var autofitOn = false;                             // gridAutoSizeEnabled (we defer widths to it when on)
      var customHostPatterns = [];
      var observers = [];
      var timers = [];
      var storageListener = null;
      var scanTimer = null;
      var narrowed = 0;                                  // total columns narrowed
      var lastGridCount = 0;
      var lastTargets = null;
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

      function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

      // The header + body tables of one logical pane share a colgroup. Return each table + its <col>s so a
      // width written here lands on the matching column in every pane (header, body, locked + unlocked).
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

      // Measure the header cell's own horizontal padding + border (NOT the sort/menu affordance — see the
      // WORD_FIT_PAD note) and add a small breathing pad. The result is the px to add to the widest WORD so
      // the column hugs that word and stacks the title one word per line. Falls back to the module constant.
      function measureHeaderChrome(grid) {
        try {
          var ths = headerThs(grid);
          for (var i = 0; i < ths.length; i += 1) {
            var th = ths[i];
            var tcs = W.getComputedStyle(th);
            var chrome = px(tcs.paddingLeft) + px(tcs.paddingRight)
              + px(tcs.borderLeftWidth) + px(tcs.borderRightWidth);
            if (isFinite(chrome) && chrome >= 0) {
              return { chrome: chrome + WORD_FIT_PAD };
            }
          }
        } catch (e) { /* ignore */ }
        return { chrome: CELL_PADDING + WORD_FIT_PAD };
      }

      // Build the per-column descriptor array consumed by computeWrapWidths(): the header title's words +
      // widest-word px, the widest sampled CONTENT px, and the column's current <col> width. Index-aligned
      // with the header ths (which match the <col>s 1:1, including the leading control column).
      function measureColumns(grid) {
        var cols = [];
        try {
          var ths = headerThs(grid);
          var n = ths.length;
          if (n === 0) { return cols; }
          var groups = colgroupsOf(grid);
          var colEls = groups.length ? groups[0].cols : null;
          for (var h = 0; h < n; h += 1) {
            var th = ths[h];
            var titleEl = th.querySelector(".ep-grid-cell-text") || th.querySelector(".k-column-title")
              || th.querySelector(".k-link") || th;
            var headerText = (titleEl.textContent || "").trim();
            var words = splitWords(headerText);
            var widest = widestWordWidth(words, function (word) { return measureText(word, titleEl); });
            var current = 0;
            if (colEls && h < colEls.length) { current = px(colEls[h].style.width); }
            cols.push({ words: words, widestWordPx: widest, contentPx: 0, currentWidth: current });
          }
          var content = contentOf(grid);
          var rows = dataRowsOf(content);
          for (var r = 0; r < rows.length; r += 1) {
            var tds = rows[r].children;
            for (var ci = 0; ci < tds.length && ci < n; ci += 1) {
              var td = tds[ci];
              var inner = td.querySelector(".ep-grid-cell") || td;
              var text = (td.textContent || "").trim();
              if (!text) { continue; }
              var w = measureText(text, inner);
              if (w > cols[ci].contentPx) { cols[ci].contentPx = w; }
            }
          }
        } catch (e) { /* ignore */ }
        return cols;
      }

      // Shrink the columns whose header is the binding constraint (targets[i] !== null). Writes the new width
      // to the matching <col> in EVERY colgroup + re-pins the table width to the new sum so table-layout:fixed
      // honors it. Stashes each col's original width once (ORIG_ATTR) for restore. Returns the count applied.
      function applyNarrow(grid, targets) {
        var applied = 0;
        try {
          var groups = colgroupsOf(grid);
          for (var g = 0; g < groups.length; g += 1) {
            var colEls = groups[g].cols;
            var sum = 0;
            for (var i = 0; i < colEls.length; i += 1) {
              var col = colEls[i];
              var cur = px(col.style.width);
              var target = (i < targets.length) ? targets[i] : null;
              if (target === null || !isFinite(target) || target >= cur) {
                sum += (cur > 0) ? cur : MIN_WIDTH;
                continue;
              }
              if (!col.hasAttribute(ORIG_ATTR)) { col.setAttribute(ORIG_ATTR, String(cur > 0 ? cur : "")); }
              if (col.style.width !== target + "px") { col.style.width = target + "px"; applied += 1; }
              sum += target;
            }
            if (sum > 0) { try { groups[g].table.style.width = sum + "px"; } catch (eT) { /* ignore */ } }
          }
        } catch (e) { /* ignore */ }
        return applied;
      }

      // Restore every column this script narrowed (those carrying ORIG_ATTR) back to its stashed width, and
      // re-pin the table width to the restored sum. Used when the feature is turned off or yields to autofit.
      function restoreWidths() {
        try {
          var grids = D.querySelectorAll(".k-grid");
          for (var gi = 0; gi < grids.length; gi += 1) {
            var groups = colgroupsOf(grids[gi]);
            for (var g = 0; g < groups.length; g += 1) {
              var colEls = groups[g].cols;
              var sum = 0;
              var touched = false;
              for (var i = 0; i < colEls.length; i += 1) {
                var col = colEls[i];
                if (col.hasAttribute(ORIG_ATTR)) {
                  var orig = px(col.getAttribute(ORIG_ATTR));
                  if (orig > 0) { col.style.width = orig + "px"; }
                  col.removeAttribute(ORIG_ATTR);
                  touched = true;
                }
                var cur = px(col.style.width);
                sum += (cur > 0) ? cur : MIN_WIDTH;
              }
              if (touched && sum > 0) { try { groups[g].table.style.width = sum + "px"; } catch (eT) { /* ignore */ } }
            }
          }
        } catch (e) { /* ignore */ }
      }

      function ensureWrapStyle() {
        try {
          var head = D.head || (D.getElementsByTagName("head")[0]) || D.documentElement;
          if (!head) { return; }
          var el = D.getElementById(STYLE_ID);
          if (!el) {
            el = D.createElement("style");
            el.id = STYLE_ID;
            el.setAttribute("data-kinetic-grid-fix", "header-wrap");
          }
          var text = wrapCss();
          if (el.textContent !== text) { el.textContent = text; }
          if (el.parentNode !== head || head.lastChild !== el) { head.appendChild(el); }
        } catch (e) { /* ignore */ }
      }

      function removeWrapStyle() {
        try {
          var el = D.getElementById(STYLE_ID);
          if (el && el.parentNode) { el.parentNode.removeChild(el); }
        } catch (e) { /* ignore */ }
      }

      function publishMarker() {
        try {
          var marker = {
            version: VERSION,
            active: wrapOn === true,
            autofitDeferred: wrapOn === true && autofitOn === true,
            grids: lastGridCount,
            narrowed: narrowed,
            lastTargets: Array.isArray(lastTargets) ? lastTargets.slice(0, 64) : null
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

      // One scan: keep the wrap CSS pinned, then (only when auto-fit is OFF) narrow header-bound columns.
      function scan() {
        if (!wrapOn) { return; }
        try {
          if (!hostAllowed(W, { customHostPatterns: customHostPatterns })) { return; }
          ensureWrapStyle();
          var grids = D.querySelectorAll(".k-grid");
          lastGridCount = grids.length;
          // Defer width ownership to auto-fit when it is enabled — it sizes columns (widest-word headers) so
          // we must not also write widths. We only keep the wrap CSS live in that case.
          if (autofitOn) { publishMarker(); return; }
          for (var i = 0; i < grids.length; i += 1) {
            var grid = grids[i];
            var cols = measureColumns(grid);
            if (!cols.length) { continue; }
            var base = measureHeaderChrome(grid);
            var targets = computeWrapWidths(cols, { chrome: base.chrome, minWidth: MIN_WIDTH, threshold: SHRINK_THRESHOLD, safetyPad: SAFETY_PAD });
            var applied = applyNarrow(grid, targets);
            if (applied > 0) {
              narrowed += applied;
              lastTargets = targets;
            }
          }
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      function scheduleScan() {
        if (scanTimer) { W.clearTimeout(scanTimer); }
        scanTimer = W.setTimeout(function () { scanTimer = null; scan(); }, 160);
      }

      // Relevance filter: re-scan when grid rows/tables/colgroups churn (a load / re-render) or our style
      // element was removed — not on page-wide SPA churn.
      function isRelevant(muts) {
        try {
          for (var i = 0; i < muts.length; i += 1) {
            var m = muts[i];
            var t = m.target;
            if (t && t.nodeType === 1) {
              var tn = t.nodeName;
              if (tn === "TBODY" || tn === "TR" || tn === "TABLE" || tn === "COLGROUP" || tn === "HEAD") { return true; }
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
            var removed = m.removedNodes;
            if (removed && removed.length) {
              for (var r = 0; r < removed.length && r < 12; r += 1) {
                if (removed[r] && removed[r].id === STYLE_ID) { return true; }
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
        if (scanTimer) { try { W.clearTimeout(scanTimer); } catch (e) { /* ignore */ } scanTimer = null; }
      }

      // Bring the reactive layer up only while wrapping is on; tear it down + restore widths when off.
      function setState(nextWrap, nextAutofit) {
        var wasWrap = wrapOn;
        var wasAutofit = autofitOn;
        wrapOn = nextWrap === true;
        autofitOn = nextAutofit === true;
        if (wrapOn && !wasWrap) {
          try {
            var MO = W.MutationObserver;
            var watchRoot = D.body || D.documentElement;
            if (MO && watchRoot) {
              var obs = new MO(function (muts) { if (isRelevant(muts)) { scheduleScan(); } });
              obs.observe(watchRoot, { childList: true, subtree: true });
              observers.push(obs);
            }
          } catch (e) { /* ignore */ }
          try { var iv = W.setInterval(function () { scan(); }, INTERVAL_MS); timers.push(iv); } catch (e2) { /* ignore */ }
          scheduleScan();
        } else if (!wrapOn && wasWrap) {
          teardownReactive();
          removeWrapStyle();
          restoreWidths();
        } else if (wrapOn) {
          // Still on, but autofit ownership may have flipped: if autofit just turned ON, give back the widths
          // we narrowed so it can size from scratch; if it just turned OFF, take ownership and re-narrow.
          if (autofitOn && !wasAutofit) { restoreWidths(); }
          scheduleScan();
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
              setState(!!(v && v.gridHeaderWrapEnabled === true), !!(v && v.gridAutoSizeEnabled === true));
            } catch (eN) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }
      }

      // 1) Initial state.
      readAndApply();

      // 2) Live reactivity: re-read when our toggle, the auto-fit toggle (ownership), or the host list change.
      try {
        var cc = chromeOf(W);
        if (cc && cc.storage && cc.storage.onChanged && cc.storage.onChanged.addListener) {
          var onChanged = function (changes, area) {
            try {
              if (area !== "local" || !changes) { return; }
              if (changes.gridHeaderWrapEnabled || changes.gridAutoSizeEnabled || changes.customHostPatterns) { readAndApply(); }
            } catch (e) { /* ignore */ }
          };
          cc.storage.onChanged.addListener(onChanged);
          storageListener = { target: cc.storage.onChanged, fn: onChanged };
        }
      } catch (e) { /* ignore */ }

      function uninstall() {
        try {
          teardownReactive();
          removeWrapStyle();
          restoreWidths();
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
        scanNow: function () { scan(); },                  // force a scan (manual / test)
        narrowed: function () { return narrowed; },
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
    CELL_PADDING: CELL_PADDING,
    WORD_FIT_PAD: WORD_FIT_PAD,
    SHRINK_THRESHOLD: SHRINK_THRESHOLD,
    // Pure engine (no DOM) — unit-tested.
    splitWords: splitWords,
    widestWordWidth: widestWordWidth,
    computeWrapWidth: computeWrapWidth,
    computeWrapWidths: computeWrapWidths,
    wrapCss: wrapCss,
    // Pure host helpers — unit-tested.
    normalizeHostPatterns: normalizeHostPatterns,
    patternMatchesHost: patternMatchesHost,
    hostAllowed: hostAllowed,
    install: function (W) { return installRuntime(W || root); }
  };

  root[MARKER_KEY + "_MODULE"] = MODULE;
  if (typeof module !== "undefined" && module.exports) { module.exports = MODULE; }

  // Auto-boot in the page (content-script context). Guarded so importing the module in Node (tests) does not
  // try to touch a DOM. Only boots when a real document is present.
  try {
    if (root && root.document && root.document.documentElement) { installRuntime(root); }
  } catch (e) { /* ignore */ }
})(typeof self !== "undefined" ? self : globalThis);
