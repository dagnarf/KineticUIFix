// grid-revirtualize-fix.js — the BINDING-DIRECTIVE fix (v3) for the Kinetic Kendo-Angular grid
// group/ungroup virtualization-defeat leak.
//
// ✅ LIVE-VALIDATED (2026-06-03, full scale): with all 4,466 records loaded, multi-field group→ungroup
//    keeps post-ungroup tbodyRows=80 (vs 4,466), DOM=8,971 (vs 469,501), heap=248 MB (vs 2,037 MB),
//    stable across cycles; mounts at 80 (no scroll regression); scroll-to-bottom populates with no
//    snap. Evidence: .output/chrome-plugin-grid-fix/v3-validation-success.md.
//
// WHY v3 / WHY THIS LAYER (full live diagnosis: .output/chrome-plugin-grid-fix/leak-mechanism-confirmed.md):
//   The render-all is NOT triggered by ungrouping — it is triggered DURING multi-field GROUPING (the
//   grouped `view` legitimately expands to every row). The bug is that on UNGROUP the grid never
//   restores the windowed `view`. Live, instrumenting the grid-binding directive's rebind() showed:
//     group-Job: take=80,        grp=1, viewLen=80     (still windowed)
//     group-Rev: take=undefined, grp=3, viewLen=500    (grouping NULLED state.take -> render-all)
//     ungroup:   take=undefined, grp=0, viewLen=500    (ungrouped, take STILL undefined -> LEAK)
//   The content-directive `createScroller` hook (v2) fired 0x on ungroup and so could never fix it
//   (it also mis-fired on mount and shrank the window 80->35 = the scroll regression). rebind() DOES
//   fire on the ungroup edge (6x, incl. grp===0), and `state.take` is the lever (undefined -> view=all).
//
// THE CURE (v3): a one-line hook at the Kinetic binding directive's rebind() opening
//   (`rebind(){this.checkForPrismSkip()` — exactly once in both 437c1f00 + a25a4062). The hook runs
//   BEFORE the original rebind recomputes `view`:
//     - captures the NATURAL window (the largest sane `state.take` seen, ~80) so we restore to the
//       grid's own page size, never a viewport-only guess;
//     - acts ONLY when fully ungrouped (`state.group.length === 0`) AND `state.take` is pathological
//       (undefined / <=0 / >> natural) — so it is a cheap no-op on mount (take=80 is not pathological),
//       on scroll (take unchanged), and while grouped (render-all is intended there);
//     - restores `state.take` (+ `grid.pageSize` for the content directive's take binding) to the
//       natural window. The original rebind then computes the windowed `view` (~80 rows).
//   No createScroller, no setTimeout, no mount mis-fire, no scroll regression.
//
// DELIVERY (mechanism-agnostic — see src/background.js + src/inject-main-world.js):
//   M1 (debugger Fetch text-rewrite, default/robust): patchBundleText() injects the one-line hook call
//      at the rebind anchor and APPENDS the hook def + the §3 marker. Reaches the live instance via
//      `this` — no Ivy reachability problem. (The extension's in-process chrome.debugger has no ws
//      body-size limit; external CDP can only *send* a fulfill body, not *receive* a 17 MB one.)
//   M2 (MAIN-world document_start): installHook() exposes the global; installBindingWrap() best-effort
//      wraps the binding-directive class's rebind via the webpack chunk map (M1 preferred — the Ivy
//      class is not always a module.exports key).
//
// HYGIENE: explicit semicolons;
//   idempotent; the hook is self-contained so its .toString() is a valid standalone definition.

