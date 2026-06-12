// column-personalizer.js - ISOLATED-world content script that augments Epicor Kinetic's native
// "Personalize Columns" sliding panel with bulk Show all / Hide all controls. It does not own persistence:
// the native panel still applies changes only through its existing Save / Cancel buttons.

(function (root) {
  "use strict";

  var VERSION = "1.0.0";
  var MARKER_KEY = "__KINETIC_COLUMN_PERSONALIZER__";
  var DATASET_KEY = "kineticColumnPersonalizer";
  var STYLE_ID = "kinetic-column-personalizer-style";
  var ACTIONS_CLASS = "kinetic-column-bulk-actions";
  var BUTTON_CLASS = "kinetic-column-bulk-action";
  var HOST_SUFFIX = ".epicorsaas.com";
  var SCAN_MS = 1500;

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

  function switchChecked(sw) {
    if (!sw) { return false; }
    var aria = sw.getAttribute && sw.getAttribute("aria-checked");
    if (aria === "true") { return true; }
    if (aria === "false") { return false; }
    return !!(sw.classList && sw.classList.contains("k-switch-on"));
  }

  function hasClass(el, cls) {
    if (!el) { return false; }
    if (el.classList && el.classList.contains(cls)) { return true; }
    var name = typeof el.className === "string" ? el.className : "";
    return (" " + name + " ").indexOf(" " + cls + " ") >= 0;
  }

  function switchDisabled(row, sw) {
    if (!sw) { return true; }
    if (sw.getAttribute && (sw.getAttribute("aria-disabled") === "true" || sw.getAttribute("aria-readonly") === "true")) {
      return true;
    }
    if (row && row.getAttribute && row.getAttribute("aria-disabled") === "true") { return true; }
    return hasClass(sw, "k-disabled") || hasClass(row, "k-disabled") || hasClass(row, "ep-disabled");
  }

  function rowLocked(row) {
    if (!row || !row.querySelector) { return false; }
    return !!row.querySelector(".k-svg-i-lock,.mdi-lock,.ep-locked");
  }

  function rowSwitch(row) {
    if (!row || !row.querySelector) { return null; }
    return row.querySelector("kendo-switch[role='switch'],[role='switch'].k-switch,kendo-switch");
  }

  function eligibleSwitches(panel) {
    var out = [];
    if (!panel || !panel.querySelectorAll) { return out; }
    var rows = panel.querySelectorAll(".ep-list-box");
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var sw = rowSwitch(row);
      if (!sw || switchDisabled(row, sw) || rowLocked(row)) { continue; }
      out.push({ row: row, sw: sw });
    }
    return out;
  }

  function clickSwitch(sw) {
    if (!sw || !sw.dispatchEvent) { return false; }
    sw.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: sw.ownerDocument && sw.ownerDocument.defaultView }));
    return true;
  }

  function setAllSwitches(panel, checked) {
    var items = eligibleSwitches(panel);
    var changed = 0;
    for (var i = 0; i < items.length; i += 1) {
      if (switchChecked(items[i].sw) === checked) { continue; }
      if (clickSwitch(items[i].sw)) { changed += 1; }
    }
    return { target: checked === true, total: items.length, changed: changed };
  }

  function panelVisible(panel) {
    if (!panel || !panel.querySelector) { return false; }
    if (!panel.querySelector(".ep-personalize-title") || !panel.querySelector("#btnResetToDefault")) { return false; }
    var box = null;
    try { box = panel.closest(".ep-sidebar,.ep-component-top-element,.ep-sliding-panel"); } catch (e) { box = null; }
    var r = null;
    try { r = (box || panel).getBoundingClientRect(); } catch (eR) { r = null; }
    return !!(r && r.width > 0 && r.height > 0);
  }

  function visiblePanels(D) {
    var panels = D && D.querySelectorAll ? D.querySelectorAll("ep-personalize-columns-panel") : [];
    var out = [];
    for (var i = 0; i < panels.length; i += 1) {
      if (panelVisible(panels[i])) { out.push(panels[i]); }
    }
    // Kinetic can retain prior sliding-panel component instances at the same coordinates after repeated
    // opens. The newest DOM instance is the active one; acting on every retained panel multiplies clicks.
    return out.length > 1 ? [out[out.length - 1]] : out;
  }

  function styleText() {
    return [
      "." + ACTIONS_CLASS + "{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:-4px 12px 8px 0;}",
      "." + BUTTON_CLASS + "{appearance:none;border:0;background:transparent;color:var(--interactive,#0b6f85);font:inherit;font-size:12px;font-weight:600;line-height:1.2;padding:2px 0;cursor:pointer;}",
      "." + BUTTON_CLASS + ":hover{text-decoration:underline;}",
      "." + BUTTON_CLASS + ":focus-visible{outline:2px solid var(--focus,#8a4f7d);outline-offset:2px;border-radius:2px;}"
    ].join("");
  }

  function ensureStyle(D) {
    if (!D || !D.head || D.getElementById(STYLE_ID)) { return; }
    var style = D.createElement("style");
    style.id = STYLE_ID;
    style.textContent = styleText();
    D.head.appendChild(style);
  }

  function button(D, label, target, apply) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = BUTTON_CLASS;
    b.textContent = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      apply(target);
    });
    return b;
  }

  function injectPanel(panel, D, apply) {
    if (!panel || panel.querySelector("." + ACTIONS_CLASS)) { return false; }
    var reset = panel.querySelector("#btnResetToDefault");
    if (!reset || !reset.parentNode) { return false; }
    var wrap = D.createElement("div");
    wrap.className = ACTIONS_CLASS;
    wrap.appendChild(button(D, "Show all columns", true, apply));
    wrap.appendChild(button(D, "Hide all columns", false, apply));
    reset.parentNode.insertBefore(wrap, reset.nextSibling);
    return true;
  }

  function installRuntime(W) {
    try {
      var D = W && W.document;
      if (!D || !D.documentElement || !D.body) { return null; }
      if (W[MARKER_KEY + "_RUNTIME"] && W[MARKER_KEY + "_RUNTIME"].__installed) {
        return W[MARKER_KEY + "_RUNTIME"];
      }

      var observer = null;
      var timer = null;
      var scanTimer = null;
      var lastAction = null;
      var injected = 0;

      function publishMarker() {
        var marker = { version: VERSION, active: true, panels: visiblePanels(D).length, injected: injected, lastAction: lastAction };
        try { D.documentElement.dataset[DATASET_KEY] = JSON.stringify(marker); } catch (e) { /* ignore */ }
        try { W[MARKER_KEY] = marker; } catch (eW) { /* ignore */ }
      }

      function applyBulk(target) {
        var panels = visiblePanels(D);
        var summary = { target: target === true, total: 0, changed: 0 };
        for (var i = 0; i < panels.length; i += 1) {
          var result = setAllSwitches(panels[i], target === true);
          summary.total += result.total;
          summary.changed += result.changed;
        }
        lastAction = summary;
        publishMarker();
      }

      function scan() {
        ensureStyle(D);
        var panels = visiblePanels(D);
        for (var i = 0; i < panels.length; i += 1) {
          if (injectPanel(panels[i], D, applyBulk)) { injected += 1; }
        }
        publishMarker();
      }

      function scheduleScan() {
        if (scanTimer) { return; }
        scanTimer = W.setTimeout(function () {
          scanTimer = null;
          scan();
        }, 80);
      }

      if (W.MutationObserver) {
        observer = new W.MutationObserver(scheduleScan);
        observer.observe(D.body, { childList: true, subtree: true });
      }
      timer = W.setInterval(scan, SCAN_MS);
      scan();

      function uninstall() {
        try {
          if (observer) { observer.disconnect(); }
          if (timer) { W.clearInterval(timer); }
          if (scanTimer) { W.clearTimeout(scanTimer); }
          var style = D.getElementById(STYLE_ID);
          if (style && style.parentNode) { style.parentNode.removeChild(style); }
          var buttons = D.querySelectorAll("." + ACTIONS_CLASS);
          for (var i = 0; i < buttons.length; i += 1) {
            if (buttons[i].parentNode) { buttons[i].parentNode.removeChild(buttons[i]); }
          }
          try { delete D.documentElement.dataset[DATASET_KEY]; } catch (eD) { D.documentElement.dataset[DATASET_KEY] = ""; }
          try { delete W[MARKER_KEY]; } catch (eM) { W[MARKER_KEY] = null; }
          api.__installed = false;
          if (W[MARKER_KEY + "_RUNTIME"] === api) {
            try { delete W[MARKER_KEY + "_RUNTIME"]; } catch (eW) { W[MARKER_KEY + "_RUNTIME"] = null; }
          }
        } catch (e) { /* ignore */ }
      }

      var api = {
        version: VERSION,
        __installed: true,
        scanNow: scan,
        setAll: applyBulk,
        marker: function () {
          try { return JSON.parse(D.documentElement.dataset[DATASET_KEY] || "null"); } catch (e) { return null; }
        },
        uninstall: uninstall
      };
      W[MARKER_KEY + "_RUNTIME"] = api;
      return api;
    } catch (e) { return null; }
  }

  function startRuntime(W) {
    try {
      var cc = chromeOf(W);
      if (cc && cc.storage && cc.storage.local && cc.storage.local.get) {
        cc.storage.local.get({ customHostPatterns: [] }, function (state) {
          if (hostAllowed(W, state)) { installRuntime(W); }
        });
        return;
      }
      if (hostAllowed(W, { customHostPatterns: [] })) { installRuntime(W); }
    } catch (e) { /* ignore */ }
  }

  var MODULE = {
    version: VERSION,
    normalizeHostPatterns: normalizeHostPatterns,
    patternMatchesHost: patternMatchesHost,
    hostAllowed: hostAllowed,
    switchChecked: switchChecked,
    eligibleSwitches: eligibleSwitches,
    visiblePanels: visiblePanels,
    setAllSwitches: setAllSwitches,
    styleText: styleText,
    install: function (W) { return installRuntime(W || root); },
    start: function (W) { return startRuntime(W || root); }
  };

  root[MARKER_KEY + "_MODULE"] = MODULE;
  if (typeof module !== "undefined" && module.exports) { module.exports = MODULE; }

  try {
    if (root && root.document && root.document.documentElement) { startRuntime(root); }
  } catch (e) { /* ignore */ }
})(typeof self !== "undefined" ? self : globalThis);
