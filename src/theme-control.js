// theme-control.js — ISOLATED-world content script that controls the Epicor Kinetic UI theme by
// injecting CSS custom properties, implementing the two additive toggles from the
// kinetic-theme-control-extension plan (00_shared_context.md). It is INDEPENDENT of the grid fixes:
// no debugger, no main.js rewrite, no tab reload, applies LIVE.
//
// INVESTIGATION GROUND TRUTH (§3, captured live 2026-06-05 on both CDP-9100 tabs):
//   Kinetic theming is delivered as an inline `style` attribute on <html> carrying exactly 25 CSS
//   custom properties (the per-tenant HUE ROTATION set). The base stylesheet additionally declares two
//   more success-family tints (--success-4566, --success-3682) that are NOT in the inline attribute and
//   are therefore never tenant-rotated — so the full Epicor theme namespace is 27 tokens / 10 families
//   (CDP-9100 census 2026-06-05). The "stock" value of every token comes from the base stylesheet and is
//   identical across tenants; theming keeps each token's designed saturation & lightness. An `!important`
//   `html{--token:val}` stylesheet rule beats the inline (non-important) theme value, and removing the
//   rule restores the page EXACTLY (accentChanged + revertedOk proven). So both features are pure
//   CSS-variable injection:
//     - DISABLE-THEMING   = pin all 27 tokens to their stock values with !important (the 2 base-only
//                           success tints are pinned as a harmless no-op; the 25 rotated tokens revert).
//     - COLOR-OVERRIDE    = pin chosen families to user-derived values with !important (overriding the
//                           success family now rotates all 4 variants, not just 2 — closes the tint gap).
//
// CONTRACTS (00_shared_context.md, authoritative — referenced by number):
//   §4.1 storage keys: themeDisableEnabled (bool), colorOverrideEnabled (bool), colorOverrideValues (map).
//   §4.2 TOKENS table + derivation (the shared source of truth; encoded once below).
//   §4.3 injected <style id="kinetic-theme-control"> contract: html{ --token:val !important; } rules,
//        last in <head>; build order disable-block then override-block (later wins); "" => remove element.
//   §4.4 status marker { version, active, themeDisabled, colorOverride, families, tokensPinned, reasserts }.
//   §4.5 color util signatures (frozen contract for Track D's unit tests).
//   §4.6 delivery: ISOLATED world; live storage.onChanged reactivity; marker exposed for the popup via
//        document.documentElement.dataset.kineticThemeControl (popup reads it in MAIN world).
//
// CONTRACT NOTE (T_A_01 / §4.2 worked example): the §4.2 doc states #1a73e8 = hsl(214,84%,51%), but the
//   standard hex->HSL conversion (the §4.5 "clamp + round" rule, and what Chrome DevTools reports) yields
//   s = 206/252 = 0.8175 => 82%, NOT 84%. hexToHsl is mathematically correct (returns s:82); the derived
//   primary set is therefore hsl(214,82%,...). Flagged for Track D in plans/TASKS.md so the suite asserts
//   82%. Only the saturation digit differs from the doc; hue/lightness/structure match exactly.
//
// HYGIENE: explicit semicolons; fail-safe (never throws into the page); idempotent (per-window
//   install guard + single element id); observers/timers registered for teardown; bounded loops. The pure
//   color util has no DOM / no chrome.* and is dual-exported for headless unit tests.