(function (root) {
  "use strict";

  var VERSION = "3.0.0";
  var API_KEY = "__KINETIC_GRID_REVIRT__";
  var MARKER_KEY = "__KINETIC_GRID_FIX__";
  var HOOK_GLOBAL = "__KINETIC_GRID_FIX_HOOK__";
  var STATE_KEY = "__KINETIC_GRID_REVIRT_STATE__";
  var WRAP_MARKER = "__kgfBindingWrapped__";
  var PUSH_MARKER = "__kgfChunkPushWrapped__";
  var ARRAY_PUSH_MARKER = "__kgfArrayPushWrapped__";
  var LF = String.fromCharCode(10);

  // The stable, unique rewrite anchor: the Kinetic grid-binding directive's rebind() override opening.
  // Verified exactly once in both main.437c1f00e1f99d77.js and main.a25a40629ba315f8.js — every token
  // is a preserved property name (rebind/checkForPrismSkip), which terser does not mangle.
  var ANCHOR = "rebind(){this.checkForPrismSkip()";
  var ANCHOR_NAME = "rebind-hook";

  // ---------------------------------------------------------------------------
  // The corrector. `bd` is the grid-binding directive instance (has .state {skip,take,group,...} and
  // .grid = the Kendo GridComponent). Fully self-contained so its .toString() injects cleanly.
  // ---------------------------------------------------------------------------
  function __kineticGridFixHook(bd) {
    try {
      if (!bd || typeof bd !== "object") {
        return;
      }
      var state = bd.state;
      if (!state || typeof state !== "object") {
        return;
      }

      var group = state.group;
      var groupLen = (group && typeof group.length === "number") ? group.length : 0;
      var take = state.take;
      var MAX_WINDOW = 1000;

      // The binding directive AND the Kendo grid component are RECREATED when grouping changes (live-
      // confirmed: bd#1/grid#1 -> bd#2/grid#2 on the 2nd group field), so a per-instance capture is
      // lost before ungroup. The Kinetic wrapper `epGrid` SURVIVES (stable across the whole cycle), so
      // we stash the natural window there. Fall back to `bd` for non-Kinetic grids that don't recreate.
      var store = (bd.epGrid && typeof bd.epGrid === "object") ? bd.epGrid : bd;

      // OPT-IN SCROLL BUFFER (default OFF): when enabled, render a LARGER virtual window so a fast scroll
      // stays populated instead of flashing blank while Kendo re-pages translateY. Config is delivered out
      // of band so this self-contained hook stays config-agnostic: M1 (debugger) bakes
      // window.__KINETIC_GRID_FIX_CONFIG__ into the bundle; M2 (runtime) mirrors it onto the shared
      // <html data-kgf-config> attribute (set from the ISOLATED world / background). Absent config => OFF
      // => this block is inert and the code path below is byte-for-byte the original leak-only behavior.
      var cfg = null;
      try {
        var Wc = (typeof window !== "undefined") ? window : null;
        if (Wc) {
          cfg = Wc.__KINETIC_GRID_FIX_CONFIG__ || null;
          if (!cfg && Wc.document && Wc.document.documentElement && Wc.document.documentElement.dataset) {
            var raw = Wc.document.documentElement.dataset.kgfConfig;
            if (raw) { try { cfg = JSON.parse(raw); } catch (eCfg) { cfg = null; } }
          }
        }
      } catch (eCfgRead) {
        cfg = null;
      }
      var bufferOn = !!(cfg && cfg.scrollBuffer);
      var bufferMult = (cfg && typeof cfg.bufferMult === "number" && cfg.bufferMult > 1) ? cfg.bufferMult : 3;

      // (a) Capture the NATURAL window: the largest sane take we have seen (mount/healthy ~80). Bounded by
      //     MAX_WINDOW so a render-all take can never be captured as the window. EXCLUDE our own buffered
      //     value so the buffered take never feeds back and inflates `natural` (runaway guard).
      if (typeof take === "number" && take > 0 && take <= MAX_WINDOW && take !== store.__kgfBufferedTake) {
        if (!store.__kgfNaturalTake || take > store.__kgfNaturalTake) {
          store.__kgfNaturalTake = take;
        }
      }

      // (b) Act ONLY when fully ungrouped. While grouped, render-all is intended (grouped view shows
      //     every row), so we never touch it.
      if (groupLen !== 0) {
        return;
      }
      var natural = store.__kgfNaturalTake;
      if (!natural) {
        // Never observed a natural window -> do NOT risk under-windowing the grid.
        return;
      }

      // The window we want the grid to render: the buffered (natural * mult, capped) window when the scroll
      // buffer is opted in, otherwise the grid's own natural window (original behavior).
      var targetWindow = bufferOn ? Math.min(MAX_WINDOW, Math.round(natural * bufferMult)) : natural;

      // (c) Act when render-all is pathological (take missing / non-positive / far above natural) OR — only
      //     with the buffer on — when the current window is below the buffered target and should grow.
      var pathological = (typeof take !== "number") || take <= 0 || take > (natural * 4);
      var needGrow = bufferOn && typeof take === "number" && take > 0 && take < targetWindow;
      if (!pathological && !needGrow) {
        return;
      }

      // (d) Set the windowed `take` BEFORE the original rebind computes `view`. Keep grid.pageSize
      //     consistent so the content directive's `take` binding re-windows too.
      state.take = targetWindow;
      if (bufferOn) {
        store.__kgfBufferedTake = targetWindow;
      }
      try {
        if (bd.grid && typeof bd.grid === "object") {
          bd.grid.pageSize = targetWindow;
        }
      } catch (eGrid) {
        /* ignore */
      }

      // (e) §3 marker evidence (so Track D can verify the fix fired).
      try {
        var W = (typeof window !== "undefined") ? window : null;
        if (W) {
          var marker = W.__KINETIC_GRID_FIX__ || {};
          marker.enabled = true;
          marker.applied = true;
          if (!marker.mode) {
            marker.mode = "rebind";
          }
          marker.lastWindow = targetWindow;
          if (bufferOn) {
            marker.scrollBuffer = true;
            marker.bufferWindow = targetWindow;
            marker.naturalWindow = natural;
          }
          marker.corrections = (marker.corrections | 0) + 1;
          W.__KINETIC_GRID_FIX__ = marker;
        }
      } catch (eMarker) {
        /* ignore */
      }
    } catch (eOuter) {
      /* never throw into the page */
    }
  }

  var HOOK_SOURCE = Function.prototype.toString.call(__kineticGridFixHook);

  // ---------------------------------------------------------------------------
  // shared helpers
  // ---------------------------------------------------------------------------
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

  // Normalize the opt-in scroll-buffer config to the minimal shape the hook reads. Returns null when the
  // buffer is not requested (so no config global is baked and the buffer stays OFF). bufferMult is bounded
  // to a sane [2,8] range; the hook additionally caps the resulting window at MAX_WINDOW.
  function sanitizeConfig(config) {
    if (!config || typeof config !== "object" || config.scrollBuffer !== true) {
      return null;
    }
    var mult = Number(config.bufferMult);
    if (!isFinite(mult) || mult < 2) { mult = 3; }
    if (mult > 8) { mult = 8; }
    return { scrollBuffer: true, bufferMult: mult };
  }

  function bundleHashFromUrl(url) {
    if (!url || typeof url !== "string") {
      return null;
    }
    var qEnd = url.indexOf("?");
    var path = qEnd >= 0 ? url.slice(0, qEnd) : url;
    var hEnd = path.indexOf("#");
    if (hEnd >= 0) {
      path = path.slice(0, hEnd);
    }
    var slash = path.lastIndexOf("/");
    var fileName = slash >= 0 ? path.slice(slash + 1) : path;
    var lower = fileName.toLowerCase();
    if (lower.indexOf("main.") !== 0 || lower.lastIndexOf(".js") !== lower.length - 3) {
      return null;
    }
    var middle = fileName.slice(5, fileName.length - 3);
    return middle || null;
  }

  function markerObject(info, mode, anchorsHit, applied) {
    var src = info || {};
    return {
      version: VERSION,
      enabled: true,
      applied: applied !== false,
      mode: mode,
      bundleHash: src.bundleHash || bundleHashFromUrl(src.url) || null,
      anchorsHit: Array.isArray(anchorsHit) ? anchorsHit.slice(0, 12) : [],
      corrections: 0
    };
  }

  // ---------------------------------------------------------------------------
  // M1 — text rewrite. Inject the hook CALL at the rebind anchor + APPEND the hook def + §3 marker.
  // ---------------------------------------------------------------------------
  function patchBundleText(sourceText, info) {
    try {
      if (typeof sourceText !== "string" || sourceText.length === 0) {
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }
      if (sourceText.indexOf(HOOK_GLOBAL) >= 0) {
        return { patched: sourceText, applied: true, anchorsHit: ["already-injected"], mode: "text" };
      }
      if (countOccurrences(sourceText, ANCHOR) !== 1) {
        return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
      }

      // ANCHOR = "rebind(){this.checkForPrismSkip()" — inject the call right after "rebind(){".
      var injectAt = "rebind(){";
      var callSnippet = injectAt
        + "try{window." + HOOK_GLOBAL + "&&window." + HOOK_GLOBAL + "(this);}catch(_kgf){}"
        + "this.checkForPrismSkip()";
      var out = sourceText.replace(ANCHOR, callSnippet);

      var marker = markerObject(info, "rebind-text", [ANCHOR_NAME]);
      // Opt-in scroll-buffer config rides with the hook injection (so the buffered window is active the
      // instant the hook runs). Baked ONLY when info.config requests it; absent => buffer OFF => the hook's
      // buffer block is inert. M2 (runtime) doesn't reliably wrap the directive on every build, so the
      // buffer is a debugger-mode (M1) feature — same delivery the leak fix is validated through.
      var cfg = sanitizeConfig(info && info.config);
      var cfgTail = cfg
        ? "window.__KINETIC_GRID_FIX_CONFIG__=" + JSON.stringify(cfg) + ";"
        : "";
      var tail = ";try{window." + HOOK_GLOBAL + "=" + HOOK_SOURCE + ";"
        + cfgTail
        + "window." + MARKER_KEY + "=" + JSON.stringify(marker) + ";"
        + "}catch(_kgf){}";

      return { patched: out + LF + tail + LF, applied: true, anchorsHit: [ANCHOR_NAME], mode: "text" };
    } catch (error) {
      return { patched: sourceText, applied: false, anchorsHit: [], mode: "text" };
    }
  }

  // ---------------------------------------------------------------------------
  // M2 — runtime install (MAIN world, document_start), best-effort.
  // ---------------------------------------------------------------------------
  function installHook(W) {
    try {
      if (!W || typeof W !== "object") {
        return false;
      }
      W[HOOK_GLOBAL] = __kineticGridFixHook;
      if (!W[MARKER_KEY]) {
        W[MARKER_KEY] = markerObject({ bundleHash: null }, "rebind-runtime", [], false);
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  function functionText(value) {
    try {
      return Function.prototype.toString.call(value);
    } catch (error) {
      return "";
    }
  }

  // The grid-binding directive prototype owns rebind(); names around it drift between Kinetic builds.
  // Prefer the older preserved members when present, but allow newer builds through and let the hook's
  // bd.state/bd.grid guards make non-binding rebind methods harmless.
  function isBindingPrototype(proto) {
    if (!proto || typeof proto.rebind !== "function") {
      return false;
    }
    if (typeof proto.applyState === "function" || typeof proto.onStateChange === "function") {
      return true;
    }
    var text = functionText(proto.rebind);
    return text.indexOf("state") >= 0 || text.indexOf("grid") >= 0 || text.indexOf("customLoading") >= 0 || text.indexOf("loader") >= 0;
  }

  function wrapBindingPrototype(proto, state) {
    try {
      if (!isBindingPrototype(proto)) {
        return false;
      }
      if (proto[WRAP_MARKER]) {
        return true;
      }
      var original = proto.rebind;
      proto.rebind = function () {
        try {
          if (state.hook) {
            state.hook(this);
          }
        } catch (eHook) {
          /* never throw into the page */
        }
        return original.apply(this, arguments);
      };
      try {
        Object.defineProperty(proto, WRAP_MARKER, { value: true, configurable: true });
      } catch (eDefine) {
        proto[WRAP_MARKER] = true;
      }
      state.cleanup.push(function () {
        try {
          proto.rebind = original;
          delete proto[WRAP_MARKER];
        } catch (eRestore) {
          /* ignore */
        }
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  function scanExportsForBinding(moduleExports, state) {
    var installed = false;
    function tryCandidate(candidate) {
      if (typeof candidate === "function" && candidate.prototype && wrapBindingPrototype(candidate.prototype, state)) {
        installed = true;
      }
    }
    try {
      if (!moduleExports || (typeof moduleExports !== "object" && typeof moduleExports !== "function")) {
        return false;
      }
      tryCandidate(moduleExports);
      var keys;
      try {
        keys = Object.keys(moduleExports);
      } catch (eKeys) {
        return false;
      }
      for (var i = 0; i < keys.length && i < 256; i += 1) {
        var candidate;
        try {
          candidate = moduleExports[keys[i]];
        } catch (eGet) {
          continue;
        }
        tryCandidate(candidate);
      }
    } catch (error) {
      /* ignore */
    }
    return installed;
  }

  function installBindingWrap(W) {
    try {
      if (!W || typeof W !== "object") {
        return { applied: false, mode: "rebind-runtime", anchorsHit: [] };
      }
      if (W[STATE_KEY]) {
        return { applied: !!W[STATE_KEY].applied, mode: "rebind-runtime", anchorsHit: W[STATE_KEY].anchorsHit.slice(0, 12) };
      }

      var state = { applied: false, prototypeWrapped: false, trapInstalled: false, anchorsHit: [], cleanup: [], scans: 0, maxScans: 1200, hook: __kineticGridFixHook };
      W[STATE_KEY] = state;
      installHook(W);

      function publishStatus() {
        var marker = W[MARKER_KEY] || markerObject({ bundleHash: null }, "rebind-runtime", [], false);
        marker.enabled = true;
        marker.applied = state.applied === true;
        marker.mode = "rebind-runtime";
        marker.anchorsHit = state.anchorsHit.slice(0, 12);
        marker.trapInstalled = state.trapInstalled === true;
        marker.prototypeWrapped = state.prototypeWrapped === true;
        marker.scans = state.scans | 0;
        if (typeof marker.corrections !== "number") {
          marker.corrections = 0;
        }
        W[MARKER_KEY] = marker;
        W.__KINETIC_GRID_REVIRT_RESULT__ = {
          applied: state.applied === true,
          mode: "rebind-runtime",
          anchorsHit: state.anchorsHit.slice(0, 12),
          trapInstalled: state.trapInstalled === true,
          prototypeWrapped: state.prototypeWrapped === true,
          scans: state.scans | 0
        };
      }

      function mark(name, applied) {
        if (state.anchorsHit.indexOf(name) < 0) {
          state.anchorsHit.push(name);
        }
        if (name === "array-push-trap" || name === "chunk-push-trap" || name === "binding-factory-trap") {
          state.trapInstalled = true;
        }
        if (applied === true || name === "binding-prototype-wrap") {
          state.applied = true;
          state.prototypeWrapped = true;
        }
        publishStatus();
      }

      function wrapFactory(container, moduleId) {
        var original = container[moduleId];
        if (typeof original !== "function" || original[WRAP_MARKER]) {
          return;
        }
        var text = functionText(original);
        if (text.indexOf("checkForPrismSkip") < 0
          && text.indexOf("onStateChange") < 0
          && text.indexOf("applyState") < 0
          && text.indexOf("rebind") < 0) {
          return;
        }
        var wrapped = function (module) {
          var result = original.apply(this, arguments);
          try {
            if (module && module.exports && scanExportsForBinding(module.exports, state)) {
              mark("binding-prototype-wrap");
            }
          } catch (eScan) {
            /* ignore */
          }
          return result;
        };
        try {
          Object.defineProperty(wrapped, WRAP_MARKER, { value: true, configurable: true });
        } catch (eDef) {
          wrapped[WRAP_MARKER] = true;
        }
        container[moduleId] = wrapped;
        state.cleanup.push(function () {
          try {
            container[moduleId] = original;
          } catch (eRestore) {
            /* ignore */
          }
        });
        mark("binding-factory-trap");
      }

      function inspectModuleMap(map) {
        if (!map || typeof map !== "object") {
          return;
        }
        var ids;
        try {
          ids = Object.keys(map);
        } catch (eIds) {
          return;
        }
        for (var i = 0; i < ids.length; i += 1) {
          wrapFactory(map, ids[i]);
        }
      }

      function wrapChunkArray(value) {
        if (!value || !Array.isArray(value) || value[PUSH_MARKER]) {
          return;
        }
        var hadOwnPush = Object.prototype.hasOwnProperty.call(value, "push");
        var originalPush = value.push;
        if (typeof originalPush !== "function") {
          return;
        }
        try {
          Object.defineProperty(value, PUSH_MARKER, { value: true, configurable: true });
        } catch (eMark) {
          return;
        }
        value.push = function () {
          for (var i = 0; i < arguments.length; i += 1) {
            var chunk = arguments[i];
            if (Array.isArray(chunk) && chunk.length >= 2) {
              inspectModuleMap(chunk[1]);
            }
          }
          return originalPush.apply(this, arguments);
        };
        mark("chunk-push-trap");
        state.cleanup.push(function () {
          try {
            if (hadOwnPush) {
              value.push = originalPush;
            } else {
              delete value.push;
            }
            delete value[PUSH_MARKER];
          } catch (eRestore) {
            /* ignore */
          }
        });
        for (var j = 0; j < value.length; j += 1) {
          if (Array.isArray(value[j]) && value[j].length >= 2) {
            inspectModuleMap(value[j][1]);
          }
        }
      }

      function installArrayPushTrap() {
        var arrayCtor = W.Array || (typeof Array !== "undefined" ? Array : null);
        var proto = arrayCtor && arrayCtor.prototype;
        if (!proto || typeof proto.push !== "function" || proto[ARRAY_PUSH_MARKER]) {
          return;
        }
        var originalPush = proto.push;
        proto.push = function () {
          for (var i = 0; i < arguments.length; i += 1) {
            var chunk = arguments[i];
            if (Array.isArray(chunk) && chunk.length >= 2) {
              inspectModuleMap(chunk[1]);
            }
          }
          return originalPush.apply(this, arguments);
        };
        try {
          Object.defineProperty(proto, ARRAY_PUSH_MARKER, { value: true, configurable: true });
        } catch (eMark) {
          proto[ARRAY_PUSH_MARKER] = true;
        }
        state.cleanup.push(function () {
          try {
            proto.push = originalPush;
            delete proto[ARRAY_PUSH_MARKER];
          } catch (eRestore) {
            /* ignore */
          }
        });
        mark("array-push-trap");
      }

      function scanChunkContainers() {
        var names;
        try {
          names = Object.getOwnPropertyNames(W);
        } catch (eNames) {
          return;
        }
        for (var i = 0; i < names.length; i += 1) {
          if (names[i].indexOf("webpackChunk") === 0) {
            wrapChunkArray(W[names[i]]);
          }
        }
      }

      function cleanup() {
        while (state.cleanup.length > 0) {
          var dispose = state.cleanup.pop();
          try {
            dispose();
          } catch (eDispose) {
            /* ignore */
          }
        }
        try {
          if (W[MARKER_KEY] && typeof W[MARKER_KEY].mode === "string" && W[MARKER_KEY].mode.indexOf("rebind-runtime") === 0) {
            delete W[MARKER_KEY];
          }
          delete W[STATE_KEY];
          delete W[HOOK_GLOBAL];
          delete W.__KINETIC_GRID_REVIRT_RESULT__;
        } catch (eClear) {
          /* ignore */
        }
      }
      state.cleanupRuntime = cleanup;

      installArrayPushTrap();
      scanChunkContainers();
      if (W.setInterval) {
        var timer = W.setInterval(function () {
          state.scans += 1;
          scanChunkContainers();
          publishStatus();
          if (state.scans >= state.maxScans && W.clearInterval) {
            W.clearInterval(timer);
          }
        }, 25);
        state.cleanup.push(function () {
          if (W.clearInterval) {
            W.clearInterval(timer);
          }
        });
      }

      publishStatus();
      return { applied: state.applied, mode: "rebind-runtime", anchorsHit: state.anchorsHit.slice(0, 12) };
    } catch (error) {
      return { applied: false, mode: "rebind-runtime", anchorsHit: [] };
    }
  }

  root[API_KEY] = {
    version: VERSION,
    ANCHOR: ANCHOR,
    ANCHOR_NAME: ANCHOR_NAME,
    HOOK_GLOBAL: HOOK_GLOBAL,
    HOOK_SOURCE: HOOK_SOURCE,
    gridFixHook: __kineticGridFixHook,
    sanitizeConfig: sanitizeConfig,
    patchBundleText: patchBundleText,
    installHook: installHook,
    installBindingWrap: installBindingWrap,
    // Back-compat alias (background/inject may still reference the v2 name).
    installDirectiveWrap: installBindingWrap
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root[API_KEY];
  }
})(typeof self !== "undefined" ? self : globalThis);
