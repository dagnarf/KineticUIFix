(function () {
  "use strict";

  // Storage schema. gridFix* drive the debugger/runtime grid fixes (unchanged). theme* drive the
  // ISOLATED-world theme injector (src/theme-control.js) and apply LIVE with no reload (§4.1).
  var DEFAULTS = {
    gridFixEnabled: false,
    gridFixScope: "kinetic-only",
    gridFixMode: "runtime",
    // Bigger virtual scroll buffer — baked into the same patched bundle as the grid fix (reload-gated).
    gridScrollBufferEnabled: false,
    themeDisableEnabled: false,
    colorOverrideEnabled: false,
    colorOverrideValues: {},
    neutralTintEnabled: false,
    neutralTintHex: "",
    componentDensity: {},
    textAreaAutoSizeEnabled: false,
    fullWidthEnabled: false,
    // gridAutoSizeEnabled drives the ISOLATED-world auto-size-columns injector (src/grid-autofit.js) and
    // applies LIVE with no reload, same delivery class as theme*/componentDensity. gridAutoFitDensity is the
    // companion "Column spacing" slider — a factor in [0.5,1.5] (1 = native-faithful fit, lower = denser).
    gridAutoSizeEnabled: false,
    gridAutoFitDensity: 1,
    // gridHeaderWrapEnabled drives the ISOLATED-world header-wrap injector (src/grid-header-wrap.js): it
    // line-wraps grid header titles + narrows header-bound columns, live with no reload. Same delivery class
    // as gridAutoSizeEnabled; pairs with it (auto-size owns widths when both are on).
    gridHeaderWrapEnabled: false,
    customHostPatterns: []
  };

  // Bounds for the auto-fit density slider (mirror grid-autofit.js DENSITY_MIN/MAX/DEF; lockstep asserted by
  // the popup-logic test).
  var AUTOFIT_DENSITY_MIN = 0.5;
  var AUTOFIT_DENSITY_MAX = 1.5;
  var AUTOFIT_DENSITY_DEF = 1;

  // Default neutral tint shown when the user first enables the surface-tint control with nothing stored:
  // a soft slate blue-gray (low saturation) so enabling it produces a tasteful, legible effect, not a jolt.
  var NEUTRAL_DEFAULT_HEX = "#5b7088";

  // =================================================================================================
  // Pure helpers (no DOM / no chrome.*). Exported below for Track D's headless tests. The FAMILIES
  // list + base stock HSL mirror §4.2 (the single source of truth; Track A keeps the runtime copy in
  // TOKENS — "shared in spirit"). Labels/keys/order are verbatim so Track A & D stay in lockstep.
  // =================================================================================================
  var FAMILIES = [
    { key: "primary", label: "Primary", h: 192, s: 96, l: 20 },
    { key: "secondary", label: "Secondary", h: 199, s: 89, l: 18 },
    { key: "tertiary", label: "Tertiary", h: 154, s: 42, l: 69 },
    { key: "accent", label: "Accent (tiles)", h: 19, s: 97, l: 81 },
    { key: "base", label: "Surface/Base", h: 206, s: 26, l: 95 },
    { key: "interactive", label: "Interactive (links)", h: 201, s: 85, l: 34 },
    { key: "focus", label: "Focus", h: 323, s: 32, l: 57 },
    { key: "error", label: "Error", h: 7, s: 100, l: 71 },
    { key: "success", label: "Success", h: 172, s: 43, l: 52 },
    { key: "warning", label: "Warning", h: 44, s: 100, l: 80 }
  ];

  var FAMILY_BY_KEY = {};
  (function indexFamilies() {
    for (var i = 0; i < FAMILIES.length; i += 1) {
      FAMILY_BY_KEY[FAMILIES[i].key] = FAMILIES[i];
    }
  })();

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

  function toHex2(channel01) {
    var n = Math.round(clampNum(channel01 * 255, 0, 255));
    var hx = n.toString(16);
    if (hx.length < 2) { hx = "0" + hx; }
    return hx;
  }

  // hslToHex({h,s,l}) -> "#rrggbb" — mirror of §4.5 / Track A, used for stock swatch display.
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

  // Canonicalize any valid hex to lowercase "#rrggbb" (color inputs require the 6-digit form). null if invalid.
  function normHex(v) {
    if (!isValidHex(v)) { return null; }
    var s = (v.charAt(0) === "#" ? v.slice(1) : v).toLowerCase();
    if (s.length === 3) {
      s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    }
    return "#" + s;
  }

  // Stock base color of a family as a "#rrggbb" (for the swatch default before the user picks).
  function stockHex(key) {
    var f = FAMILY_BY_KEY[key];
    if (!f) { return "#000000"; }
    return hslToHex({ h: f.h, s: f.s, l: f.l });
  }

  function cloneValues(obj) {
    var out = {};
    if (obj && typeof obj === "object") {
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) { out[k] = obj[k]; }
      }
    }
    return out;
  }

  // Read-modify-write/delete reducer for colorOverrideValues (§4.1). Returns a NEW object: a valid hex
  // sets familyKey -> canonical hex; null/invalid deletes it. Unknown family keys are ignored.
  function nextOverrideValues(prev, key, hexOrNull) {
    var out = cloneValues(prev);
    if (!FAMILY_BY_KEY[key]) { return out; }
    var nh = (hexOrNull === null || hexOrNull === undefined) ? null : normHex(hexOrNull);
    if (nh) { out[key] = nh; } else { delete out[key]; }
    return out;
  }

  // Neutral surface-tint contributes only when enabled AND a valid hex is set (mirrors the engine's
  // neutralActive). Pure; used by the status helpers below.
  function neutralActiveSS(ss) {
    return !!(ss && ss.neutralTintEnabled === true && isValidHex(ss.neutralTintHex));
  }

  // Count families that actually contribute an override (known family + valid hex).
  function countOverrides(values) {
    var n = 0;
    if (values && typeof values === "object") {
      for (var k in values) {
        if (Object.prototype.hasOwnProperty.call(values, k) && FAMILY_BY_KEY[k] && isValidHex(values[k])) {
          n += 1;
        }
      }
    }
    return n;
  }

  // Status-line text from the §4.4 marker (preferred) or, off-Kinetic / when the marker is absent, the
  // storage-derived intent. Track D may assert on this; keep it pure.
  function themeStatusText(marker, storeState) {
    if (marker && typeof marker === "object") {
      if (marker.themeDisabled === true) { return "Disabled — stock palette"; }
      var fams = Array.isArray(marker.families) ? marker.families.length : 0;
      if (marker.colorOverride === true && fams > 0) {
        return "Custom — " + fams + (fams === 1 ? " family" : " families");
      }
      if (marker.neutralTint === true) { return "Surface tint"; }
      return "Native (no changes)";
    }
    var ss = storeState || {};
    if (ss.themeDisableEnabled === true) { return "Disabled — applies on a Kinetic tab"; }
    var n = countOverrides(ss.colorOverrideValues);
    if (ss.colorOverrideEnabled === true && n > 0) {
      return "Custom (" + n + ") — applies on a Kinetic tab";
    }
    if (neutralActiveSS(ss)) { return "Surface tint — applies on a Kinetic tab"; }
    return "Native (no changes)";
  }

  function isThemeActive(marker, storeState) {
    if (marker && typeof marker === "object") {
      var fams = Array.isArray(marker.families) ? marker.families.length : 0;
      return marker.themeDisabled === true || (marker.colorOverride === true && fams > 0) || marker.neutralTint === true;
    }
    var ss = storeState || {};
    return ss.themeDisableEnabled === true ||
      (ss.colorOverrideEnabled === true && countOverrides(ss.colorOverrideValues) > 0) ||
      neutralActiveSS(ss);
  }

  // =================================================================================================
  // Density / padding controls (src/padding-control.js). FAMILIES_PAD mirrors the engine's family
  // key/label + per-dimension key/label/min/max/step/def verbatim (lockstep, asserted by the
  // popup-logic test). Helpers are pure (no DOM / no chrome.*) and dual-exported for headless tests.
  // =================================================================================================
  var FAMILIES_PAD = [
    { key: "grid", label: "Grids", dims: [
      { key: "rowHeight", label: "Row height", min: 0.6, max: 1.8, step: 0.05, def: 1 },
      { key: "cellPad", label: "Cell padding", min: 0.3, max: 2, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.5, step: 0.05, def: 1 }
    ] },
    { key: "button", label: "Buttons", dims: [
      { key: "padding", label: "Padding", min: 0.5, max: 2, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.6, step: 0.05, def: 1 }
    ] },
    { key: "textbox", label: "Text fields", dims: [
      { key: "height", label: "Field height", min: 0.7, max: 1.6, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.6, step: 0.05, def: 1 },
      { key: "padding", label: "Inner padding", min: 0.2, max: 1.5, step: 0.05, def: 1 }
    ] },
    { key: "dropdown", label: "Dropdowns", dims: [
      { key: "height", label: "Field height", min: 0.7, max: 1.6, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.6, step: 0.05, def: 1 },
      { key: "padding", label: "Inner padding", min: 0.2, max: 1.5, step: 0.05, def: 1 }
    ] },
    { key: "page", label: "Page chrome", dims: [
      { key: "header", label: "Header height", min: 0.6, max: 1.5, step: 0.05, def: 1 },
      { key: "title", label: "Title size", min: 0.75, max: 1.2, step: 0.05, def: 1 }
    ] },
    { key: "tabs", label: "Tabs", dims: [
      { key: "padding", label: "Padding", min: 0.4, max: 2, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.5, step: 0.05, def: 1 }
    ] },
    { key: "label", label: "Field labels", dims: [
      { key: "font", label: "Text size", min: 0.8, max: 1.6, step: 0.05, def: 1 }
    ] },
    { key: "tag", label: "Tags & options", dims: [
      { key: "height", label: "Tag height", min: 0.65, max: 1.4, step: 0.05, def: 1 },
      { key: "padding", label: "Tag padding", min: 0.2, max: 1.5, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.4, step: 0.05, def: 1 }
    ] },
    { key: "card", label: "Cards & layout", dims: [
      { key: "gutter", label: "Column gutter", min: 0.1, max: 1.5, step: 0.05, def: 1 },
      { key: "cardPad", label: "Card padding", min: 0, max: 1.5, step: 0.05, def: 1 },
      { key: "header", label: "Header height", min: 0.8, max: 1.5, step: 0.05, def: 1 },
      { key: "fieldGap", label: "Field spacing", min: 0, max: 1.5, step: 0.05, def: 1 }
    ] },
    { key: "tree", label: "Navigation tree", dims: [
      { key: "itemPad", label: "Item spacing", min: 0.1, max: 1.5, step: 0.05, def: 1 },
      { key: "font", label: "Text size", min: 0.8, max: 1.6, step: 0.05, def: 1 }
    ] }
  ];

  var PAD_DIM_BY_KEY = {};
  (function indexPadFamilies() {
    for (var i = 0; i < FAMILIES_PAD.length; i += 1) {
      PAD_DIM_BY_KEY[FAMILIES_PAD[i].key] = {};
      for (var j = 0; j < FAMILIES_PAD[i].dims.length; j += 1) {
        PAD_DIM_BY_KEY[FAMILIES_PAD[i].key][FAMILIES_PAD[i].dims[j].key] = FAMILIES_PAD[i].dims[j];
      }
    }
  })();

  var FACTOR_EPS = 1e-9;

  function clampFactor(famKey, dimKey, factor) {
    var d = PAD_DIM_BY_KEY[famKey] ? PAD_DIM_BY_KEY[famKey][dimKey] : null;
    if (!d) { return null; }
    var n = Number(factor);
    if (isNaN(n)) { return null; }
    if (n < d.min) { n = d.min; }
    if (n > d.max) { n = d.max; }
    return n;
  }

  function isDefaultFactor(famKey, dimKey, factor) {
    var d = PAD_DIM_BY_KEY[famKey] ? PAD_DIM_BY_KEY[famKey][dimKey] : null;
    if (!d) { return false; }
    var n = Number(factor);
    if (isNaN(n)) { return false; }
    return Math.abs(n - d.def) <= FACTOR_EPS;
  }

  // factorPct(1) -> "100%". The slider's value readout label.
  function factorPct(factor) {
    return Math.round(Number(factor) * 100) + "%";
  }

  // Immutable read-modify-write/delete reducer for componentDensity (nested {fam:{dim:factor}}). A
  // non-default clamped factor sets fam.dim -> factor; null/invalid/at-default deletes it (and prunes an
  // empty family map), so storage only ever holds real adjustments. Unknown family/dim keys are ignored.
  function nextComponentDensity(prev, famKey, dimKey, factorOrNull) {
    var out = {};
    if (prev && typeof prev === "object") {
      for (var k in prev) {
        if (!Object.prototype.hasOwnProperty.call(prev, k)) { continue; }
        out[k] = {};
        if (prev[k] && typeof prev[k] === "object") {
          for (var pd in prev[k]) { if (Object.prototype.hasOwnProperty.call(prev[k], pd)) { out[k][pd] = prev[k][pd]; } }
        }
      }
    }
    if (!PAD_DIM_BY_KEY[famKey] || !PAD_DIM_BY_KEY[famKey][dimKey]) { return out; }
    if (!out[famKey] || typeof out[famKey] !== "object") { out[famKey] = {}; }
    var remove = (factorOrNull === null || factorOrNull === undefined);
    if (!remove) {
      var f = clampFactor(famKey, dimKey, factorOrNull);
      if (f === null || isDefaultFactor(famKey, dimKey, f)) { remove = true; } else { out[famKey][dimKey] = f; }
    }
    if (remove) { delete out[famKey][dimKey]; }
    var hasAny = false;
    for (var rk in out[famKey]) { if (Object.prototype.hasOwnProperty.call(out[famKey], rk)) { hasAny = true; break; } }
    if (!hasAny) { delete out[famKey]; }
    return out;
  }

  // Build a full componentDensity map with every known dimension pinned to one extreme — "min" drives
  // every slider to its floor, "max" to its ceiling. A dimension whose extreme equals its default is
  // omitted (storage only ever holds real adjustments, mirroring nextComponentDensity's pruning).
  function componentDensityPreset(extreme) {
    var out = {};
    var wantMax = extreme === "max";
    for (var i = 0; i < FAMILIES_PAD.length; i += 1) {
      var fam = FAMILIES_PAD[i];
      for (var j = 0; j < fam.dims.length; j += 1) {
        var dim = fam.dims[j];
        var f = wantMax ? dim.max : dim.min;
        if (isDefaultFactor(fam.key, dim.key, f)) { continue; }
        if (!out[fam.key]) { out[fam.key] = {}; }
        out[fam.key][dim.key] = f;
      }
    }
    return out;
  }

  // Count dimensions across all families that actually contribute (known + non-default clamped factor).
  function countComponentAdjustments(values) {
    var n = 0;
    if (values && typeof values === "object") {
      for (var k in values) {
        if (!Object.prototype.hasOwnProperty.call(values, k) || !values[k] || typeof values[k] !== "object") { continue; }
        for (var d in values[k]) {
          if (!Object.prototype.hasOwnProperty.call(values[k], d)) { continue; }
          if (PAD_DIM_BY_KEY[k] && PAD_DIM_BY_KEY[k][d] && !isDefaultFactor(k, d, values[k][d]) && clampFactor(k, d, values[k][d]) !== null) { n += 1; }
        }
      }
    }
    return n;
  }

  // Status text from the padding marker (preferred) or, off-Kinetic / marker-absent, storage intent.
  function densityStatusText(marker, storeState) {
    if (marker && typeof marker === "object") {
      var adj = Array.isArray(marker.adjustments) ? marker.adjustments.length : 0;
      var textAuto = marker.textAreaAutoSize === true;
      var fullWidth = marker.fullWidth === true;
      var suffix = (fullWidth ? " + full width" : "") + (textAuto ? " + text areas" : "");
      if (marker.active === true && adj > 0) {
        return "Custom — " + adj + (adj === 1 ? " adjustment" : " adjustments") + suffix;
      }
      if (fullWidth) { return textAuto ? "Full width + text areas" : "Full width"; }
      if (textAuto) { return "Text areas auto-size"; }
      return "Default spacing";
    }
    var ss = storeState || {};
    var n = countComponentAdjustments(ss.componentDensity);
    var storeSuffix = (ss.fullWidthEnabled === true ? " + full width" : "") + (ss.textAreaAutoSizeEnabled === true ? " + text areas" : "");
    if (n > 0) { return "Custom (" + n + ")" + storeSuffix + " — applies on a Kinetic tab"; }
    if (ss.fullWidthEnabled === true) { return (ss.textAreaAutoSizeEnabled === true ? "Full width + text areas" : "Full width") + " — applies on a Kinetic tab"; }
    if (ss.textAreaAutoSizeEnabled === true) { return "Text areas auto-size — applies on a Kinetic tab"; }
    return "Default spacing";
  }

  function isDensityActive(marker, storeState) {
    if (marker && typeof marker === "object") {
      var adj = Array.isArray(marker.adjustments) ? marker.adjustments.length : 0;
      return (marker.active === true && adj > 0) || marker.textAreaAutoSize === true || marker.fullWidth === true;
    }
    var ss = storeState || {};
    return countComponentAdjustments(ss.componentDensity) > 0 || ss.textAreaAutoSizeEnabled === true || ss.fullWidthEnabled === true;
  }

  function hostLabelFromPattern(pattern) {
    var m = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(pattern || "");
    return m ? m[2] : "";
  }

  function hostMatchesPattern(hostname, pattern) {
    var host = (hostname || "").toLowerCase();
    var allowed = hostLabelFromPattern(pattern).toLowerCase();
    if (!host || !allowed) { return false; }
    if (allowed.indexOf("*.") === 0) {
      var suffix = allowed.slice(2);
      return host === suffix || host.lastIndexOf("." + suffix) === host.length - suffix.length - 1;
    }
    return host === allowed;
  }

  function patternIsValid(pattern) {
    return /^(\*|https?):\/\/(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+\/\*$/.test(pattern || "");
  }

  function validHostName(host) {
    if (typeof host !== "string") { return false; }
    if (!host || host.length > 253 || host.indexOf("..") >= 0) { return false; }
    var labels = host.split(".");
    for (var i = 0; i < labels.length; i += 1) {
      var label = labels[i];
      if (!label || label.length > 63) { return false; }
      if (label.charAt(0) === "-" || label.charAt(label.length - 1) === "-") { return false; }
      for (var j = 0; j < label.length; j += 1) {
        var c = label.charAt(j);
        var ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-";
        if (!ok) { return false; }
      }
    }
    return true;
  }

  function normalizeHostInput(raw) {
    var input = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!input) { return { ok: false, error: "Enter a domain." }; }
    input = input.replace(/^@+/, "");
    var wildcard = false;
    var host = input;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(input)) {
        var parsed = new URL(input);
        host = parsed.hostname || "";
      } else {
        host = input.split("/")[0].split("?")[0].split("#")[0];
      }
    } catch (eUrl) {
      return { ok: false, error: "Enter a valid domain." };
    }
    if (host.indexOf(":") >= 0) { host = host.split(":")[0]; }
    if (host.indexOf("*.") === 0) {
      wildcard = true;
      host = host.slice(2);
    } else if (host.charAt(0) === ".") {
      wildcard = true;
      host = host.slice(1);
    }
    if (host.indexOf("*") >= 0) {
      return { ok: false, error: "Use *.example.com for subdomains." };
    }
    if (!validHostName(host)) {
      return { ok: false, error: "Enter a valid domain." };
    }
    var patterns = wildcard
      ? ["*://" + host + "/*", "*://*." + host + "/*"]
      : ["*://" + host + "/*"];
    return { ok: true, host: host, wildcard: wildcard, patterns: patterns };
  }

  function normalizedPatternList(value) {
    var out = [];
    var seen = {};
    if (!Array.isArray(value)) { return out; }
    for (var i = 0; i < value.length; i += 1) {
      var pattern = typeof value[i] === "string" ? value[i].toLowerCase() : "";
      if (!pattern || seen[pattern] || !patternIsValid(pattern) || pattern === "*://*.epicorsaas.com/*") { continue; }
      seen[pattern] = true;
      out.push(pattern);
    }
    return out;
  }

  function mergeHostPatterns(existing, additions) {
    return normalizedPatternList(normalizedPatternList(existing).concat(additions || []));
  }

  function isSupportedTabUrl(url, customPatterns) {
    try {
      var parsed = new URL(url);
      var h = parsed.hostname.toLowerCase();
      if (h === "epicorsaas.com" || h.lastIndexOf(".epicorsaas.com") === h.length - ".epicorsaas.com".length) {
        return true;
      }
      var patterns = normalizedPatternList(customPatterns);
      for (var i = 0; i < patterns.length; i += 1) {
        if (hostMatchesPattern(h, patterns[i])) { return true; }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // Expose pure helpers for headless tests (Track D, T_D_04). Mirrors theme-control.js's dual export.
  var POPUP_LOGIC = {
    FAMILIES: FAMILIES,
    hslToHex: hslToHex,
    isValidHex: isValidHex,
    normHex: normHex,
    stockHex: stockHex,
    nextOverrideValues: nextOverrideValues,
    countOverrides: countOverrides,
    neutralActiveSS: neutralActiveSS,
    NEUTRAL_DEFAULT_HEX: NEUTRAL_DEFAULT_HEX,
    themeStatusText: themeStatusText,
    isThemeActive: isThemeActive,
    FAMILIES_PAD: FAMILIES_PAD,
    AUTOFIT_DENSITY_MIN: AUTOFIT_DENSITY_MIN,
    AUTOFIT_DENSITY_MAX: AUTOFIT_DENSITY_MAX,
    AUTOFIT_DENSITY_DEF: AUTOFIT_DENSITY_DEF,
    clampFactor: clampFactor,
    isDefaultFactor: isDefaultFactor,
    factorPct: factorPct,
    nextComponentDensity: nextComponentDensity,
    componentDensityPreset: componentDensityPreset,
    countComponentAdjustments: countComponentAdjustments,
    densityStatusText: densityStatusText,
    isDensityActive: isDensityActive,
    normalizeHostInput: normalizeHostInput,
    normalizedPatternList: normalizedPatternList,
    mergeHostPatterns: mergeHostPatterns,
    hostLabelFromPattern: hostLabelFromPattern,
    isSupportedTabUrl: isSupportedTabUrl
  };
  try {
    (typeof self !== "undefined" ? self : globalThis).__KINETIC_POPUP_LOGIC__ = POPUP_LOGIC;
  } catch (e) { /* ignore */ }
  if (typeof module !== "undefined" && module.exports) { module.exports = POPUP_LOGIC; }

  // =================================================================================================
  // DOM wiring. Element refs are resolved in init() (so the pure helpers above import cleanly with no
  // DOM). New (theme) elements are null-guarded so the existing minimal-DOM test harness keeps passing.
  // =================================================================================================
  var toggle, toggleState, applyHint, modeSelect, modeNote, scopeSelect;
  var stApplied, stMode, stBundle, stAnchors, stNote, versionEl;
  var scrollBufferToggle, scrollBufferState;
  var autofitToggle, autofitState;
  var autofitDensitySlider, autofitDensityPct, autofitDensityReset;
  var headerWrapToggle, headerWrapState;
  var themeDisableToggle, themeDisableState, colorOverrideToggle, colorOverrideState;
  var colorPanel, colorRows, colorFooter, resetAllBtn, themeStatusEl;
  var neutralSwatch, neutralHexLabel, neutralReset;
  var fullWidthToggle, fullWidthState;
  var textAreaAutoSizeToggle, textAreaAutoSizeState;
  var padRows, padResetAll, padPresetMin, padPresetMax, paddingStatusEl;
  var customHostInput, customHostAdd, customHostList, customHostNote;

  var lastEnabled = DEFAULTS.gridFixEnabled;
  var lastScrollBuffer = DEFAULTS.gridScrollBufferEnabled;
  var lastAutofit = DEFAULTS.gridAutoSizeEnabled;
  var lastAutofitDensity = DEFAULTS.gridAutoFitDensity;
  var lastHeaderWrap = DEFAULTS.gridHeaderWrapEnabled;
  var lastThemeDisable = DEFAULTS.themeDisableEnabled;
  var lastColorOverride = DEFAULTS.colorOverrideEnabled;
  var lastNeutralTint = DEFAULTS.neutralTintEnabled;
  var lastFullWidth = DEFAULTS.fullWidthEnabled;
  var lastTextAreaAutoSize = DEFAULTS.textAreaAutoSizeEnabled;
  var neutralHex = "";
  var overrideValues = {};
  var swatchInputs = {};
  var hexLabels = {};
  var componentDensity = {};
  var customHostPatterns = [];
  var sliderInputs = {};      // keyed by "famKey.dimKey"
  var sliderPctLabels = {};   // keyed by "famKey.dimKey"
  var writeTimer = null;
  var pendingWrites = {};
  var themeStatusTimer = null;
  var paddingStatusTimer = null;

  function manifestVersion() {
    try {
      return chrome.runtime.getManifest().version || "";
    } catch (e) {
      return "";
    }
  }

  // ---- Grid-fix controls (unchanged behavior) ----------------------------------------------------

  function reflectEnabled(enabled) {
    lastEnabled = enabled === true;
    toggle.setAttribute("aria-checked", lastEnabled ? "true" : "false");
    toggleState.textContent = lastEnabled ? "On" : "Off";
    toggleState.className = "toggle-state " + (lastEnabled ? "state-on" : "state-off");
  }

  function reflectMode(mode) {
    var value = mode === "runtime" ? "runtime" : "debugger";
    modeSelect.value = value;
    if (value === "debugger") {
      modeNote.textContent =
        "Requests Chrome debugger permission for the validated main.js rewrite. Chrome shows a debugging banner while ON.";
    } else {
      modeNote.textContent =
        "Runtime hook injects at document_start with no debugger permission. Bundle text is not rewritten in this mode.";
    }
  }

  function reflectScope(scope) {
    scopeSelect.value = scope === "all" ? "all" : "kinetic-only";
  }

  // Debounced storage write. Merges pending keys so a toggle + a color write within the debounce window
  // don't clobber each other (the old single-object form was last-write-wins).
  function persist(updates) {
    for (var k in updates) {
      if (Object.prototype.hasOwnProperty.call(updates, k)) { pendingWrites[k] = updates[k]; }
    }
    if (writeTimer) { clearTimeout(writeTimer); }
    writeTimer = setTimeout(function () {
      writeTimer = null;
      var batch = pendingWrites;
      pendingWrites = {};
      chrome.storage.local.set(batch);
    }, 120);
  }

  function onToggle() {
    var next = !lastEnabled;
    reflectEnabled(next);
    applyHint.hidden = false;
    persist({ gridFixEnabled: next });
  }

  // ---- Bigger scroll buffer (baked into the grid-fix bundle; reload-gated) ------------------------

  function reflectScrollBuffer(on) {
    lastScrollBuffer = on === true;
    if (scrollBufferToggle) {
      scrollBufferToggle.setAttribute("aria-checked", lastScrollBuffer ? "true" : "false");
    }
    if (scrollBufferState) {
      scrollBufferState.textContent = lastScrollBuffer ? "On" : "Off";
      scrollBufferState.className = "toggle-state " + (lastScrollBuffer ? "state-on" : "state-off");
    }
  }

  function onScrollBufferToggle() {
    var next = !lastScrollBuffer;
    reflectScrollBuffer(next);
    applyHint.hidden = false; // rides the patched bundle -> needs a Kinetic-tab reload to apply
    persist({ gridScrollBufferEnabled: next });
  }

  // ---- Auto-size columns (live ISOLATED injector; no reload) --------------------------------------

  function reflectAutofit(on) {
    lastAutofit = on === true;
    if (autofitToggle) {
      autofitToggle.setAttribute("aria-checked", lastAutofit ? "true" : "false");
    }
    if (autofitState) {
      autofitState.textContent = lastAutofit ? "On" : "Off";
      autofitState.className = "toggle-state " + (lastAutofit ? "state-on" : "state-off");
    }
  }

  function onAutofitToggle() {
    var next = !lastAutofit;
    reflectAutofit(next);
    // Applies live on a Kinetic tab — no reload hint (unlike the debugger-delivered grid fixes).
    persist({ gridAutoSizeEnabled: next });
  }

  // Column density slider — scales the spacing the auto-fit injector adds around content + the per-column
  // max cap. A factor in [0.5,1.5]; 1 = native-faithful fit. Re-uses factorPct for the % readout.
  function clampAutofitDensity(v) {
    return clampNum(v, AUTOFIT_DENSITY_MIN, AUTOFIT_DENSITY_MAX);
  }

  function reflectAutofitDensity(v) {
    lastAutofitDensity = clampAutofitDensity(v);
    if (autofitDensitySlider) { autofitDensitySlider.value = String(lastAutofitDensity); }
    if (autofitDensityPct) { autofitDensityPct.textContent = factorPct(lastAutofitDensity); }
  }

  function onAutofitDensityInput(value) {
    lastAutofitDensity = clampAutofitDensity(value);
    if (autofitDensityPct) { autofitDensityPct.textContent = factorPct(lastAutofitDensity); }
    persist({ gridAutoFitDensity: lastAutofitDensity });
  }

  function onAutofitDensityReset() {
    reflectAutofitDensity(AUTOFIT_DENSITY_DEF);
    persist({ gridAutoFitDensity: AUTOFIT_DENSITY_DEF });
  }

  // Wrap column headers — line-wraps multi-word grid header titles so they stack vertically and narrows the
  // columns whose width was only dictated by a long one-line header. Live ISOLATED injector, no reload.
  function reflectHeaderWrap(on) {
    lastHeaderWrap = on === true;
    if (headerWrapToggle) {
      headerWrapToggle.setAttribute("aria-checked", lastHeaderWrap ? "true" : "false");
    }
    if (headerWrapState) {
      headerWrapState.textContent = lastHeaderWrap ? "On" : "Off";
      headerWrapState.className = "toggle-state " + (lastHeaderWrap ? "state-on" : "state-off");
    }
  }

  function onHeaderWrapToggle() {
    var next = !lastHeaderWrap;
    reflectHeaderWrap(next);
    // Applies live on a Kinetic tab — no reload hint.
    persist({ gridHeaderWrapEnabled: next });
  }

  // ---- Theme controls (new) ----------------------------------------------------------------------

  function reflectThemeDisable(on) {
    lastThemeDisable = on === true;
    if (themeDisableToggle) {
      themeDisableToggle.setAttribute("aria-checked", lastThemeDisable ? "true" : "false");
    }
    if (themeDisableState) {
      themeDisableState.textContent = lastThemeDisable ? "On" : "Off";
      themeDisableState.className = "toggle-state " + (lastThemeDisable ? "state-on" : "state-off");
    }
  }

  function reflectColorOverride(on) {
    lastColorOverride = on === true;
    // Surface/neutral tint now lives behind this same toggle (v3.6.0): keep its enable flag in lockstep so
    // the engine's neutralActive gate (which still keys off neutralTintEnabled) follows the override switch.
    lastNeutralTint = lastColorOverride;
    if (colorOverrideToggle) {
      colorOverrideToggle.setAttribute("aria-checked", lastColorOverride ? "true" : "false");
    }
    if (colorOverrideState) {
      colorOverrideState.textContent = lastColorOverride ? "On" : "Off";
      colorOverrideState.className = "toggle-state " + (lastColorOverride ? "state-on" : "state-off");
    }
    updateColorPanelVisibility();
  }

  // The whole color panel (family rows + neutral tint + Reset-all footer) is revealed by the override toggle.
  function updateColorPanelVisibility() {
    if (colorPanel) {
      colorPanel.hidden = !lastColorOverride;
      colorPanel.setAttribute("aria-hidden", lastColorOverride ? "false" : "true");
    }
  }

  // Build one picker row per family. Skipped cleanly when createElement/appendChild are unavailable
  // (the headless test harness), so the existing grid tests don't need a richer DOM stub.
  function buildColorRows() {
    if (!colorRows || typeof document.createElement !== "function" ||
        typeof colorRows.appendChild !== "function") {
      return;
    }
    if (colorRows.__built === true) { return; }
    colorRows.__built = true;
    for (var i = 0; i < FAMILIES.length; i += 1) {
      bindColorRow(FAMILIES[i]);
    }
  }

  function bindColorRow(fam) {
    var row = document.createElement("div");
    row.className = "clr-row";

    var label = document.createElement("label");
    label.setAttribute("for", "clr-" + fam.key);
    label.textContent = fam.label;

    var input = document.createElement("input");
    input.type = "color";
    input.id = "clr-" + fam.key;
    input.className = "clr-swatch";
    input.setAttribute("aria-label", fam.label + " color");

    var hex = document.createElement("code");
    hex.className = "clr-hex";
    hex.id = "hex-" + fam.key;

    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "clr-reset";
    reset.textContent = "Reset";
    reset.setAttribute("data-key", fam.key);
    reset.setAttribute("aria-label", "Reset " + fam.label + " to stock");

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(hex);
    row.appendChild(reset);
    colorRows.appendChild(row);

    swatchInputs[fam.key] = input;
    hexLabels[fam.key] = hex;

    // input: live hex label + state + debounced persist -> injector previews live as the user drags
    // (§4.6). change: same, plus refresh the marker readout after the pick commits.
    input.addEventListener("input", function () { onColorPicked(fam.key, input.value, true); });
    input.addEventListener("change", function () { onColorPicked(fam.key, input.value, false); });
    reset.addEventListener("click", function () { onColorReset(fam.key); });
  }

  // Set a swatch input + hex label programmatically (hydrate / reset). Not called during a live drag.
  function setSwatch(key, hex) {
    var val = normHex(hex) || stockHex(key);
    if (swatchInputs[key]) { swatchInputs[key].value = val; }
    if (hexLabels[key]) { hexLabels[key].textContent = val.toUpperCase(); }
  }

  function setHexLabel(key, hex) {
    var nh = normHex(hex);
    if (hexLabels[key] && nh) { hexLabels[key].textContent = nh.toUpperCase(); }
  }

  function hydrateSwatches() {
    for (var i = 0; i < FAMILIES.length; i += 1) {
      var key = FAMILIES[i].key;
      var stored = overrideValues[key];
      setSwatch(key, isValidHex(stored) ? stored : stockHex(key));
    }
  }

  function onColorPicked(key, value, live) {
    var nh = normHex(value);
    if (!nh) { return; }
    setHexLabel(key, nh);
    overrideValues = nextOverrideValues(overrideValues, key, nh);
    persist({ colorOverrideValues: overrideValues });
    if (!live) { refreshThemeStatusSoon(); }
  }

  function onColorReset(key) {
    overrideValues = nextOverrideValues(overrideValues, key, null);
    setSwatch(key, stockHex(key));
    persist({ colorOverrideValues: overrideValues });
    refreshThemeStatusSoon();
  }

  // "Reset all to stock" clears every family override AND the surface/neutral tint (they share this panel).
  function onResetAll() {
    overrideValues = {};
    hydrateSwatches();
    neutralHex = "";
    setNeutralSwatch(NEUTRAL_DEFAULT_HEX);
    persist({ colorOverrideValues: {}, neutralTintHex: "" });
    refreshThemeStatusSoon();
  }

  function onThemeDisableToggle() {
    var next = !lastThemeDisable;
    reflectThemeDisable(next);
    persist({ themeDisableEnabled: next });
    refreshThemeStatusSoon();
  }

  function onColorOverrideToggle() {
    var next = !lastColorOverride;
    reflectColorOverride(next);
    // neutralTintEnabled rides this toggle now; the tint stays inert until a neutral color is actually picked.
    persist({ colorOverrideEnabled: next, neutralTintEnabled: next });
    refreshThemeStatusSoon();
  }

  // ---- Neutral / surface tint control (v3.6.0; folded under the Override-colors toggle) -----------

  function setNeutralSwatch(hex) {
    var val = normHex(hex) || NEUTRAL_DEFAULT_HEX;
    if (neutralSwatch) { neutralSwatch.value = val; }
    if (neutralHexLabel) { neutralHexLabel.textContent = val.toUpperCase(); }
  }

  function onNeutralPicked(value, live) {
    var nh = normHex(value);
    if (!nh) { return; }
    neutralHex = nh;
    if (neutralHexLabel) { neutralHexLabel.textContent = nh.toUpperCase(); }
    persist({ neutralTintHex: nh });
    if (!live) { refreshThemeStatusSoon(); }
  }

  function onNeutralReset() {
    neutralHex = "";
    setNeutralSwatch(NEUTRAL_DEFAULT_HEX);
    persist({ neutralTintHex: "" });
    refreshThemeStatusSoon();
  }

  // ---- Density / padding controls (per component family) ------------------------------------------

  function reflectFullWidth(on) {
    lastFullWidth = on === true;
    if (fullWidthToggle) {
      fullWidthToggle.setAttribute("aria-checked", lastFullWidth ? "true" : "false");
    }
    if (fullWidthState) {
      fullWidthState.textContent = lastFullWidth ? "On" : "Off";
      fullWidthState.className = "toggle-state " + (lastFullWidth ? "state-on" : "state-off");
    }
  }

  function onFullWidthToggle() {
    var next = !lastFullWidth;
    reflectFullWidth(next);
    persist({ fullWidthEnabled: next });
    refreshPaddingStatusSoon();
  }

  function reflectTextAreaAutoSize(on) {
    lastTextAreaAutoSize = on === true;
    if (textAreaAutoSizeToggle) {
      textAreaAutoSizeToggle.setAttribute("aria-checked", lastTextAreaAutoSize ? "true" : "false");
    }
    if (textAreaAutoSizeState) {
      textAreaAutoSizeState.textContent = lastTextAreaAutoSize ? "On" : "Off";
      textAreaAutoSizeState.className = "toggle-state " + (lastTextAreaAutoSize ? "state-on" : "state-off");
    }
  }

  function onTextAreaAutoSizeToggle() {
    var next = !lastTextAreaAutoSize;
    reflectTextAreaAutoSize(next);
    persist({ textAreaAutoSizeEnabled: next });
    refreshPaddingStatusSoon();
  }

  // Build a group per family, each with one slider row per dimension. Skipped cleanly when
  // createElement/appendChild are unavailable (the headless test harness), so minimal-DOM tests pass.
  function buildSliderRows() {
    if (!padRows || typeof document.createElement !== "function" ||
        typeof padRows.appendChild !== "function") {
      return;
    }
    if (padRows.__built === true) { return; }
    padRows.__built = true;
    for (var i = 0; i < FAMILIES_PAD.length; i += 1) {
      bindFamilyGroup(FAMILIES_PAD[i]);
    }
  }

  function bindFamilyGroup(fam) {
    var group = document.createElement("div");
    group.className = "pad-group";
    var head = document.createElement("div");
    head.className = "pad-group-head";
    head.textContent = fam.label;
    group.appendChild(head);
    for (var i = 0; i < fam.dims.length; i += 1) { bindSliderRow(group, fam, fam.dims[i]); }
    padRows.appendChild(group);
  }

  function bindSliderRow(group, fam, dim) {
    var id = fam.key + "-" + dim.key;
    var ck = fam.key + "." + dim.key;      // composite key into sliderInputs / sliderPctLabels
    var row = document.createElement("div");
    row.className = "pad-row";

    var label = document.createElement("label");
    label.setAttribute("for", "pad-" + id);
    label.textContent = dim.label;

    var input = document.createElement("input");
    input.type = "range";
    input.id = "pad-" + id;
    input.className = "pad-slider";
    input.min = String(dim.min);
    input.max = String(dim.max);
    input.step = String(dim.step);
    input.value = String(dim.def);
    input.setAttribute("aria-label", fam.label + " " + dim.label + " scale");

    var pct = document.createElement("code");
    pct.className = "pad-pct";
    pct.id = "padpct-" + id;
    pct.textContent = factorPct(dim.def);

    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "clr-reset";
    reset.textContent = "Reset";
    reset.setAttribute("aria-label", "Reset " + fam.label + " " + dim.label + " to default");

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(pct);
    row.appendChild(reset);
    group.appendChild(row);

    sliderInputs[ck] = input;
    sliderPctLabels[ck] = pct;

    // input: live % readout + debounced persist -> injector previews live as the user drags.
    // change: same, plus refresh the marker readout once the drag commits.
    input.addEventListener("input", function () { onSliderInput(fam.key, dim.key, input.value, true); });
    input.addEventListener("change", function () { onSliderInput(fam.key, dim.key, input.value, false); });
    reset.addEventListener("click", function () { onSliderReset(fam.key, dim.key); });
  }

  // Set a slider input + % label programmatically (hydrate / reset). Not called during a live drag.
  function setSlider(famKey, dimKey, factor) {
    var ck = famKey + "." + dimKey;
    var d = PAD_DIM_BY_KEY[famKey] ? PAD_DIM_BY_KEY[famKey][dimKey] : null;
    var f = clampFactor(famKey, dimKey, factor);
    if (f === null) { f = d ? d.def : 1; }
    if (sliderInputs[ck]) { sliderInputs[ck].value = String(f); }
    if (sliderPctLabels[ck]) { sliderPctLabels[ck].textContent = factorPct(f); }
  }

  function hydrateSliders() {
    for (var i = 0; i < FAMILIES_PAD.length; i += 1) {
      var fam = FAMILIES_PAD[i];
      var famVals = (componentDensity && componentDensity[fam.key]) ? componentDensity[fam.key] : {};
      for (var j = 0; j < fam.dims.length; j += 1) {
        var dim = fam.dims[j];
        var stored = famVals[dim.key];
        setSlider(fam.key, dim.key, (stored === undefined || stored === null) ? dim.def : stored);
      }
    }
  }

  function onSliderInput(famKey, dimKey, value, live) {
    var f = clampFactor(famKey, dimKey, value);
    if (f === null) { return; }
    var ck = famKey + "." + dimKey;
    if (sliderPctLabels[ck]) { sliderPctLabels[ck].textContent = factorPct(f); }
    componentDensity = nextComponentDensity(componentDensity, famKey, dimKey, f);
    persist({ componentDensity: componentDensity });
    if (!live) { refreshPaddingStatusSoon(); }
  }

  function onSliderReset(famKey, dimKey) {
    componentDensity = nextComponentDensity(componentDensity, famKey, dimKey, null);
    var d = PAD_DIM_BY_KEY[famKey] ? PAD_DIM_BY_KEY[famKey][dimKey] : null;
    setSlider(famKey, dimKey, d ? d.def : 1);
    persist({ componentDensity: componentDensity });
    refreshPaddingStatusSoon();
  }

  function onPadResetAll() {
    componentDensity = {};
    hydrateSliders();
    persist({ componentDensity: {} });
    refreshPaddingStatusSoon();
  }

  // Min / Max presets: pin every slider across all families to its floor / ceiling in one click.
  function onPadPreset(extreme) {
    componentDensity = componentDensityPreset(extreme);
    hydrateSliders();
    persist({ componentDensity: componentDensity });
    refreshPaddingStatusSoon();
  }

  // ---- Additional host controls ------------------------------------------------------------------

  function setHostNote(message, isError) {
    if (!customHostNote) { return; }
    customHostNote.textContent = message || "";
    customHostNote.className = "adv-note host-note" + (isError ? " host-error" : "");
  }

  function renderCustomHosts() {
    if (!customHostList || typeof document.createElement !== "function") { return; }
    customHostList.textContent = "";
    var patterns = normalizedPatternList(customHostPatterns);
    if (patterns.length === 0) {
      var empty = document.createElement("li");
      empty.className = "host-empty";
      empty.textContent = "No additional hosts";
      customHostList.appendChild(empty);
      return;
    }
    for (var i = 0; i < patterns.length; i += 1) {
      (function (pattern) {
        var item = document.createElement("li");
        item.className = "host-item";
        var code = document.createElement("code");
        code.textContent = hostLabelFromPattern(pattern) || pattern;
        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "host-remove";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", "Remove " + code.textContent);
        remove.addEventListener("click", function () { onRemoveCustomHost(pattern); });
        item.appendChild(code);
        item.appendChild(remove);
        customHostList.appendChild(item);
      })(patterns[i]);
    }
  }

  function requestHostPermission(patterns, callback) {
    if (!chrome.permissions || !chrome.permissions.request) {
      callback(false);
      return;
    }
    chrome.permissions.request({ origins: patterns }, function (granted) {
      if (chrome.runtime.lastError) {
        callback(false);
        return;
      }
      callback(granted === true);
    });
  }

  function onAddCustomHost() {
    var parsed = normalizeHostInput(customHostInput ? customHostInput.value : "");
    if (!parsed.ok) {
      setHostNote(parsed.error, true);
      return;
    }
    requestHostPermission(parsed.patterns, function (granted) {
      if (!granted) {
        setHostNote("Chrome did not grant that host.", true);
        return;
      }
      customHostPatterns = mergeHostPatterns(customHostPatterns, parsed.patterns);
      if (customHostInput) { customHostInput.value = ""; }
      renderCustomHosts();
      setHostNote("Host added. Reload matching tabs to apply grid fixes.", false);
      persist({ customHostPatterns: customHostPatterns });
    });
  }

  function onRemoveCustomHost(pattern) {
    var next = [];
    for (var i = 0; i < customHostPatterns.length; i += 1) {
      if (customHostPatterns[i] !== pattern) { next.push(customHostPatterns[i]); }
    }
    customHostPatterns = normalizedPatternList(next);
    renderCustomHosts();
    setHostNote("Host removed.", false);
    persist({ customHostPatterns: customHostPatterns });
  }

  // ---- Grid status readout (unchanged) -----------------------------------------------------------

  function setStatusUnknown(message) {
    stApplied.textContent = "—";
    stApplied.className = "";
    stMode.textContent = "—";
    stBundle.textContent = "—";
    stAnchors.textContent = "—";
    stNote.textContent = message || "";
  }

  function renderMarker(marker) {
    if (!marker) {
      stApplied.textContent = "No";
      stApplied.className = "no";
      stMode.textContent = "—";
      stBundle.textContent = "—";
      stAnchors.textContent = "—";
      stNote.textContent = lastEnabled
        ? "Patch is ON but not applied on this tab yet — reload the Kinetic tab."
        : "Patch is OFF, so the page is unmodified (expected).";
      return;
    }
    var applied = marker.applied === true;
    stApplied.textContent = applied ? "Yes" : "No";
    stApplied.className = applied ? "ok" : "no";
    stMode.textContent = marker.mode || "—";
    stBundle.textContent = marker.bundleHash || "—";
    stAnchors.textContent =
      Array.isArray(marker.anchorsHit) && marker.anchorsHit.length
        ? marker.anchorsHit.join(", ")
        : "—";
    stNote.textContent = "";
  }

  function readMarkerFromActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id || !tab.url || !isSupportedTabUrl(tab.url, customHostPatterns)) {
        setStatusUnknown("Open a supported Kinetic tab to see patch status.");
        return;
      }
      if (!chrome.scripting || !chrome.scripting.executeScript) {
        setStatusUnknown("Status readout unavailable in this Chrome build.");
        return;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          world: "MAIN",
          func: function () {
            return window.__KINETIC_GRID_FIX__ || null;
          }
        },
        function (results) {
          if (chrome.runtime.lastError) {
            setStatusUnknown("Could not read this tab (try reloading it).");
            return;
          }
          renderMarker(results && results[0] ? results[0].result : null);
        }
      );
    });
  }

  // ---- Theme status readout (§4.4 / §4.6) --------------------------------------------------------

  function currentStoreState() {
    return {
      themeDisableEnabled: lastThemeDisable,
      colorOverrideEnabled: lastColorOverride,
      colorOverrideValues: overrideValues,
      neutralTintEnabled: lastNeutralTint,
      neutralTintHex: neutralHex
    };
  }

  function renderThemeStatus(marker) {
    if (!themeStatusEl) { return; }
    var ss = currentStoreState();
    themeStatusEl.textContent = "Theming: " + themeStatusText(marker, ss);
    themeStatusEl.className = "theme-status" + (isThemeActive(marker, ss) ? " ts-on" : "");
  }

  // Read the §4.4 marker the page injector wrote to documentElement.dataset (popup reads it in MAIN
  // world — the same mechanism the grid status uses). Degrades to storage-derived text off-Kinetic.
  function readThemeStatusFromActiveTab() {
    renderThemeStatus(null); // never leave it blank; storage-derived intent first
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab || !tab.id || !tab.url || !isSupportedTabUrl(tab.url, customHostPatterns)) { return; }
        if (!chrome.scripting || !chrome.scripting.executeScript) { return; }
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            world: "MAIN",
            func: function () {
              try {
                return JSON.parse(document.documentElement.dataset.kineticThemeControl || "null");
              } catch (e) {
                return null;
              }
            }
          },
          function (results) {
            if (chrome.runtime.lastError) { return; }
            var marker = results && results[0] ? results[0].result : null;
            if (marker) { renderThemeStatus(marker); }
          }
        );
      });
    } catch (e) { /* keep storage-derived text */ }
  }

  // After a local change, repaint intent immediately, then re-read the live marker once it settles.
  function refreshThemeStatusSoon() {
    renderThemeStatus(null);
    if (themeStatusTimer) { clearTimeout(themeStatusTimer); }
    themeStatusTimer = setTimeout(function () {
      themeStatusTimer = null;
      readThemeStatusFromActiveTab();
    }, 250);
  }

  // ---- Padding status readout --------------------------------------------------------------------

  // Two-level clone of the nested componentDensity map ({fam:{dim:factor}}) — cloneValues is shallow.
  function cloneDensity(obj) {
    var out = {};
    if (obj && typeof obj === "object") {
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) { out[k] = cloneValues(obj[k]); }
      }
    }
    return out;
  }

  function renderPaddingStatus(marker) {
    if (!paddingStatusEl) { return; }
    var ss = { componentDensity: componentDensity, textAreaAutoSizeEnabled: lastTextAreaAutoSize, fullWidthEnabled: lastFullWidth };
    paddingStatusEl.textContent = "Spacing: " + densityStatusText(marker, ss);
    paddingStatusEl.className = "theme-status" + (isDensityActive(marker, ss) ? " ts-on" : "");
  }

  // Read the padding-control marker the page injector wrote to documentElement.dataset (popup reads it
  // in MAIN world — same mechanism as the grid + theme status). Degrades to storage intent off-Kinetic.
  function readPaddingStatusFromActiveTab() {
    renderPaddingStatus(null);
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab || !tab.id || !tab.url || !isSupportedTabUrl(tab.url, customHostPatterns)) { return; }
        if (!chrome.scripting || !chrome.scripting.executeScript) { return; }
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            world: "MAIN",
            func: function () {
              try {
                return JSON.parse(document.documentElement.dataset.kineticPaddingControl || "null");
              } catch (e) {
                return null;
              }
            }
          },
          function (results) {
            if (chrome.runtime.lastError) { return; }
            var marker = results && results[0] ? results[0].result : null;
            if (marker) { renderPaddingStatus(marker); }
          }
        );
      });
    } catch (e) { /* keep storage-derived text */ }
  }

  function refreshPaddingStatusSoon() {
    renderPaddingStatus(null);
    if (paddingStatusTimer) { clearTimeout(paddingStatusTimer); }
    paddingStatusTimer = setTimeout(function () {
      paddingStatusTimer = null;
      readPaddingStatusFromActiveTab();
    }, 250);
  }

  // ---- Init --------------------------------------------------------------------------------------

  function resolveElements() {
    toggle = document.getElementById("toggle");
    toggleState = document.getElementById("toggle-state");
    applyHint = document.getElementById("apply-hint");
    modeSelect = document.getElementById("mode");
    modeNote = document.getElementById("mode-note");
    scopeSelect = document.getElementById("scope");
    stApplied = document.getElementById("st-applied");
    stMode = document.getElementById("st-mode");
    stBundle = document.getElementById("st-bundle");
    stAnchors = document.getElementById("st-anchors");
    stNote = document.getElementById("st-note");
    versionEl = document.getElementById("version");
    scrollBufferToggle = document.getElementById("toggle-scroll-buffer");
    scrollBufferState = document.getElementById("toggle-scroll-buffer-state");
    autofitToggle = document.getElementById("toggle-autofit");
    autofitState = document.getElementById("toggle-autofit-state");
    autofitDensitySlider = document.getElementById("autofit-density");
    autofitDensityPct = document.getElementById("autofit-density-pct");
    autofitDensityReset = document.getElementById("autofit-density-reset");
    headerWrapToggle = document.getElementById("toggle-header-wrap");
    headerWrapState = document.getElementById("toggle-header-wrap-state");
    themeDisableToggle = document.getElementById("toggle-theme-disable");
    themeDisableState = document.getElementById("toggle-theme-disable-state");
    colorOverrideToggle = document.getElementById("toggle-color-override");
    colorOverrideState = document.getElementById("toggle-color-override-state");
    colorPanel = document.getElementById("color-panel");
    colorRows = document.getElementById("color-rows");
    colorFooter = document.getElementById("color-footer");
    resetAllBtn = document.getElementById("clr-reset-all");
    themeStatusEl = document.getElementById("theme-status");
    neutralSwatch = document.getElementById("clr-neutral");
    neutralHexLabel = document.getElementById("hex-neutral");
    neutralReset = document.getElementById("neutral-reset");
    fullWidthToggle = document.getElementById("toggle-full-width");
    fullWidthState = document.getElementById("toggle-full-width-state");
    textAreaAutoSizeToggle = document.getElementById("toggle-textarea-autosize");
    textAreaAutoSizeState = document.getElementById("toggle-textarea-autosize-state");
    padRows = document.getElementById("pad-rows");
    padResetAll = document.getElementById("pad-reset-all");
    padPresetMin = document.getElementById("pad-preset-min");
    padPresetMax = document.getElementById("pad-preset-max");
    paddingStatusEl = document.getElementById("padding-status");
    customHostInput = document.getElementById("custom-host");
    customHostAdd = document.getElementById("custom-host-add");
    customHostList = document.getElementById("custom-host-list");
    customHostNote = document.getElementById("custom-host-note");
  }

  function init() {
    resolveElements();
    versionEl.textContent = "v" + manifestVersion();

    buildColorRows();
    buildSliderRows();

    chrome.storage.local.get(DEFAULTS, function (values) {
      reflectEnabled(values.gridFixEnabled === true);
      reflectMode(values.gridFixMode || DEFAULTS.gridFixMode);
      reflectScope(values.gridFixScope || DEFAULTS.gridFixScope);
      reflectScrollBuffer(values.gridScrollBufferEnabled === true);
      reflectAutofit(values.gridAutoSizeEnabled === true);
      reflectAutofitDensity(values.gridAutoFitDensity);
      reflectHeaderWrap(values.gridHeaderWrapEnabled === true);

      reflectThemeDisable(values.themeDisableEnabled === true);
      reflectColorOverride(values.colorOverrideEnabled === true); // also sets lastNeutralTint in lockstep
      overrideValues = cloneValues(values.colorOverrideValues);
      hydrateSwatches();

      neutralHex = isValidHex(values.neutralTintHex) ? normHex(values.neutralTintHex) : "";
      setNeutralSwatch(neutralHex || NEUTRAL_DEFAULT_HEX);
      // Migrate legacy storage: neutralTintEnabled is now slaved to the override toggle, so realign it if a
      // pre-merge (separate-toggle) value is out of sync — keeps the engine's neutralActive gate consistent.
      if ((values.neutralTintEnabled === true) !== lastNeutralTint) {
        persist({ neutralTintEnabled: lastNeutralTint });
      }

      componentDensity = cloneDensity(values.componentDensity);
      reflectFullWidth(values.fullWidthEnabled === true);
      reflectTextAreaAutoSize(values.textAreaAutoSizeEnabled === true);
      hydrateSliders();
      customHostPatterns = normalizedPatternList(values.customHostPatterns);
      renderCustomHosts();

      readMarkerFromActiveTab();
      readThemeStatusFromActiveTab();
      readPaddingStatusFromActiveTab();
    });

    toggle.addEventListener("click", onToggle);
    if (scrollBufferToggle) { scrollBufferToggle.addEventListener("click", onScrollBufferToggle); }
    if (autofitToggle) { autofitToggle.addEventListener("click", onAutofitToggle); }
    if (autofitDensitySlider) {
      autofitDensitySlider.addEventListener("input", function () { onAutofitDensityInput(autofitDensitySlider.value); });
      autofitDensitySlider.addEventListener("change", function () { onAutofitDensityInput(autofitDensitySlider.value); });
    }
    if (autofitDensityReset) { autofitDensityReset.addEventListener("click", onAutofitDensityReset); }
    if (headerWrapToggle) { headerWrapToggle.addEventListener("click", onHeaderWrapToggle); }
    if (themeDisableToggle) { themeDisableToggle.addEventListener("click", onThemeDisableToggle); }
    if (colorOverrideToggle) { colorOverrideToggle.addEventListener("click", onColorOverrideToggle); }
    if (resetAllBtn) { resetAllBtn.addEventListener("click", onResetAll); }
    if (neutralSwatch) {
      neutralSwatch.addEventListener("input", function () { onNeutralPicked(neutralSwatch.value, true); });
      neutralSwatch.addEventListener("change", function () { onNeutralPicked(neutralSwatch.value, false); });
    }
    if (neutralReset) { neutralReset.addEventListener("click", onNeutralReset); }
    if (fullWidthToggle) { fullWidthToggle.addEventListener("click", onFullWidthToggle); }
    if (textAreaAutoSizeToggle) { textAreaAutoSizeToggle.addEventListener("click", onTextAreaAutoSizeToggle); }
    if (padResetAll) { padResetAll.addEventListener("click", onPadResetAll); }
    if (padPresetMin) { padPresetMin.addEventListener("click", function () { onPadPreset("min"); }); }
    if (padPresetMax) { padPresetMax.addEventListener("click", function () { onPadPreset("max"); }); }
    if (customHostAdd) { customHostAdd.addEventListener("click", onAddCustomHost); }
    if (customHostInput) {
      customHostInput.addEventListener("keydown", function (event) {
        if (event && event.key === "Enter") {
          event.preventDefault();
          onAddCustomHost();
        }
      });
    }

    modeSelect.addEventListener("change", function () {
      // "debugger" is a REQUIRED permission (Chrome forbids it as optional — manifestError id 21 omits an
      // optional debugger, breaking the request), so it is granted at install and we can switch modes
      // directly. The Kinetic tab must still be reloaded for the (debugger Fetch text-rewrite) to apply.
      var nextMode = modeSelect.value === "debugger" ? "debugger" : "runtime";
      reflectMode(nextMode);
      applyHint.hidden = false;
      persist({ gridFixMode: nextMode });
    });

    scopeSelect.addEventListener("change", function () {
      persist({ gridFixScope: scopeSelect.value });
    });

    // Keep the popup in sync if the background or another popup mutates state.
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") { return; }
      if (changes.gridFixEnabled) { reflectEnabled(changes.gridFixEnabled.newValue === true); }
      if (changes.gridFixMode) { reflectMode(changes.gridFixMode.newValue); }
      if (changes.gridFixScope) { reflectScope(changes.gridFixScope.newValue); }
      if (changes.gridScrollBufferEnabled) { reflectScrollBuffer(changes.gridScrollBufferEnabled.newValue === true); }
      if (changes.gridAutoSizeEnabled) { reflectAutofit(changes.gridAutoSizeEnabled.newValue === true); }
      if (changes.gridAutoFitDensity) { reflectAutofitDensity(changes.gridAutoFitDensity.newValue); }
      if (changes.gridHeaderWrapEnabled) { reflectHeaderWrap(changes.gridHeaderWrapEnabled.newValue === true); }

      if (changes.themeDisableEnabled) {
        reflectThemeDisable(changes.themeDisableEnabled.newValue === true);
      }
      if (changes.colorOverrideEnabled) {
        // reflectColorOverride also realigns lastNeutralTint, so neutralTintEnabled needs no separate handler.
        reflectColorOverride(changes.colorOverrideEnabled.newValue === true);
      }
      if (changes.colorOverrideValues) {
        overrideValues = cloneValues(changes.colorOverrideValues.newValue);
        hydrateSwatches();
      }
      if (changes.neutralTintHex) {
        neutralHex = isValidHex(changes.neutralTintHex.newValue) ? normHex(changes.neutralTintHex.newValue) : "";
        setNeutralSwatch(neutralHex || NEUTRAL_DEFAULT_HEX);
      }
      if (changes.themeDisableEnabled || changes.colorOverrideEnabled || changes.colorOverrideValues ||
          changes.neutralTintEnabled || changes.neutralTintHex) {
        refreshThemeStatusSoon();
      }

      if (changes.componentDensity) {
        componentDensity = cloneDensity(changes.componentDensity.newValue);
        hydrateSliders();
        refreshPaddingStatusSoon();
      }
      if (changes.fullWidthEnabled) {
        reflectFullWidth(changes.fullWidthEnabled.newValue === true);
        refreshPaddingStatusSoon();
      }
      if (changes.textAreaAutoSizeEnabled) {
        reflectTextAreaAutoSize(changes.textAreaAutoSizeEnabled.newValue === true);
        refreshPaddingStatusSoon();
      }
      if (changes.customHostPatterns) {
        customHostPatterns = normalizedPatternList(changes.customHostPatterns.newValue);
        renderCustomHosts();
        readMarkerFromActiveTab();
        readThemeStatusFromActiveTab();
        readPaddingStatusFromActiveTab();
      }
    });
  }

  // Auto-init only with a real DOM (so the pure helpers import cleanly under headless tests).
  if (typeof document !== "undefined" && document && typeof document.getElementById === "function") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
