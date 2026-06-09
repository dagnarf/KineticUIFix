// grid-checkbox-style-fix.js — standardizes the PRESENTATION of Kinetic boolean grid-cell checkbox
// glyphs so they render identically before and after a group/ungroup re-render.
//
// SYMPTOM (reported 2026-06-04, confirmed visual class on JCGO3033 / SaaS950 Education): Kinetic
//   boolean columns (To Firm, Firm, Locked, Mass Print, Engineered, Released, ...) do NOT render as
//   <input type=checkbox>; each is a Material Design Icon FONT GLYPH:
//     <span data-erpeditor="boolean"><span class="ep-grid-cell-check mdi mdi-checkbox-{blank,marked}-outline"></span></span>
//   sized + positioned purely by CSS (font-size on the span, drawn via ::before). After a multi-field
//   group -> ungroup the grid re-materializes its rows during the render-all window; some re-rendered
//   glyph cells come back with DRIFTED presentation — different font-size, mis-alignment, or color —
//   so the column's checkboxes look inconsistent ("shown differently") even though every value is
//   still a correct glyph. The canonical (healthy) presentation, captured live, is uniform:
//     font-size:24px; line-height:12px; display:flex; justify-content:center; align-items:center; color:#000.
//
// CURE: inject ONE scoped stylesheet that pins the boolean glyph's SIZE + ALIGNMENT (and the ENABLED
//   cell color) to the column's own canonical presentation, appended last in <head> with !important so
//   it wins the cascade against whatever class a drifted cell lost/gained. It is:
//     - ADAPTIVE / theme-safe: the canonical values are SAMPLED from the majority of currently-rendered
//       glyphs (modal font-size/line-height/justify/align/color), not hardcoded — so a compact-density
//       or re-themed grid pins to ITS own healthy values. Captured defaults are only the bootstrap
//       fallback used before any glyph exists (document_start).
//     - DISABLED-STATE-PRESERVING: color is pinned ONLY for cells outside .ep-row-rule-disabled, so the
//       value-driven greying of disabled booleans is never overridden.
//     - a VISUAL NO-OP on healthy grids: on a consistent grid the pin equals the existing values, so
//       nothing moves; it only takes visible effect on a cell that actually drifted.
//     - PREVENTIVE: injected CSS applies to every matching glyph the instant it enters the DOM, so a
//       re-rendered cell can never display drifted before being corrected.
//
// DELIVERY (mechanism-agnostic, mirrors src/grid-blank-fix.js): M1 (debugger) appends this watchdog's
//   self-installing source to the patched bundle; M2 (runtime) installs it at document_start. When armed
//   the shared marker carries checkboxStyleFixArmed:true + checkboxCanonical + checkboxStyleReasserts.
//
// HYGIENE: explicit semicolons; idempotent (per-window marker + single styled
//   element id); fail-safe (never throws into the page); observers/timers registered for teardown. The
//   fix is ONE fully self-contained function so its .toString() embeds verbatim for M1 (no outer refs).

