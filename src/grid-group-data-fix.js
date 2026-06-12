// grid-group-data-fix.js — text-rewrite fix for the Kinetic "grouping draws an empty grid" defect.
//
// ROOT CAUSE (live-diagnosed 2026-06-11 on Education SaaS950, Customer EQMT1030, main.bd8a10b1401bffd8.js):
//   Newer Kinetic builds render GROUPED grids through a second template branch
//   (`*ngIf="enableGroupingWithNewDirective"`) — a kendo-grid bound via [kendoGridGroupBinding] to the
//   EpGrid component's `groupBindingData` getter:
//     get groupBindingData(){ return this.applyDataFilterToGroupBindingSource(
//       this.model.groupBindingSourceData || this.originalData || this.model.data || []) }
//   `groupBindingSourceData` is populated ONLY by the BAQ-server auto-preload path
//   (shouldAutoPreloadForGrouping requires pagingMode === baqServer). For DataView-bound (epBinding)
//   and REST-server-paged loader grids every term in the chain is undefined/empty, so dragging a
//   column to the group bar swaps in the new branch with data=[] and the grid shows
//   "No records available." (live-proven: kendo-grid element replaced on group, tbody collapses to the
//   k-grid-norecords row, zero network traffic, zero console errors).
//
// THE CURE: rewrite the getter with a LENGTH-AWARE source chain that keeps native behavior whenever a
//   native source is non-empty, and otherwise falls back to where the rows actually live:
//     1. model.groupBindingSourceData   (native — BAQ preload path)
//     2. originalData                   (native)
//     3. model.data                     (native — also set by the REST loader's fetch branch)
//     4. currentViewData                (epBinding grids: the bound DataView's loaded rows)
//     5. model.loader.data              (loader-as-object data)
//     6. gridBindingDirective.loaderResult.data (last loader query result — windowed last resort)
//   Length-aware matters: an EMPTY array is truthy, so the native `||` chain can short-circuit on `[]`
//   and never reach a populated source. Grouping then draws groups over every row the grid has loaded
//   (same client-side semantics Kinetic itself uses after a grouped BAQ preload).
//
// ANCHOR: the full getter text — every token is a preserved property name (terser does not mangle
//   property access), verified EXACTLY once in main.bd8a10b1401bffd8.js. Fail-safe: 0 or >1 matches ->
//   applied:false, source returned unchanged.
//
// MARKER: page-side evidence lands on window.__KINETIC_GRID_FIX__:
//   .groupDataFixVersion (baked at patch time), .groupDataSourceIndex/.groupDataLen (set live whenever
//   the patched getter picks a source).
//
// HYGIENE: explicit semicolons; idempotent via the /*KGFv1:groupData*/ site marker; never throws.

(function (root) {
  "use strict";

  var VERSION = "1.0.0";
  var API_KEY = "__KINETIC_GRID_GROUP_DATA_FIX__";
  var SITE_MARKER = "/*KGFv1:groupData*/";
  var LF = String.fromCharCode(10);

  var ANCHOR = "get groupBindingData(){return this.applyDataFilterToGroupBindingSource(this.model.groupBindingSourceData||this.originalData||this.model.data||[])}";

  // The replacement getter. Single-expression-free body, ES5-safe, every step guarded. The trailing
  // native `||` chain keeps byte-for-byte original semantics when the picker finds nothing.
  var REPLACE = "get groupBindingData(){" + SITE_MARKER
    + "var _kgfD=null;"
    + "try{"
    + "var _kgfS=[this.model.groupBindingSourceData,this.originalData,this.model.data,"
    + "this.epbinding?this.currentViewData:void 0,"
    + "this.model.loader&&this.model.loader.data,"
    + "this.gridBindingDirective&&this.gridBindingDirective.loaderResult&&this.gridBindingDirective.loaderResult.data];"
    + "for(var _kgfI=0;_kgfI<_kgfS.length;_kgfI++){"
    + "if(_kgfS[_kgfI]&&_kgfS[_kgfI].length){"
    + "_kgfD=_kgfS[_kgfI];"
    + "try{var _kgfM=window.__KINETIC_GRID_FIX__=window.__KINETIC_GRID_FIX__||{};"
    + "_kgfM.groupDataSourceIndex=_kgfI;_kgfM.groupDataLen=_kgfD.length;}catch(_kgfE2){}"
    + "break;}}"
    + "}catch(_kgfE){_kgfD=null;}"
    + "return this.applyDataFilterToGroupBindingSource(_kgfD||this.model.groupBindingSourceData||this.originalData||this.model.data||[])}";

  function countOccurrences(hay, needle) {
    if (!needle) {
      return 0;
    }
    var n = 0;
    var i = hay.indexOf(needle);
    while (i !== -1) {
      n += 1;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  }

  function patchBundleText(sourceText, info) {
    try {
      if (typeof sourceText !== "string" || sourceText.length === 0) {
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }
      // Per-site idempotency: a prior pass already rewrote the getter.
      if (sourceText.indexOf(SITE_MARKER) >= 0) {
        return { patched: sourceText, applied: true, anchorsHit: ["already-patched"], mode: "text" };
      }
      // Fail-safe + precise: rewrite only when the anchor occurs EXACTLY once.
      if (countOccurrences(sourceText, ANCHOR) !== 1) {
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }

      var out = sourceText.replace(ANCHOR, REPLACE);
      // Patch-time marker so verification can distinguish "fix delivered" from "fix never fired".
      var tail = ";try{window.__KINETIC_GRID_FIX__=window.__KINETIC_GRID_FIX__||{};"
        + "window.__KINETIC_GRID_FIX__.groupDataFixVersion=" + JSON.stringify(VERSION) + ";}catch(_kgfgd){}";
      return { patched: out + LF + tail + LF, applied: true, anchorsHit: ["group-binding-data"], mode: "text" };
    } catch (error) {
      return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
    }
  }

  root[API_KEY] = {
    version: VERSION,
    ANCHOR: ANCHOR,
    REPLACE: REPLACE,
    SITE_MARKER: SITE_MARKER,
    patchBundleText: patchBundleText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root[API_KEY];
  }
})(typeof self !== "undefined" ? self : globalThis);
