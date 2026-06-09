// patch-transform.js — mechanism-agnostic fix transform for the Kinetic
// Kendo-Angular grid group/ungroup virtualization-defeat leak.
//
// CONTRACT (plans/chrome_plugin_grid_fix/00_shared_context.md §1):
//   patchBundleText(sourceText, info)  -> { patched: string, applied: boolean, anchorsHit: string[], mode: "text" }
//   installRuntimePatch(window)        -> { applied: boolean, mode: "runtime", anchorsHit: string[] }
//   info = { url, bundleHash }. Both are IDEMPOTENT and FAIL-SAFE: if no anchor matches ->
//   applied:false, source returned unchanged, never throws into the page/pipeline.
//   When applied, the page exposes the §3 marker window.__KINETIC_GRID_FIX__ =
//     { version, enabled:true, applied:true, mode:"text"|"runtime", bundleHash, anchorsHit }.
//
// ROOT CAUSE (carried from .archivedplans/2026-06-03_grid-grouping-leak/ +
//   .output/grid-grouping-leak/hook-menu.md): on full ungroup, Kinetic's
//   adjustVirtualScrolling() restore branch is GUARDED:
//     GUARD A: this.originalPageSize && !this.grid.model.isPageSizeCalculated && ... (pageSize)
//     GUARD B: this.originalRowHeight && (this.grid.model.rowHeight = this.originalRowHeight)
//   originalRowHeight is commonly captured undefined (before first render), so GUARD B skips and
//   model.rowHeight stays undefined. Kendo's virtual content directive then (re)builds
//   rowHeightService = new <i9e>(total, rowHeight, ...) with rowHeight===undefined -> NaN offset
//   table -> the virtual window degenerates to "render every row" (4,466 rows -> ~470k DOM nodes
//   / ~2.2 GB).
//
// THE CURE (v2 — three sites; the third is the load-bearing one):
//   GUARD A -> drop the !isPageSizeCalculated guard so pageSize always restores when an
//              originalPageSize is known.
//   GUARD B -> always set model.rowHeight to a positive number
//              (originalRowHeight || current model.rowHeight || a sane 24px default).
//   ROWHEIGHTSVC -> coerce rowHeight to a positive default AT the Kendo virtual-content directive's
//              rowHeightService construction: `this.rowHeightService = new <X>(this.total,
//              this.rowHeight, this.detailRowHeight)` -> `(this.total, this.rowHeight||24, ...)`.
//
//   WHY v1 (GUARD A/B alone) FAILED LIVE (Track D 2026-06-03, verification-report.md): the model
//   restore runs inside a setTimeout (onGroupChange -> setTimeout(adjustVirtualScrolling)), but the
//   Kendo directive's init() — the ONLY path that rebuilds rowHeightService — re-runs on the
//   ungroup `total`/`take` change BEFORE that setTimeout fires, reading the still-`undefined`
//   this.rowHeight and building a NaN offset table -> render-all (4,466 rows). Setting model.rowHeight
//   afterwards does not re-run init(). So the restore is necessary-but-insufficient; the offset table
//   must be fixed AT the construction site. Coercing `this.rowHeight||24` there guarantees a finite
//   offset table (totalHeight 4466*24 = 107,184px, matching the live scrollH) whenever init() runs,
//   regardless of restore timing. `||24` is a no-op when rowHeight is already a valid positive px
//   (Kendo itself REQUIRES a positive rowHeight for virtual scrolling), so it is safe in every state.
//
// ANCHORS (verified present EXACTLY ONCE in BOTH main.437c1f00e1f99d77.js and the current live
//   main.a25a40629ba315f8.js; see .output/chrome-plugin-grid-fix/anchors.md). They are stable
//   because every token is a preserved PROPERTY name (grid/model/rowHeight/pageSize/
//   originalRowHeight/originalPageSize/isPageSizeCalculated/epGridComponent/settings) — terser
//   does not mangle property access. We anchor on these patterns, NEVER on the bundle hash or a
//   byte offset (the bundle has already rolled 437c1f00 -> a25a4062).
//
// HYGIENE: explicit semicolons; idempotent via the §3
//   marker + per-site marker comments; fail-safe (every step wrapped, never throws); the runtime
//   form registers all wraps/timers for teardown.