(function (root) {
  "use strict";
  var VERSION = "1.0.0";
  var API_KEY = "__KINETIC_GRID_CHECKBOX_FIX__";

  // Fully self-contained standardizer. install with (W). Returns the api or null. Idempotent.
  function __kineticGridCheckboxStyleFix(W) {
    try {
      if (!W || typeof W !== "object" || !W.document) { return null; }
      var SELF_KEY = "__KINETIC_GRID_CHECKBOX_FIX__";
      var MARKER_KEY = "__KINETIC_GRID_FIX__";
      var STYLE_ID = "kinetic-grid-checkbox-fix-style";
      var FIX_VERSION = "1.0.0";
      if (W[SELF_KEY] && W[SELF_KEY].__installed === true) { return W[SELF_KEY]; }
      var D = W.document;
      var GLYPH = ".ep-grid-cell-check.mdi";          // the Kinetic boolean glyph span
      var DISABLED = ".ep-row-rule-disabled";          // value-driven greyed wrapper — never recolor it
      var INTERVAL_MS = 1500;                          // safety re-assert period
      // Canonical Kinetic boolean-glyph presentation (captured live JCGO3033 2026-06-04). Only the
      // bootstrap fallback when no healthy glyph exists yet to sample from.
      var DEFAULTS = { fontSize: "24px", lineHeight: "12px", display: "flex", justify: "center", align: "center", color: "rgb(0, 0, 0)" };

      function modal(values) {
        var counts = {}, best = null, bestN = 0;
        for (var i = 0; i < values.length; i += 1) {
          var v = values[i];
          if (!v) { continue; }
          counts[v] = (counts[v] || 0) + 1;
          if (counts[v] > bestN) { bestN = counts[v]; best = v; }
        }
        return best;
      }

      // Derive the canonical presentation from the MAJORITY of currently-rendered glyphs (so it is
      // theme/density-correct), falling back to the captured defaults. Color is sampled from ENABLED
      // cells only. Read with our own style temporarily absent so we measure Kinetic's real cascade.
      function deriveCanonical() {
        var c = { fontSize: DEFAULTS.fontSize, lineHeight: DEFAULTS.lineHeight, display: DEFAULTS.display, justify: DEFAULTS.justify, align: DEFAULTS.align, color: DEFAULTS.color, sampled: false, glyphs: 0 };
        try {
          var glyphs = D.querySelectorAll(".k-grid " + GLYPH);
          if (!glyphs.length) { glyphs = D.querySelectorAll(GLYPH); }
          c.glyphs = glyphs.length;
          if (!glyphs.length) { return c; }
          var fs = [], lh = [], dp = [], jc = [], ai = [], col = [];
          var cap = Math.min(glyphs.length, 200);
          for (var i = 0; i < cap; i += 1) {
            var g = glyphs[i];
            var cs = W.getComputedStyle(g);
            fs.push(cs.fontSize); lh.push(cs.lineHeight); dp.push(cs.display); jc.push(cs.justifyContent); ai.push(cs.alignItems);
            var disabledHost = g.closest ? g.closest(DISABLED) : null;
            if (!disabledHost) { col.push(cs.color); }
          }
          c.fontSize = modal(fs) || c.fontSize;
          c.lineHeight = modal(lh) || c.lineHeight;
          c.display = modal(dp) || c.display;
          c.justify = modal(jc) || c.justify;
          c.align = modal(ai) || c.align;
          c.color = modal(col) || c.color;
          // getComputedStyle reports flex's default main-axis alignment as "normal"; normalize it to a
          // CSS-valid value so our injected rule is well-formed.
          if (c.justify === "normal") { c.justify = "flex-start"; }
          if (c.align === "normal") { c.align = "stretch"; }
          if (c.display !== "flex" && c.display !== "inline-flex") { c.display = "flex"; }
          c.sampled = true;
        } catch (e) { /* fall back to defaults */ }
        return c;
      }

      function cssText(c) {
        // Pin SIZE + ALIGNMENT for every boolean glyph (and its ::before icon), and COLOR only for
        // ENABLED cells. Scoped to the Kinetic check glyph; appended last in <head> so the !important
        // rules win source-order ties against any drifted class.
        var box = "font-size:" + c.fontSize + " !important;"
          + "line-height:" + c.lineHeight + " !important;"
          + "display:" + c.display + " !important;"
          + "justify-content:" + c.justify + " !important;"
          + "align-items:" + c.align + " !important;";
        return GLYPH + "{" + box + "}"
          + GLYPH + "::before{font-size:inherit !important;line-height:inherit !important;}"
          + ".ep-grid-cell:not(" + DISABLED + ") " + GLYPH + "{color:" + c.color + " !important;}";
      }

      var state = { __installed: true, observers: [], timers: [], reasserts: 0, canonical: null, debounce: null };

      function publishMarker() {
        try {
          var m = W[MARKER_KEY] || {};
          m.checkboxStyleFixVersion = FIX_VERSION;
          m.checkboxStyleFixArmed = true;
          m.checkboxCanonical = state.canonical;
          m.checkboxStyleReasserts = state.reasserts;
          W[MARKER_KEY] = m;
        } catch (e) { /* ignore */ }
      }

      function ensureStyle(c) {
        try {
          var head = D.head || (D.getElementsByTagName("head")[0]) || D.documentElement;
          if (!head) { return false; }
          var el = D.getElementById(STYLE_ID);
          if (!el) {
            el = D.createElement("style");
            el.id = STYLE_ID;
            el.setAttribute("data-kinetic-grid-fix", "checkbox-style");
            state.reasserts += 1;
          }
          var text = cssText(c);
          if (el.textContent !== text) { el.textContent = text; }
          // Keep it LAST in <head> so its !important rules win source-order ties over later Kinetic CSS.
          if (el.parentNode !== head || head.lastChild !== el) { head.appendChild(el); }
          return true;
        } catch (e) { return false; }
      }

      function apply(rederive) {
        try {
          if (rederive || !state.canonical) {
            // Remove our pin first so deriveCanonical measures Kinetic's own (un-pinned) cascade and
            // can pick up a real theme/density change rather than echoing our previous pin.
            var prev = D.getElementById(STYLE_ID);
            if (prev && prev.parentNode) { prev.parentNode.removeChild(prev); }
            state.canonical = deriveCanonical();
          }
          ensureStyle(state.canonical);
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      // Measure how many currently-rendered glyphs deviate from the canonical presentation. Used by
      // tests + field diagnostics; with the pin active this reports 0 (the pin prevents drift).
      function diagnose() {
        var out = { glyphs: 0, deviations: 0, byProp: { fontSize: 0, lineHeight: 0, justify: 0, align: 0, color: 0 }, canonical: state.canonical };
        try {
          var c = state.canonical || DEFAULTS;
          var glyphs = D.querySelectorAll(".k-grid " + GLYPH);
          if (!glyphs.length) { glyphs = D.querySelectorAll(GLYPH); }
          out.glyphs = glyphs.length;
          var cap = Math.min(glyphs.length, 400);
          for (var i = 0; i < cap; i += 1) {
            var g = glyphs[i];
            var cs = W.getComputedStyle(g);
            var bad = false;
            if (cs.fontSize !== c.fontSize) { out.byProp.fontSize += 1; bad = true; }
            if (cs.lineHeight !== c.lineHeight) { out.byProp.lineHeight += 1; bad = true; }
            if (cs.justifyContent !== c.justify && !(cs.justifyContent === "normal" && c.justify === "flex-start")) { out.byProp.justify += 1; bad = true; }
            if (cs.alignItems !== c.align && !(cs.alignItems === "normal" && c.align === "stretch")) { out.byProp.align += 1; bad = true; }
            var disabledHost = g.closest ? g.closest(DISABLED) : null;
            if (!disabledHost && cs.color !== c.color) { out.byProp.color += 1; bad = true; }
            if (bad) { out.deviations += 1; }
          }
        } catch (e) { /* ignore */ }
        return out;
      }

      // Cheap relevance filter: only re-assert when a mutation touches grid rows/tables or our own
      // styled element was removed — not on page-wide churn.
      function isRelevant(muts) {
        try {
          for (var i = 0; i < muts.length; i += 1) {
            var m = muts[i];
            var t = m.target;
            if (t && t.nodeType === 1) {
              var tn = t.nodeName;
              if (tn === "TBODY" || tn === "TR" || tn === "TABLE" || tn === "TD" || tn === "HEAD") { return true; }
              var cls = String(t.className || "");
              if (cls.indexOf("k-grid") >= 0 || cls.indexOf("k-table") >= 0 || cls.indexOf("ep-grid") >= 0) { return true; }
            }
            var added = m.addedNodes;
            if (added && added.length) {
              for (var j = 0; j < added.length && j < 12; j += 1) {
                var nn = added[j] && added[j].nodeName;
                if (nn === "TR" || nn === "TABLE" || nn === "TBODY" || nn === "KENDO-GRID") { return true; }
                var ac = added[j] && added[j].className ? String(added[j].className) : "";
                if (ac.indexOf("k-grid") >= 0 || ac.indexOf("ep-grid") >= 0) { return true; }
              }
            }
            // Our own style element removed -> re-assert.
            var removed = m.removedNodes;
            if (removed && removed.length) {
              for (var r = 0; r < removed.length && r < 12; r += 1) {
                if (removed[r] && removed[r].id === STYLE_ID) { return true; }
              }
            }
          }
        } catch (e) { return true; } // on any doubt, allow the re-assert
        return false;
      }

      function scheduleApply() {
        if (state.debounce) { W.clearTimeout(state.debounce); }
        state.debounce = W.setTimeout(function () {
          // Auto-refine: if we bootstrapped from defaults (no glyphs at document_start) and glyphs now
          // exist, re-derive ONCE to capture the real theme canonical; thereafter just re-assert.
          var rederive = !!(state.canonical && state.canonical.sampled === false && D.querySelector(GLYPH));
          apply(rederive);
        }, 120);
      }

      // 1) Observe grid/head mutations (rows re-render after a group/ungroup; SPA re-mount may strip the
      //    head style) -> filtered, debounced re-assert.
      var MO = W.MutationObserver;
      if (MO && (D.body || D.documentElement)) {
        try {
          var obs = new MO(function (muts) { if (isRelevant(muts)) { scheduleApply(); } });
          obs.observe(D.body || D.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
          state.observers.push(obs);
        } catch (eObs) { /* ignore */ }
      }
      // 2) Low-frequency safety re-assert (covers no-mutation cases + late theme load).
      var iv = W.setInterval(function () {
        var rederive = !!(state.canonical && state.canonical.sampled === false && D.querySelector(GLYPH));
        apply(rederive);
      }, INTERVAL_MS);
      state.timers.push(iv);
      // 3) Initial install: derive canonical (no pin present yet) + inject.
      apply(true);

      function uninstall() {
        try {
          for (var i = 0; i < state.observers.length; i += 1) { try { state.observers[i].disconnect(); } catch (e) {} }
          for (var j = 0; j < state.timers.length; j += 1) { try { W.clearInterval(state.timers[j]); W.clearTimeout(state.timers[j]); } catch (e) {} }
          if (state.debounce) { W.clearTimeout(state.debounce); }
          var el = D.getElementById(STYLE_ID);
          if (el && el.parentNode) { el.parentNode.removeChild(el); }
          state.__installed = false;
          if (W[SELF_KEY] === api) { try { delete W[SELF_KEY]; } catch (eD) { W[SELF_KEY] = null; } }
        } catch (e) { /* ignore */ }
      }

      var api = {
        version: FIX_VERSION,
        __installed: true,
        check: function () { apply(true); return state.canonical; },
        canonical: function () { return state.canonical; },
        diagnose: diagnose,
        reasserts: function () { return state.reasserts; },
        uninstall: uninstall
      };
      W[SELF_KEY] = api;
      return api;
    } catch (e) { return null; }
  }

  var STYLE_SOURCE = Function.prototype.toString.call(__kineticGridCheckboxStyleFix);

  root[API_KEY + "_MODULE"] = {
    version: VERSION,
    fix: __kineticGridCheckboxStyleFix,
    STYLE_SOURCE: STYLE_SOURCE,
    install: function (W) { return __kineticGridCheckboxStyleFix(W || root); }
  };

  if (typeof module !== "undefined" && module.exports) { module.exports = root[API_KEY + "_MODULE"]; }
})(typeof self !== "undefined" ? self : globalThis);
