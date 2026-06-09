// grid-blank-fix.js — corrects the Kinetic Kendo virtual-grid "blank viewport after bulk load" defect.
//
// SYMPTOM (live-diagnosed 2026-06-04, Job Status Maintenance JCGO3033, SaaS950 Education, 25,276 jobs):
//   after a large data load (Search -> Download Records -> Get More xN -> Select All -> OK), the grid
//   renders BLANK even though the rows are in the DOM and the toolbar is enabled. Kendo positions virtual
//   rows with transform: translateY(N) on .k-grid-table where N tracks the scroller's scrollTop
//   (N ~= skip * rowHeight). After a bulk load the table is left translated for a non-zero window
//   (N ~= 10,000px) while scrollTop is ~0 and NO scroll event fires to reconcile them -> the rendered
//   rows sit N px outside the viewport. Persists (>90s) until a manual scroll. Intermittent.
//
// CURE: a virtual-scroll ALIGNMENT WATCHDOG. It checks each virtual grid; if rendered rows exist but
//   NONE intersect the viewport while scrollTop is near the top (the bug signature, in EITHER direction),
//   it performs a page-crossing scroll nudge then returns to an aligned top. Proven live: a sub-page nudge
//   does NOT trigger Kendo's translateY rewrite, but a page-crossing scrollTop change does -> far-jump-
//   then-0 realigns. Near-top-only so it never fights a user who has scrolled away; no-op on healthy
//   grids (validated: 0 false corrections).
//
// v1.1.0 hardening (2026-06-04): (1) STABILITY GATE — re-confirm the blank ~70ms later before acting, so
//   a single transient frame during fast scrolling is never corrected; (2) SYMMETRIC detection — catches
//   rows rendered above OR below the viewport at the top; (3) faster 800ms safety interval + a
//   relevance-FILTERED MutationObserver (only re-checks on grid-related DOM churn, not page-wide churn);
//   (4) IN-FLIGHT guard so concurrent triggers don't stack corrections on one grid; (5) richer diagnostics
//   (trigger source + signed topGap in the log; lastCorrectionAt / lastTopGap on the shared marker).
//
// DELIVERY (mechanism-agnostic, mirrors src/grid-revirtualize-fix.js): M1 (debugger) appends the
//   watchdog's self-installing source to the patched bundle; M2 (runtime) installs it at document_start.
//
// HYGIENE: explicit semicolons; idempotent (per-window marker); fail-safe (never
//   throws into the page); all observers/timers/listeners registered for teardown. The watchdog is ONE
//   fully self-contained function so its .toString() embeds verbatim for M1 (no outer-scope refs).

