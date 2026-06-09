// grid-focus-scroll-fix.js -- MAIN-world focus guard for compacted Kendo virtual grids.
//
// When the density feature compresses grid rows, Kendo can focus recycled <td> elements during wheel
// handling. The browser then scrolls the virtual scroller to keep that recycled focused cell visible,
// which fights the user's wheel gesture and makes the grid bounce back. The density injector runs in
// the isolated world, so it cannot patch Kendo's page-world focus calls directly; this small MAIN-world
// script can. It is inert unless the shared padding-control marker says grid.rowHeight is non-default,
// and it only adds preventScroll during a recent wheel gesture inside a Kendo grid.

(function (root) {
  "use strict";

  var VERSION = "1.0.0";
  var API_KEY = "__KINETIC_GRID_FOCUS_SCROLL_FIX__";
  var MODULE_KEY = API_KEY + "_MODULE";
  var WHEEL_WINDOW_MS = 900;

  function now(W) {
    try {
      return W.performance && typeof W.performance.now === "function" ? W.performance.now() : Date.now();
    } catch (e) {
      return Date.now();
    }
  }

  function parsePaddingMarker(W) {
    try {
      var raw = W.document
        && W.document.documentElement
        && W.document.documentElement.dataset
        ? W.document.documentElement.dataset.kineticPaddingControl
        : "";
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function hasDenseGridRows(W) {
    var marker = parsePaddingMarker(W);
    if (!marker || marker.active !== true || !marker.adjustments || typeof marker.adjustments.length !== "number") {
      return false;
    }
    for (var i = 0; i < marker.adjustments.length; i += 1) {
      var item = marker.adjustments[i];
      if (item
        && item.family === "grid"
        && item.dim === "rowHeight"
        && Math.abs(Number(item.factor) - 1) > 1e-9) {
        return true;
      }
    }
    return false;
  }

  function isGridCell(el) {
    try {
      return !!(el && el.matches && el.matches(
        ".k-grid td.k-table-td, .k-grid th.k-table-th, .k-grid [role='gridcell'], .k-grid [role='columnheader']"
      ));
    } catch (e) {
      return false;
    }
  }

  function closestGrid(el) {
    try {
      return el && el.closest ? el.closest(".k-grid") : null;
    } catch (e) {
      return null;
    }
  }

  function install(W) {
    try {
      if (!W || !W.document || !W.HTMLElement || !W.HTMLElement.prototype) {
        return null;
      }
      if (W[API_KEY] && W[API_KEY].__installed === true) {
        return W[API_KEY];
      }

      var D = W.document;
      var originalFocus = W.HTMLElement.prototype.focus;
      if (typeof originalFocus !== "function") {
        return null;
      }

      var state = {
        __installed: true,
        version: VERSION,
        preventions: 0,
        lastWheelAt: 0,
        lastPreventedAt: 0
      };

      function publish() {
        try {
          W[API_KEY] = api;
          api.version = VERSION;
          api.preventions = state.preventions;
          api.lastWheelAt = state.lastWheelAt;
          api.lastPreventedAt = state.lastPreventedAt;
          api.denseGridRows = hasDenseGridRows(W);
        } catch (e) {
          /* ignore */
        }
      }

      function onWheel(ev) {
        try {
          if (!hasDenseGridRows(W)) {
            return;
          }
          if (ev && ev.target && closestGrid(ev.target)) {
            state.lastWheelAt = now(W);
            publish();
          }
        } catch (e) {
          /* ignore */
        }
      }

      var guardFocus = function kineticGridFocusScrollGuard(options) {
        try {
          var recentWheel = state.lastWheelAt > 0 && (now(W) - state.lastWheelAt) <= WHEEL_WINDOW_MS;
          if (recentWheel && hasDenseGridRows(W) && isGridCell(this)) {
            var nextOptions = {};
            if (options && typeof options === "object") {
              for (var key in options) {
                if (Object.prototype.hasOwnProperty.call(options, key)) {
                  nextOptions[key] = options[key];
                }
              }
            }
            nextOptions.preventScroll = true;
            state.preventions += 1;
            state.lastPreventedAt = now(W);
            publish();
            return originalFocus.call(this, nextOptions);
          }
        } catch (e) {
          /* fall through to native focus */
        }
        return originalFocus.apply(this, arguments);
      };
      W.HTMLElement.prototype.focus = guardFocus;
      W.HTMLElement.prototype.focus.__kineticGridFocusScrollFix = true;

      if (D.addEventListener) {
        D.addEventListener("wheel", onWheel, true);
      }

      var api = {
        __installed: true,
        version: VERSION,
        preventions: state.preventions,
        lastWheelAt: state.lastWheelAt,
        lastPreventedAt: state.lastPreventedAt,
        denseGridRows: false,
        uninstall: function () {
          try {
            if (W.HTMLElement.prototype.focus === guardFocus) {
              W.HTMLElement.prototype.focus = originalFocus;
            }
          } catch (e) {
            /* ignore */
          }
          try {
            if (D.removeEventListener) {
              D.removeEventListener("wheel", onWheel, true);
            }
          } catch (e2) {
            /* ignore */
          }
          api.__installed = false;
        }
      };

      publish();
      return api;
    } catch (e) {
      return null;
    }
  }

  var MODULE = {
    version: VERSION,
    hasDenseGridRows: hasDenseGridRows,
    isGridCell: isGridCell,
    install: install
  };

  root[MODULE_KEY] = MODULE;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = MODULE;
  }

  try {
    install(root);
  } catch (e) {
    /* never throw into the page */
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