(function (root) {
  "use strict";

  var VERSION = "3.6.0";                             // tracks the extension version (§4.4 marker.version)
  var STYLE_ID = "kinetic-theme-control";
  var MARKER_KEY = "__KINETIC_THEME_CONTROL__";
  var DATASET_KEY = "kineticThemeControl";          // -> attribute data-kinetic-theme-control (§4.6)
  var HOST_SUFFIX = ".epicorsaas.com";              // only theme Epicor SaaS origins (Safety)
  var DERIVE_MODE = "literal-base";                 // §4.2 default; alternates "hue-only" / "hue-sat"
  var STORAGE_KEYS = ["themeDisableEnabled", "colorOverrideEnabled", "colorOverrideValues",
    "neutralTintEnabled", "neutralTintHex", "customHostPatterns"];

  // ---------------------------------------------------------------------------------------------------
  // §4.2 — TOKENS: the single source of truth. base [s,l] + family stock H; variants suffix->[s,l].
  // Order matches the §4.2 stock-CSS block verbatim so stockBlock() reproduces it exactly. stockBlock()
  // and deriveFamily() both read this — change a value here and both follow.
  // ---------------------------------------------------------------------------------------------------
  var TOKENS = [
    { key: "primary", label: "Primary", base: "--primary", h: 192, s: 96, l: 20, variants: [
      { suffix: "-2485", s: 24, l: 85 }, { suffix: "-2491", s: 24, l: 91 },
      { suffix: "-3468", s: 34, l: 68 }, { suffix: "-3495", s: 34, l: 95 }
    ] },
    { key: "secondary", label: "Secondary", base: "--secondary", h: 199, s: 89, l: 18, variants: [] },
    { key: "tertiary", label: "Tertiary", base: "--tertiary", h: 154, s: 42, l: 69, variants: [] },
    { key: "accent", label: "Accent (tiles)", base: "--accent", h: 19, s: 97, l: 81, variants: [] },
    { key: "base", label: "Surface/Base", base: "--base", h: 206, s: 26, l: 95, variants: [] },
    { key: "interactive", label: "Interactive (links)", base: "--interactive", h: 201, s: 85, l: 34, variants: [
      { suffix: "-24", s: 85, l: 24 }, { suffix: "-44", s: 85, l: 44 }, { suffix: "-54", s: 85, l: 54 },
      { suffix: "-82", s: 85, l: 82 }, { suffix: "-x96", s: 100, l: 96 }
    ] },
    { key: "focus", label: "Focus", base: "--focus", h: 323, s: 32, l: 57, variants: [] },
    { key: "error", label: "Error", base: "--error", h: 7, s: 100, l: 71, variants: [
      { suffix: "-50", s: 100, l: 50 }, { suffix: "-91", s: 100, l: 91 }
    ] },
    { key: "success", label: "Success", base: "--success", h: 172, s: 43, l: 52, variants: [
      { suffix: "-9532", s: 95, l: 32 }, { suffix: "-4566", s: 45, l: 66 },
      { suffix: "-3682", s: 36, l: 82 }, { suffix: "-x96", s: 100, l: 96 }
    ] },
    { key: "warning", label: "Warning", base: "--warning", h: 44, s: 100, l: 80, variants: [
      { suffix: "-41", s: 100, l: 41 }, { suffix: "-91", s: 100, l: 91 }
    ] }
  ];

  var FAMILY_BY_KEY = {};
  (function indexFamilies() {
    for (var i = 0; i < TOKENS.length; i += 1) { FAMILY_BY_KEY[TOKENS[i].key] = TOKENS[i]; }
  })();

  // ---------------------------------------------------------------------------------------------------
  // NEUTRAL ramp (optional surface-tint feature, ext v3.6.0). The 7 Epicor grayscale tokens — each is
  // pure gray hsl(0,0%,L) with L = the suffix number (base --neutral = white, L100). They are NOT brand
  // tokens and are never tenant-rotated (CDP-9100 census 2026-06-05). The neutral-tint feature injects a
  // user-picked HUE + SATURATION into all 7 while PRESERVING each token's stock LIGHTNESS — so contrast
  // ratios (which depend on lightness) are unchanged and text/surfaces stay legible. The ramp drives the
  // bulk of on-screen gray: --neutral-80 (borders/dividers/icons) + --neutral-95 (surfaces) ≈ 87% of all
  // neutral color instances. Deep TEXT grays (Kendo/Bootstrap --kendo-color-on-app-surface, --bs-gray-*)
  // are intentionally OUT of this set — recoloring body text is a readability risk left to a future opt-in.
  // ---------------------------------------------------------------------------------------------------
  var NEUTRAL_TOKENS = [
    { base: "--neutral", l: 100 }, { base: "--neutral-95", l: 95 }, { base: "--neutral-80", l: 80 },
    { base: "--neutral-52", l: 52 }, { base: "--neutral-38", l: 38 }, { base: "--neutral-27", l: 27 },
    { base: "--neutral-20", l: 20 }
  ];

  // ===================================================================================================
  // §4.5 — Pure color util (no DOM, no chrome.*; deterministic round/clamp). Exported for unit tests.
  // ===================================================================================================

  function clampNum(n, lo, hi) {
    n = Number(n);
    if (isNaN(n)) { return lo; }
    if (n < lo) { return lo; }
    if (n > hi) { return hi; }
    return n;
  }

  function normHue(h) {
    h = Math.round(Number(h));
    if (isNaN(h)) { return 0; }
    h = h % 360;
    if (h < 0) { h += 360; }
    return h;
  }

  // hsl(H,S%,L%) with integer percents and NO space after comma (§4.5 — matches how tests assert).
  function hslStr(h, s, l) {
    return "hsl(" + normHue(h) + "," + Math.round(clampNum(s, 0, 100)) + "%," + Math.round(clampNum(l, 0, 100)) + "%)";
  }

  // Accepts "#rrggbb", "#rgb", or the same without the leading "#". Hex digits only.
  function isValidHex(v) {
    if (typeof v !== "string") { return false; }
    var s = v.charAt(0) === "#" ? v.slice(1) : v;
    if (s.length !== 3 && s.length !== 6) { return false; }
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charAt(i).toLowerCase();
      var ok = (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
      if (!ok) { return false; }
    }
    return true;
  }

  // hexToHsl -> { h:0-360 int, s:0-100 int, l:0-100 int } (clamp + round). null on invalid input.
  function hexToHsl(hex) {
    if (!isValidHex(hex)) { return null; }
    var s = hex.charAt(0) === "#" ? hex.slice(1) : hex;
    if (s.length === 3) {
      s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    }
    var r = parseInt(s.slice(0, 2), 16) / 255;
    var g = parseInt(s.slice(2, 4), 16) / 255;
    var b = parseInt(s.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var delta = max - min;
    var l = (max + min) / 2;
    var h = 0;
    var sat = 0;
    if (delta !== 0) {
      sat = delta / (1 - Math.abs(2 * l - 1));
      if (max === r) {
        h = ((g - b) / delta) % 6;
      } else if (max === g) {
        h = (b - r) / delta + 2;
      } else {
        h = (r - g) / delta + 4;
      }
      h *= 60;
    }
    return { h: normHue(h), s: Math.round(clampNum(sat * 100, 0, 100)), l: Math.round(clampNum(l * 100, 0, 100)) };
  }

  // hslToHex -> "#rrggbb" (for the popup's stock/derived swatch display).
  function hslToHex(hsl) {
    var h = normHue(hsl && hsl.h);
    var s = clampNum(hsl && hsl.s, 0, 100) / 100;
    var l = clampNum(hsl && hsl.l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return "#" + toHex2(r + m) + toHex2(g + m) + toHex2(b + m);
  }

  function toHex2(channel01) {
    var n = Math.round(clampNum(channel01 * 255, 0, 255));
    var hx = n.toString(16);
    if (hx.length < 2) { hx = "0" + hx; }
    return hx;
  }

  // Resolve one token's (h,s,l) for a given derive mode. isBase distinguishes the base token from a
  // variant. stockS/stockL are the token's own stock values (§4.2); p* are the picked color's HSL.
  //   literal-base (default): base = picked (H,S,L); variant = (pickedH, pickedS, variantStockL).
  //   hue-only               : every token = (pickedH, stockS, stockL) — purest native-faithful.
  //   hue-sat                : every token = (pickedH, pickedS, stockL) — base also at stock L.
  function deriveToken(mode, isBase, stockS, stockL, ph, ps, pl) {
    if (mode === "hue-only") { return [ph, stockS, stockL]; }
    if (mode === "hue-sat") { return [ph, ps, stockL]; }
    return [ph, ps, isBase ? pl : stockL];
  }

  // deriveFamily(familyKey, hex, mode) -> { "--token": "hsl(...)", ... } per §4.2. {} on bad key/hex.
  function deriveFamily(familyKey, hex, mode) {
    mode = mode || DERIVE_MODE;
    var fam = FAMILY_BY_KEY[familyKey];
    if (!fam) { return {}; }
    var hsl = hexToHsl(hex);
    if (!hsl) { return {}; }
    var out = {};
    var baseHsl = deriveToken(mode, true, fam.s, fam.l, hsl.h, hsl.s, hsl.l);
    out[fam.base] = hslStr(baseHsl[0], baseHsl[1], baseHsl[2]);
    for (var i = 0; i < fam.variants.length; i += 1) {
      var v = fam.variants[i];
      var vHsl = deriveToken(mode, false, v.s, v.l, hsl.h, hsl.s, hsl.l);
      out[fam.base + v.suffix] = hslStr(vHsl[0], vHsl[1], vHsl[2]);
    }
    return out;
  }

  // deriveNeutral(hex) -> { "--neutral": "hsl(h,s,100%)", ... } for all 7 ramp tokens. Injects the picked
  // color's HUE + SATURATION while KEEPING each token's stock LIGHTNESS (contrast-preserving). {} on bad hex.
  function deriveNeutral(hex) {
    var hsl = hexToHsl(hex);
    if (!hsl) { return {}; }
    var out = {};
    for (var i = 0; i < NEUTRAL_TOKENS.length; i += 1) {
      var t = NEUTRAL_TOKENS[i];
      out[t.base] = hslStr(hsl.h, hsl.s, t.l);
    }
    return out;
  }

  // stockBlock() -> the full §4.2 stock rule "html{ --token:stock !important; ... }" (one place).
  function stockBlock() {
    var decls = "";
    for (var i = 0; i < TOKENS.length; i += 1) {
      var f = TOKENS[i];
      decls += f.base + ":" + hslStr(f.h, f.s, f.l) + " !important;";
      for (var j = 0; j < f.variants.length; j += 1) {
        var v = f.variants[j];
        decls += f.base + v.suffix + ":" + hslStr(f.h, v.s, v.l) + " !important;";
      }
    }
    return "html{" + decls + "}";
  }

  // ===================================================================================================
  // §4.3 — buildCss(state) -> string. Pure (state -> string). Disable block first, then override block
  // (later wins on ties). Returns "" when neither contributes (caller removes the <style>).
  // ===================================================================================================

  function normalizeState(v) {
    v = (v && typeof v === "object") ? v : {};
    var vals = (v.colorOverrideValues && typeof v.colorOverrideValues === "object") ? v.colorOverrideValues : {};
    return {
      themeDisableEnabled: v.themeDisableEnabled === true,
      colorOverrideEnabled: v.colorOverrideEnabled === true,
      colorOverrideValues: vals,
      neutralTintEnabled: v.neutralTintEnabled === true,
      neutralTintHex: (typeof v.neutralTintHex === "string") ? v.neutralTintHex : "",
      customHostPatterns: normalizeHostPatterns(v.customHostPatterns)
    };
  }

  // Neutral tint contributes only when its toggle is on AND a valid hex is set (v3.6.0).
  function neutralActive(state) {
    return !!(state && state.neutralTintEnabled === true && isValidHex(state.neutralTintHex));
  }

  // Count of injected neutral --token declarations (marker.neutralTokensPinned). Kept SEPARATE from the
  // theme countTokens so the existing tokensPinned semantics (the 27 brand tokens) are unchanged.
  function countNeutral(state) {
    return neutralActive(state) ? NEUTRAL_TOKENS.length : 0;
  }

  // Families that actually contribute an override rule: override toggle on AND a valid hex present.
  // Returned in TOKENS order so the marker's `families` list is deterministic.
  function validFamilies(state) {
    var out = [];
    if (!state || state.colorOverrideEnabled !== true) { return out; }
    var vals = (state.colorOverrideValues && typeof state.colorOverrideValues === "object") ? state.colorOverrideValues : {};
    for (var i = 0; i < TOKENS.length; i += 1) {
      var key = TOKENS[i].key;
      if (Object.prototype.hasOwnProperty.call(vals, key) && isValidHex(vals[key])) { out.push(key); }
    }
    return out;
  }

  // Count of injected --token declarations (§4.4 tokensPinned). Disable contributes 27; each overridden
  // family contributes 1 + its variant count. Declarations are counted with duplicates (both-on re-pins).
  function countTokens(state) {
    var n = 0;
    if (state && state.themeDisableEnabled === true) {
      for (var i = 0; i < TOKENS.length; i += 1) { n += 1 + TOKENS[i].variants.length; }
    }
    var fams = validFamilies(state);
    for (var j = 0; j < fams.length; j += 1) { n += 1 + FAMILY_BY_KEY[fams[j]].variants.length; }
    return n;
  }

  function buildCss(rawState) {
    var state = normalizeState(rawState);
    var parts = [];
    if (state.themeDisableEnabled) { parts.push(stockBlock()); }
    var fams = validFamilies(state);
    if (fams.length) {
      var decls = "";
      for (var i = 0; i < fams.length; i += 1) {
        var map = deriveFamily(fams[i], state.colorOverrideValues[fams[i]], DERIVE_MODE);
        var names = Object.keys(map);
        for (var j = 0; j < names.length; j += 1) {
          decls += names[j] + ":" + map[names[j]] + " !important;";
        }
      }
      if (decls) { parts.push("html{" + decls + "}"); }
    }
    // Neutral-tint block last (disjoint token set from disable/override, so order is immaterial; kept last
    // for readability). Pins the 7 --neutral-* ramp tokens to the picked hue+sat at their stock lightness.
    if (neutralActive(state)) {
      var nmap = deriveNeutral(state.neutralTintHex);
      var ndecls = "";
      var nnames = Object.keys(nmap);
      for (var k = 0; k < nnames.length; k += 1) { ndecls += nnames[k] + ":" + nmap[nnames[k]] + " !important;"; }
      if (ndecls) { parts.push("html{" + ndecls + "}"); }
    }
    return parts.join("");
  }

  // ===================================================================================================
  // Runtime (DOM + chrome.storage). ISOLATED world only. Fully inert when both toggles are OFF.
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

  // Cheap relevance filter for the MutationObserver: re-assert only when our <style> was removed or the
  // <head> churns (so we can re-append last) — not on page-wide SPA churn. Bounded loops.
  function isRelevant(muts) {
    try {
      for (var i = 0; i < muts.length; i += 1) {
        var m = muts[i];
        var t = m.target;
        if (t && t.nodeType === 1 && t.nodeName === "HEAD") { return true; }
        var added = m.addedNodes;
        if (added && added.length) {
          for (var j = 0; j < added.length && j < 16; j += 1) {
            var a = added[j];
            var an = a ? a.nodeName : "";
            if (an === "HEAD" || an === "BODY" || an === "STYLE" || an === "LINK") { return true; }
          }
        }
        var removed = m.removedNodes;
        if (removed && removed.length) {
          for (var r = 0; r < removed.length && r < 16; r += 1) {
            var rn = removed[r];
            if (rn && (rn.id === STYLE_ID || rn.nodeName === "HEAD")) { return true; }
          }
        }
      }
    } catch (e) { return true; }       // on any doubt, allow the re-assert
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
      var state = normalizeState(null);
      var currentCss = "";
      var reasserts = 0;
      var observers = [];
      var timers = [];
      var refreshTimer = null;
      var reassertTimer = null;
      var storageListener = null;
      var pendingReady = null;

      function publishMarker() {
        try {
          var fams = validFamilies(state);
          var themeDisabled = state.themeDisableEnabled === true;
          var colorOverride = state.colorOverrideEnabled === true;
          var neutral = neutralActive(state);
          var marker = {
            version: VERSION,
            active: themeDisabled || (colorOverride && fams.length > 0) || neutral,
            themeDisabled: themeDisabled,
            colorOverride: colorOverride,
            neutralTint: neutral,
            families: fams,
            tokensPinned: countTokens(state),
            neutralTokensPinned: countNeutral(state),
            reasserts: reasserts
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
          if (D.documentElement && D.documentElement.dataset) {
            delete D.documentElement.dataset[DATASET_KEY];
          }
        } catch (e) { /* ignore */ }
      }

      // §4.3 idempotent applier: one #kinetic-theme-control element, last in <head>; "" removes it.
      function ensureStyle(css) {
        try {
          var el = D.getElementById(STYLE_ID);
          if (!css) {
            if (el && el.parentNode) { el.parentNode.removeChild(el); }
            return;
          }
          var head = D.head || (D.getElementsByTagName ? D.getElementsByTagName("head")[0] : null) || D.documentElement;
          if (!head) { return; }
          if (!el) {
            el = D.createElement("style");
            el.id = STYLE_ID;
            el.setAttribute("data-kinetic-grid-fix", "theme-control");
          }
          if (el.textContent !== css) { el.textContent = css; }
          // Keep it LAST in <head> so its !important rules win source-order ties against later CSS.
          if (el.parentNode !== head || head.lastChild !== el) { head.appendChild(el); reasserts += 1; }
        } catch (e) { /* ignore */ }
      }

      // Rebuild CSS from current state and apply (used at boot + on storage change).
      function apply() {
        try {
          if (!hostAllowed(W, state)) {
            currentCss = "";
            ensureStyle("");
            clearMarker();
            return;
          }
          currentCss = buildCss(state);
          ensureStyle(currentCss);
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      // DOM-only re-assert using the cached CSS (SPA re-mount / head churn) — no storage read.
      function reassert() {
        try {
          ensureStyle(currentCss);
          publishMarker();
        } catch (e) { /* ignore */ }
      }

      function readAndApply() {
        try {
          var c = chromeOf(W);
          if (!c || !c.storage || !c.storage.local || !c.storage.local.get) { apply(); return; }
          c.storage.local.get(STORAGE_KEYS, function (v) {
            try { state = normalizeState(v); } catch (eN) { state = normalizeState(null); }
            apply();
          });
        } catch (e) { apply(); }
      }

      // Debounced live refresh (re-read storage + rebuild) — keeps a dragged color picker from thrashing.
      function scheduleRefresh() {
        if (refreshTimer) { W.clearTimeout(refreshTimer); }
        refreshTimer = W.setTimeout(function () { refreshTimer = null; readAndApply(); }, 90);
      }

      function scheduleReassert() {
        if (reassertTimer) { W.clearTimeout(reassertTimer); }
        reassertTimer = W.setTimeout(function () { reassertTimer = null; reassert(); }, 80);
      }

      // 1) Initial state at document_start.
      readAndApply();

      // 2) Live reactivity: rebuild immediately when our storage keys change (§4.6).
      try {
        var cc = chromeOf(W);
        if (cc && cc.storage && cc.storage.onChanged && cc.storage.onChanged.addListener) {
          var onChanged = function (changes, area) {
            try {
              if (area !== "local" || !changes) { return; }
              if (changes.themeDisableEnabled || changes.colorOverrideEnabled || changes.colorOverrideValues ||
                  changes.neutralTintEnabled || changes.neutralTintHex || changes.customHostPatterns) {
                scheduleRefresh();
              }
            } catch (e) { /* ignore */ }
          };
          cc.storage.onChanged.addListener(onChanged);
          storageListener = { target: cc.storage.onChanged, fn: onChanged };
        }
      } catch (e) { /* ignore */ }

      // 3) SPA re-assert: filtered MutationObserver (our element removed / <head> churn) — debounced.
      try {
        var MO = W.MutationObserver;
        var watchRoot = D.documentElement || D.body;
        if (MO && watchRoot) {
          var obs = new MO(function (muts) { if (isRelevant(muts)) { scheduleReassert(); } });
          obs.observe(watchRoot, { childList: true, subtree: true });
          observers.push(obs);
        }
      } catch (e) { /* ignore */ }

      // 4) Low-frequency safety re-assert (covers no-mutation re-mounts + late <head> at document_start).
      try {
        var iv = W.setInterval(function () { reassert(); }, 2000);
        timers.push(iv);
      } catch (e) { /* ignore */ }

      // 5) Prompt re-assert once the document finishes parsing (so we land last in <head> quickly).
      try {
        if (D.readyState === "loading" && D.addEventListener) {
          pendingReady = function () { try { reassert(); } catch (eR) { /* ignore */ } };
          D.addEventListener("DOMContentLoaded", pendingReady, { once: true });
        }
      } catch (e) { /* ignore */ }

      function uninstall() {
        try {
          for (var i = 0; i < observers.length; i += 1) { try { observers[i].disconnect(); } catch (eO) { /* ignore */ } }
          for (var j = 0; j < timers.length; j += 1) { try { W.clearInterval(timers[j]); } catch (eT) { /* ignore */ } }
          if (refreshTimer) { try { W.clearTimeout(refreshTimer); } catch (eR) { /* ignore */ } }
          if (reassertTimer) { try { W.clearTimeout(reassertTimer); } catch (eA) { /* ignore */ } }
          if (storageListener && storageListener.target && storageListener.target.removeListener) {
            try { storageListener.target.removeListener(storageListener.fn); } catch (eS) { /* ignore */ }
          }
          if (pendingReady && D.removeEventListener) {
            try { D.removeEventListener("DOMContentLoaded", pendingReady); } catch (eD) { /* ignore */ }
          }
          var el = D.getElementById(STYLE_ID);
          if (el && el.parentNode) { el.parentNode.removeChild(el); }
          try {
            if (D.documentElement && D.documentElement.dataset) { delete D.documentElement.dataset[DATASET_KEY]; }
          } catch (eX) { /* ignore */ }
          api.__installed = false;
          if (W[MARKER_KEY + "_RUNTIME"] === api) {
            try { delete W[MARKER_KEY + "_RUNTIME"]; } catch (eW) { W[MARKER_KEY + "_RUNTIME"] = null; }
          }
        } catch (e) { /* ignore */ }
      }

      var api = {
        version: VERSION,
        __installed: true,
        apply: function () { readAndApply(); },
        reassert: reassert,
        css: function () { return currentCss; },
        state: function () { return normalizeState(state); },
        marker: function () {
          try { return JSON.parse(D.documentElement.dataset[DATASET_KEY] || "null"); } catch (e) { return null; }
        },
        reasserts: function () { return reasserts; },
        uninstall: uninstall
      };
      W[MARKER_KEY + "_RUNTIME"] = api;
      return api;
    } catch (e) { return null; }
  }

  // ===================================================================================================
  // Exports + auto-boot.
  // ===================================================================================================

  var MODULE = {
    version: VERSION,
    TOKENS: TOKENS,
    NEUTRAL_TOKENS: NEUTRAL_TOKENS,
    DERIVE_MODE: DERIVE_MODE,
    isValidHex: isValidHex,
    hexToHsl: hexToHsl,
    hslToHex: hslToHex,
    hslStr: hslStr,
    deriveToken: deriveToken,
    deriveFamily: deriveFamily,
    deriveNeutral: deriveNeutral,
    stockBlock: stockBlock,
    normalizeState: normalizeState,
    validFamilies: validFamilies,
    neutralActive: neutralActive,
    countTokens: countTokens,
    countNeutral: countNeutral,
    buildCss: buildCss,
    install: installRuntime
  };

  // Dual export (mirrors grid-checkbox-style-fix.js): global for vm-based tests + CommonJS guard.
  root[MARKER_KEY + "_MODULE"] = MODULE;
  if (typeof module !== "undefined" && module.exports) { module.exports = MODULE; }

  // Auto-boot only as a real content script (a browser page with chrome.storage). Inert under Node tests
  // (no document / no chrome -> no boot), so the pure util can be imported headlessly.
  try {
    if (root && root.document && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      installRuntime(root);
    }
  } catch (e) { /* never throw into the page */ }
})(typeof self !== "undefined" ? self : globalThis);