(function (root) {
  "use strict";
  var VERSION = "1.1.0";
  var API_KEY = "__KINETIC_GRID_BLANK_FIX__";

  // Fully self-contained watchdog. install with (W). Returns the api or null. Idempotent.
  function __kineticGridBlankWatchdog(W) {
    try {
      if (!W || typeof W !== "object" || !W.document) { return null; }
      var SELF_KEY = "__KINETIC_GRID_BLANK_FIX__";
      var MARKER_KEY = "__KINETIC_GRID_FIX__";
      var FIX_VERSION = "1.1.0";
      if (W[SELF_KEY] && W[SELF_KEY].__installed === true) { return W[SELF_KEY]; }
      var D = W.document;
      var STABILITY_MS = 70;     // re-confirm window before correcting (transient-frame guard)
      var INTERVAL_MS = 800;     // safety scan period

      function contentOf(grid) {
        return grid.querySelector(".k-grid-content-virtual")
          || grid.querySelector(".k-grid-content.k-virtual-content")
          || grid.querySelector(".k-grid-content");
      }
      function isVirtualGrid(grid) {
        try { return String(grid.className || "").indexOf("k-grid-virtual") >= 0 || !!grid.querySelector(".k-virtual-content"); }
        catch (e) { return false; }
      }
      // Returns {blank, rows, inView, scrollTop, topGap (signed), clientH} or null when no data rows.
      function diagnose(content) {
        try {
          if (!content) { return null; }
          var tb = content.querySelector("tbody");
          if (!tb) { return null; }
          var rows = tb.children;
          if (!rows || rows.length === 0) { return null; }
          var cr = content.getBoundingClientRect();
          var inView = 0, firstTop = null;
          for (var i = 0; i < rows.length; i += 1) {
            var rr = rows[i].getBoundingClientRect();
            if (firstTop === null) { firstTop = rr.top; }
            if (rr.bottom > cr.top && rr.top < cr.bottom) { inView += 1; }
          }
          var scrollTop = content.scrollTop;
          var clientH = content.clientHeight || 1;
          var topGap = firstTop - cr.top;
          // Bug signature: rows exist, NONE intersect the viewport, scroller near the TOP, and the rows
          // sit a full viewport+ AWAY (above or below). Near-top-only: never fights a scrolled user.
          var blank = inView === 0 && rows.length > 0 && scrollTop < clientH && Math.abs(topGap) > clientH;
          return { blank: blank, rows: rows.length, inView: inView, scrollTop: Math.round(scrollTop), topGap: Math.round(topGap), clientH: Math.round(clientH) };
        } catch (e) { return null; }
      }

      var state = {
        __installed: true, observers: [], timers: [], listeners: [], corrections: 0, log: [],
        debounce: null, attempts: new W.WeakMap(), inFlight: new W.WeakSet(),
        lastCorrectionAt: null, lastTopGap: null
      };

      function publishMarker(extra) {
        try {
          var m = W[MARKER_KEY] || {};
          m.blankFixVersion = FIX_VERSION;
          m.blankFixArmed = true;
          if (typeof m.blankCorrections !== "number") { m.blankCorrections = 0; }
          if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { m[k] = extra[k]; } } }
          W[MARKER_KEY] = m;
        } catch (e) { /* ignore */ }
      }

      // Force Kendo to recompute translateY: jump a few viewports (page-crossing) then return to top.
      function correctGrid(content, trigger) {
        try {
          var max = Math.max(0, content.scrollHeight - content.clientHeight);
          var far = Math.min(max, Math.max(content.clientHeight * 5, 4000));
          if (far <= 0) { state.inFlight.delete(content); return; }
          var n = state.attempts.get(content) || 0;
          if (n >= 4) { state.inFlight.delete(content); return; } // bounded; observer/interval re-arm later
          state.attempts.set(content, n + 1);
          content.scrollTop = far; // page-crossing -> Kendo re-pages + rewrites translateY
          var t1 = W.setTimeout(function () {
            content.scrollTop = 0; // back to top -> translateY 0 -> rows aligned at top
            var t2 = W.setTimeout(function () {
              var d = diagnose(content);
              if (d && d.blank) {
                correctGrid(content, trigger); // still blank -> bounded retry
              } else {
                state.corrections += 1;
                state.attempts.set(content, 0);
                state.inFlight.delete(content);
                state.lastCorrectionAt = (W.Date ? W.Date.now() : 0);
                publishMarker({ blankCorrections: ((W[MARKER_KEY] && W[MARKER_KEY].blankCorrections) | 0) + 1, lastCorrectionAt: state.lastCorrectionAt, lastTopGap: state.lastTopGap });
              }
            }, 340);
            state.timers.push(t2);
          }, 220);
          state.timers.push(t1);
        } catch (e) { try { state.inFlight.delete(content); } catch (e2) {} }
      }

      // Stability gate: only correct if the blank PERSISTS past a short window (kills transient frames).
      function confirmAndCorrect(content, trigger, d0) {
        try {
          if (state.inFlight.has(content)) { return; }
          state.inFlight.add(content);
          var t = W.setTimeout(function () {
            var d = diagnose(content);
            if (d && d.blank) {
              state.lastTopGap = d.topGap;
              try { state.log.push({ at: (W.Date ? W.Date.now() : 0), trigger: trigger, scrollTop: d.scrollTop, topGap: d.topGap, rows: d.rows, clientH: d.clientH }); if (state.log.length > 50) { state.log.shift(); } } catch (eL) {}
              correctGrid(content, trigger);
            } else {
              state.inFlight.delete(content); // transient -> stand down
            }
          }, STABILITY_MS);
          state.timers.push(t);
        } catch (e) { try { state.inFlight.delete(content); } catch (e2) {} }
      }

      function checkAll(trigger) {
        var report = { scanned: 0, blank: 0, corrected: 0, trigger: trigger || "manual", grids: [] };
        try {
          var grids = D.querySelectorAll(".k-grid");
          for (var i = 0; i < grids.length; i += 1) {
            var g = grids[i];
            if (!isVirtualGrid(g)) { continue; }
            var c = contentOf(g);
            var d = diagnose(c);
            if (!d) { continue; }
            report.scanned += 1;
            report.grids.push(d);
            if (d.blank) {
              report.blank += 1;
              report.corrected += 1;
              confirmAndCorrect(c, report.trigger, d);
            }
          }
        } catch (e) { /* ignore */ }
        return report;
      }

      function scheduleCheck(trigger) {
        if (state.debounce) { W.clearTimeout(state.debounce); }
        state.debounce = W.setTimeout(function () { checkAll(trigger || "observer"); }, 120);
      }

      // Cheap relevance filter: only re-check when a mutation touches grid rows/tables, not page-wide churn.
      function isGridRelevant(muts) {
        try {
          for (var i = 0; i < muts.length; i += 1) {
            var m = muts[i];
            var t = m.target;
            if (t && t.nodeType === 1) {
              var tn = t.nodeName;
              if (tn === "TBODY" || tn === "TR" || tn === "TABLE" || tn === "TD") { return true; }
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
        } catch (e) { return true; } // on any doubt, allow the check
        return false;
      }

      // 1) Observe row mutations (rows render/replace after a load) -> filtered, debounced check.
      var MO = W.MutationObserver;
      if (MO && D.body) {
        try {
          var obs = new MO(function (muts) { if (isGridRelevant(muts)) { scheduleCheck("observer"); } });
          obs.observe(D.body, { childList: true, subtree: true });
          state.observers.push(obs);
        } catch (eObs) { /* ignore */ }
      }
      // 2) Faster low-frequency safety scan (covers the persistent / transform-only / no-mutation cases).
      var iv = W.setInterval(function () { checkAll("interval"); }, INTERVAL_MS);
      state.timers.push(iv);
      // 3) Initial pass.
      scheduleCheck("init");

      function uninstall() {
        try {
          for (var i = 0; i < state.observers.length; i += 1) { try { state.observers[i].disconnect(); } catch (e) {} }
          for (var j = 0; j < state.timers.length; j += 1) { try { W.clearTimeout(state.timers[j]); W.clearInterval(state.timers[j]); } catch (e) {} }
          for (var k = 0; k < state.listeners.length; k += 1) { try { state.listeners[k](); } catch (e) {} }
          if (state.debounce) { W.clearTimeout(state.debounce); }
          state.__installed = false;
          if (W[SELF_KEY] === api) { try { delete W[SELF_KEY]; } catch (eD) { W[SELF_KEY] = null; } }
        } catch (e) { /* ignore */ }
      }

      var api = {
        version: FIX_VERSION,
        __installed: true,
        check: function () { return checkAll("manual"); },
        diagnoseAll: function () {
          var out = [], grids = D.querySelectorAll(".k-grid");
          for (var i = 0; i < grids.length; i += 1) { if (isVirtualGrid(grids[i])) { out.push(diagnose(contentOf(grids[i]))); } }
          return out;
        },
        corrections: function () { return state.corrections; },
        log: function () { return state.log.slice(); },
        lastCorrection: function () { return { at: state.lastCorrectionAt, topGap: state.lastTopGap, count: state.corrections }; },
        uninstall: uninstall
      };
      W[SELF_KEY] = api;
      publishMarker(); // reflect armed state in the shared marker
      return api;
    } catch (e) { return null; }
  }

  var WATCHDOG_SOURCE = Function.prototype.toString.call(__kineticGridBlankWatchdog);

  root[API_KEY + "_MODULE"] = {
    version: VERSION,
    watchdog: __kineticGridBlankWatchdog,
    WATCHDOG_SOURCE: WATCHDOG_SOURCE,
    install: function (W) { return __kineticGridBlankWatchdog(W || root); }
  };

  if (typeof module !== "undefined" && module.exports) { module.exports = root[API_KEY + "_MODULE"]; }
})(typeof self !== "undefined" ? self : globalThis);
