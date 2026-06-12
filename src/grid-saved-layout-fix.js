// grid-saved-layout-fix.js — text-rewrite fix for the Kinetic "saved layout kills dynamic grids" defect.
//
// ROOT CAUSE (live-diagnosed 2026-06-11 on Education SaaS950, SQL On The Fly SQLONFLY,
//   main.bd8a10b1401bffd8.js): EpGrid's initFromSavedLayout(s, p) restores a user's saved grid layout
//   `p` onto grid state `s` through a comma-expression chain where only the FIRST operand guards
//   s.panelCardGrid:
//     p&&(s.panelCardGrid&&(s.panelCardGrid.expandedFilter=...),
//         p.filteringMode&&(s.panelCardGrid.model.filteringMode=p.filteringMode),   // UNGUARDED deref
//         void 0!==p.state)&&(...)
//   Grids that have NO panelCardGrid — dashboard-style dynamic grids such as SQL On The Fly's Output
//   grid, whose columns are rebuilt per query — throw `TypeError: Cannot read properties of undefined
//   (reading 'model')` during init whenever the user has ANY saved layout carrying `filteringMode`.
//   Angular cancels the component; the grid is removed from the DOM and never re-renders (live-proven:
//   Submit ran the query, diagnostics reached [Executing...], the Output panel collapsed to its 42px
//   header with zero grids on the page; identical with the extension fully disabled, so the defect is
//   stock Kinetic triggered by persisted per-user layout data).
//
// THE CURE: insert the missing guard so the filteringMode restore is skipped (exactly what the adjacent
//   expandedFilter operand already does) instead of killing the whole grid.
//
// ANCHOR: a REGEX over the unmangled property names (.filteringMode / .panelCardGrid.model) with
//   back-referenced minified locals, because unlike grid-group-data-fix's `this.`-form anchor the
//   locals (`s`, `p` today) are free to change names across builds. Fail-safe: 0 or >1 matches ->
//   applied:false, source returned unchanged.
//
// MARKER: window.__KINETIC_GRID_FIX__.savedLayoutFixVersion (baked at patch time).
//
// HYGIENE: explicit semicolons; idempotent via the /*KGFv1:savedLayout*/ site marker; never throws;
//   the replacement stays a single comma-operand expression so the surrounding && chain semantics
//   (which only consume the LAST operand, `void 0!==p.state`) are untouched.

(function (root) {
  "use strict";

  var VERSION = "1.0.0";
  var API_KEY = "__KINETIC_GRID_SAVED_LAYOUT_FIX__";
  var SITE_MARKER = "/*KGFv1:savedLayout*/";
  var LF = String.fromCharCode(10);

  // p.filteringMode&&(s.panelCardGrid.model.filteringMode=p.filteringMode)
  // group 1 = the saved-layout local, group 2 = the grid-state local.
  var ANCHOR_RE = /([A-Za-z_$][\w$]*)\.filteringMode&&\(([A-Za-z_$][\w$]*)\.panelCardGrid\.model\.filteringMode=\1\.filteringMode\)/g;

  function buildReplacement(layoutVar, stateVar) {
    return layoutVar + ".filteringMode&&" + stateVar + ".panelCardGrid&&" + stateVar + ".panelCardGrid.model&&"
      + SITE_MARKER + "(" + stateVar + ".panelCardGrid.model.filteringMode=" + layoutVar + ".filteringMode)";
  }

  function patchBundleText(sourceText, info) {
    try {
      if (typeof sourceText !== "string" || sourceText.length === 0) {
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }
      // Per-site idempotency: a prior pass already rewrote the restore.
      if (sourceText.indexOf(SITE_MARKER) >= 0) {
        return { patched: sourceText, applied: true, anchorsHit: ["already-patched"], mode: "text" };
      }
      // Fail-safe + precise: rewrite only when the anchor occurs EXACTLY once.
      ANCHOR_RE.lastIndex = 0;
      var matches = [];
      var m;
      while ((m = ANCHOR_RE.exec(sourceText)) !== null) {
        matches.push(m);
        if (matches.length > 1) {
          break;
        }
      }
      if (matches.length !== 1) {
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }

      var hit = matches[0];
      var out = sourceText.slice(0, hit.index)
        + buildReplacement(hit[1], hit[2])
        + sourceText.slice(hit.index + hit[0].length);
      // Patch-time marker so verification can distinguish "fix delivered" from "fix never fired".
      var tail = ";try{window.__KINETIC_GRID_FIX__=window.__KINETIC_GRID_FIX__||{};"
        + "window.__KINETIC_GRID_FIX__.savedLayoutFixVersion=" + JSON.stringify(VERSION) + ";}catch(_kgsl){}";
      return { patched: out + LF + tail + LF, applied: true, anchorsHit: ["saved-layout-filtering-mode"], mode: "text" };
    } catch (error) {
      return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
    }
  }

  root[API_KEY] = {
    version: VERSION,
    ANCHOR_RE: ANCHOR_RE,
    SITE_MARKER: SITE_MARKER,
    buildReplacement: buildReplacement,
    patchBundleText: patchBundleText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root[API_KEY];
  }
})(typeof self !== "undefined" ? self : globalThis);