(function(root){
  "use strict";

  var VERSION = "1.0.0";
  var API_KEY = "__KINETIC_GRID_FIX_TRANSFORM__";
  var MARKER_KEY = "__KINETIC_GRID_FIX__";
  var LF = String.fromCharCode(10);
  var RUNTIME_STATE_KEY = "__KINETIC_GRID_FIX_RUNTIME_STATE__";
  var RUNTIME_RESULT_KEY = "__KINETIC_GRID_FIX_RUNTIME_RESULT__";
  var PUSH_MARKER_KEY = "__KINETIC_GRID_FIX_PUSH_WRAPPED__";
  var METHOD_MARKER_KEY = "__KINETIC_GRID_FIX_METHOD_WRAPPED__";

  // Per-site idempotency + provenance markers injected at each rewrite location. Plain block
  // comments, harmless and parseable inside the expression neighbourhood.
  var MARKER_PAGESIZE = "/*KGFv1:pageSize*/";
  var MARKER_ROWHEIGHT = "/*KGFv1:rowHeight*/";
  var MARKER_ROWHEIGHTSVC = "/*KGFv2:rhsvc*/";
  var DEFAULT_ROW_PX = 24;
  // Windowed page-size fallback. The client loader uses `model.pageSize || 1e4`, so a missing
  // pageSize after ungroup makes take=10000 -> all rows bind -> render-all (the real driver,
  // confirmed live: height-container is correct but tbody renders the full dataset). When neither
  // originalPageSize nor a current pageSize is known we force a bounded window instead of 1e4.
  var DEFAULT_PAGE_SIZE = 100;

  // Each anchor: a stable `find` string (must occur EXACTLY once), the `replace` text (carries a
  // marker so it is self-identifying), and the `name` surfaced in anchorsHit. `replace` ends
  // WITHOUT a trailing comma so the original following code continues unchanged:
  //   after A: ",this.originalRowHeight&&..."
  //   after B: ",null===(x=this.grid.epGridComponent)||void 0===x||x.calculateModelRowHeight()"
  var ANCHORS = [
    {
      name: "pageSizeRestore",
      marker: MARKER_PAGESIZE,
      find: "this.originalPageSize&&!this.grid.model.isPageSizeCalculated&&this.grid.epGridComponent&&(this.grid.model.pageSize=this.grid.epGridComponent.settings.pageSize=this.originalPageSize)",
      replace: MARKER_PAGESIZE + "this.grid.epGridComponent&&(this.grid.model.pageSize=this.grid.epGridComponent.settings.pageSize=this.originalPageSize||this.grid.model.pageSize||" + DEFAULT_PAGE_SIZE + ")"
    },
    {
      name: "rowHeightRestore",
      marker: MARKER_ROWHEIGHT,
      find: "this.originalRowHeight&&(this.grid.model.rowHeight=this.originalRowHeight)",
      replace: MARKER_ROWHEIGHT + "(this.grid.model.rowHeight=this.originalRowHeight||this.grid.model.rowHeight||" + DEFAULT_ROW_PX + ")"
    },
    {
      // The load-bearing fix: coerce rowHeight to a positive default at the Kendo virtual-content
      // directive's rowHeightService construction, so the offset table is never NaN even when the
      // model restore lands too late (see THE CURE v2 note above). The minified constructor class
      // name (e.g. i9e) drifts across bundles, so we anchor on the stable arg-list only.
      name: "rowHeightServiceRebuild",
      marker: MARKER_ROWHEIGHTSVC,
      find: "(this.total,this.rowHeight,this.detailRowHeight)",
      replace: "(this.total,this.rowHeight||" + MARKER_ROWHEIGHTSVC + DEFAULT_ROW_PX + ",this.detailRowHeight)"
    }
  ];

  // ---- shared helpers -------------------------------------------------------

  function bundleHashFromUrl(url){
    if (!url || typeof url !== "string"){
      return null;
    }

    var pathEnd = url.indexOf("?");
    var path = pathEnd >= 0 ? url.slice(0, pathEnd) : url;
    var hashEnd = path.indexOf("#");
    if (hashEnd >= 0){
      path = path.slice(0, hashEnd);
    }

    var slash = path.lastIndexOf("/");
    var fileName = slash >= 0 ? path.slice(slash + 1) : path;
    var lower = fileName.toLowerCase();
    if (lower.indexOf("main.") !== 0 || lower.lastIndexOf(".js") !== lower.length - 3){
      return null;
    }

    var middle = fileName.slice(5, fileName.length - 3);
    return middle || null;
  }

  function markerPayload(info, mode, anchorsHit){
    var sourceInfo = info || {};
    return {
      version: VERSION,
      enabled: true,
      applied: true,
      mode: mode,
      bundleHash: sourceInfo.bundleHash || bundleHashFromUrl(sourceInfo.url) || null,
      anchorsHit: Array.isArray(anchorsHit) ? anchorsHit.slice(0, 12) : []
    };
  }

  function markerSnippet(info, mode, anchorsHit){
    return ";window." + MARKER_KEY + "=" + JSON.stringify(markerPayload(info, mode, anchorsHit)) + ";";
  }

  // Count non-overlapping occurrences of `needle` in `hay`.
  function countOccurrences(hay, needle){
    if (!needle){
      return 0;
    }
    var n = 0;
    var i = hay.indexOf(needle);
    while (i !== -1){
      n += 1;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  }

  // ---- patchBundleText (text/byte rewrite — mechanism M1/M3 primary) --------

  function patchBundleText(sourceText, info){
    try {
      if (typeof sourceText !== "string" || sourceText.length === 0){
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }

      // Idempotent: a prior pass already injected the page marker -> no-op.
      if (sourceText.indexOf(MARKER_KEY) >= 0){
        return { patched: sourceText, applied: true, anchorsHit: ["already-marked"], mode: "text" };
      }

      var out = sourceText;
      var hits = [];

      for (var k = 0; k < ANCHORS.length; k += 1){
        var anchor = ANCHORS[k];

        // Per-site idempotency (marker comment already present at this site).
        if (out.indexOf(anchor.marker) >= 0){
          hits.push(anchor.name);
          continue;
        }

        // Fail-safe + precise: only rewrite when the anchor occurs EXACTLY once.
        // 0 -> site absent (skip); >1 -> ambiguous, refuse to touch it.
        if (countOccurrences(out, anchor.find) !== 1){
          continue;
        }

        out = out.replace(anchor.find, anchor.replace);
        hits.push(anchor.name);
      }

      if (hits.length === 0){
        // No cure applied: leave the bundle untouched (Track A's background then serves the
        // original unmodified, so the page exposes no marker — proving honest inertness).
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }

      // Append the §3 page marker so Track D can verify the patch is live.
      var patched = out + LF + markerSnippet(info, "text", hits) + LF;
      return { patched: patched, applied: true, anchorsHit: hits, mode: "text" };
    } catch (error) {
      return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
    }
  }

  // ---- installRuntimePatch (runtime hook — mechanism M2 fallback) -----------
  //
  // At document_start MAIN world the grid-provider class is not defined yet and (per the
  // predecessor's reachability finding) the live instance is unreachable from a post-load eval.
  // So we trap the webpack chunk registration (webpackChunk*.push), and when a registering
  // module's factory source carries the guarded-restore signature, we wrap the factory so that
  // AFTER it runs we locate the class that owns `adjustVirtualScrolling` and wrap that method to
  // apply the SAME cure (unconditional rowHeight/pageSize restore) right after the original
  // guarded restore — synchronously, before the virtual directive re-inits. Idempotent
  // (method/Symbol marker), fail-safe (never throws), and every wrap/timer is registered for
  // teardown via window.__KINETIC_GRID_FIX_RUNTIME_STATE__.cleanup.

  function functionText(value){
    try {
      return Function.prototype.toString.call(value);
    } catch (error) {
      return "";
    }
  }

  // Apply the unconditional restore right after the original adjustVirtualScrolling() ran.
  function applyCureAfterRestore(self){
    try {
      // Only act on the ungrouped restore path.
      if (typeof self.hasGroups === "function" && self.hasGroups()){
        return;
      }
      var grid = self.grid;
      if (!grid || !grid.model){
        return;
      }
      var model = grid.model;
      var comp = grid.epGridComponent;

      // GUARD B cure: ensure a positive rowHeight so the rowHeightService offset table is finite.
      if (!model.rowHeight){
        model.rowHeight = self.originalRowHeight || model.rowHeight || DEFAULT_ROW_PX;
      }
      // GUARD A cure: restore pageSize regardless of isPageSizeCalculated when we know an original.
      if (self.originalPageSize && comp && comp.settings && !model.pageSize){
        model.pageSize = self.originalPageSize;
        comp.settings.pageSize = self.originalPageSize;
      }
      // Late refinement (mirrors the bundle's own trailing call).
      if (comp && typeof comp.calculateModelRowHeight === "function"){
        comp.calculateModelRowHeight();
      }
    } catch (error) {
      /* never throw into the page */
    }
  }

  // Wrap adjustVirtualScrolling on a prototype with the cure. Returns true once installed.
  function wrapProviderPrototype(proto, state){
    try {
      if (!proto || typeof proto.adjustVirtualScrolling !== "function"){
        return false;
      }
      if (proto[METHOD_MARKER_KEY]){
        return true; // idempotent: already wrapped.
      }
      var original = proto.adjustVirtualScrolling;
      proto.adjustVirtualScrolling = function(){
        var result = original.apply(this, arguments);
        applyCureAfterRestore(this);
        return result;
      };
      try {
        Object.defineProperty(proto, METHOD_MARKER_KEY, { value: true, configurable: true });
      } catch (error) {
        proto[METHOD_MARKER_KEY] = true;
      }
      state.cleanup.push(function(){
        try {
          proto.adjustVirtualScrolling = original;
          delete proto[METHOD_MARKER_KEY];
        } catch (error) {
          /* ignore */
        }
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  // Scan a freshly-evaluated module's exports for the class that owns adjustVirtualScrolling.
  function cureModuleExports(moduleExports, state){
    var installed = false;
    try {
      if (!moduleExports || (typeof moduleExports !== "object" && typeof moduleExports !== "function")){
        return false;
      }
      var keys = [];
      try {
        keys = Object.keys(moduleExports);
      } catch (error) {
        keys = [];
      }
      for (var i = 0; i < keys.length && i < 128; i += 1){
        var candidate = moduleExports[keys[i]];
        if (typeof candidate === "function" && candidate.prototype){
          if (wrapProviderPrototype(candidate.prototype, state)){
            installed = true;
          }
        }
      }
    } catch (error) {
      /* ignore */
    }
    return installed;
  }

  function installRuntimePatch(W){
    try {
      if (!W || typeof W !== "object"){
        return { applied: false, mode: "runtime", anchorsHit: [] };
      }

      if (W[RUNTIME_STATE_KEY]){
        return {
          applied: !!W[RUNTIME_STATE_KEY].applied,
          mode: "runtime",
          anchorsHit: W[RUNTIME_STATE_KEY].anchorsHit.slice(0, 12)
        };
      }

      var state = {
        applied: false,
        anchorsHit: [],
        cleanup: [],
        scans: 0,
        maxScans: 800
      };
      W[RUNTIME_STATE_KEY] = state;

      function mark(anchor){
        if (state.anchorsHit.indexOf(anchor) < 0){
          state.anchorsHit.push(anchor);
        }
        // Refresh the page marker on every mark so later anchors (e.g. the prototype wrap that
        // fires when the module evaluates, after the initial factory-trap) are reflected.
        state.applied = true;
        W[MARKER_KEY] = markerPayload({ bundleHash: null }, "runtime", state.anchorsHit);
        W[RUNTIME_RESULT_KEY] = { applied: true, mode: "runtime", anchorsHit: state.anchorsHit.slice(0, 12) };
      }

      // Wrap a webpack module factory so we can cure its exports after evaluation.
      function wrapFactory(container, moduleId){
        var original = container[moduleId];
        if (typeof original !== "function" || original[METHOD_MARKER_KEY]){
          return;
        }
        var text = functionText(original);
        // Only wrap the factory that actually carries the guarded-restore signature — keeps the
        // overhead off the thousands of unrelated module factories.
        if (text.indexOf("adjustVirtualScrolling") < 0 || text.indexOf("originalRowHeight") < 0){
          return;
        }
        var wrapped = function(module){
          var r = original.apply(this, arguments);
          try {
            var exp = module && module.exports;
            if (cureModuleExports(exp, state)){
              mark("provider-prototype-wrap");
            }
          } catch (error) {
            /* ignore */
          }
          return r;
        };
        try {
          Object.defineProperty(wrapped, METHOD_MARKER_KEY, { value: true, configurable: true });
        } catch (error) {
          wrapped[METHOD_MARKER_KEY] = true;
        }
        container[moduleId] = wrapped;
        state.cleanup.push(function(){
          try {
            container[moduleId] = original;
          } catch (error) {
            /* ignore */
          }
        });
        mark("factory-trap");
      }

      function inspectModuleMap(map){
        if (!map || typeof map !== "object"){
          return;
        }
        var ids;
        try {
          ids = Object.keys(map);
        } catch (error) {
          return;
        }
        for (var i = 0; i < ids.length; i += 1){
          wrapFactory(map, ids[i]);
        }
      }

      function wrapChunkArray(value){
        if (!value || !Array.isArray(value) || value[PUSH_MARKER_KEY]){
          return;
        }
        var originalPush = value.push;
        if (typeof originalPush !== "function"){
          return;
        }
        try {
          Object.defineProperty(value, PUSH_MARKER_KEY, { value: true, configurable: true });
        } catch (error) {
          return;
        }
        value.push = function(){
          for (var i = 0; i < arguments.length; i += 1){
            var chunk = arguments[i];
            // webpack chunk shape: [[chunkIds], {moduleId: factory}, ...]
            if (Array.isArray(chunk) && chunk.length >= 2){
              inspectModuleMap(chunk[1]);
            }
          }
          return originalPush.apply(this, arguments);
        };
        state.cleanup.push(function(){
          try {
            value.push = originalPush;
            delete value[PUSH_MARKER_KEY];
          } catch (error) {
            /* ignore */
          }
        });
        // Modules already registered before we attached.
        for (var j = 0; j < value.length; j += 1){
          if (Array.isArray(value[j]) && value[j].length >= 2){
            inspectModuleMap(value[j][1]);
          }
        }
      }

      function scanChunkContainers(){
        var names = [];
        try {
          names = Object.getOwnPropertyNames(W);
        } catch (error) {
          names = [];
        }
        for (var i = 0; i < names.length; i += 1){
          if (names[i].indexOf("webpackChunk") === 0){
            wrapChunkArray(W[names[i]]);
          }
        }
      }

      function cleanup(){
        while (state.cleanup.length > 0){
          var dispose = state.cleanup.pop();
          try {
            dispose();
          } catch (error) {
            /* ignore */
          }
        }
        try {
          if (W[MARKER_KEY] && W[MARKER_KEY].mode === "runtime"){
            delete W[MARKER_KEY];
          }
          delete W[RUNTIME_STATE_KEY];
          delete W[RUNTIME_RESULT_KEY];
        } catch (error) {
          /* ignore */
        }
      }
      state.cleanupRuntime = cleanup;

      scanChunkContainers();
      var timer = W.setInterval(function(){
        state.scans += 1;
        scanChunkContainers();
        if (state.scans >= state.maxScans){
          W.clearInterval(timer);
        }
      }, 25);
      state.cleanup.push(function(){
        W.clearInterval(timer);
      });

      return { applied: state.applied, mode: "runtime", anchorsHit: state.anchorsHit.slice(0, 12) };
    } catch (error) {
      return { applied: false, mode: "runtime", anchorsHit: [] };
    }
  }

  root[API_KEY] = {
    version: VERSION,
    MARKER_PAGESIZE: MARKER_PAGESIZE,
    MARKER_ROWHEIGHT: MARKER_ROWHEIGHT,
    ANCHORS: ANCHORS,
    patchBundleText: patchBundleText,
    installRuntimePatch: installRuntimePatch
  };

  if (typeof module !== "undefined" && module.exports){
    module.exports = root[API_KEY];
  }
})(typeof self !== "undefined" ? self : globalThis);
