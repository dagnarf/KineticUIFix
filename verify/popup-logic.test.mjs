import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

// Load the padding-control engine the repo way (for the popup<->engine DIMENSIONS lockstep test).
function loadPaddingEngine() {
  const src = fs.readFileSync(path.join(root, "src", "padding-control.js"), "utf8");
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "padding-control.js" });
  return sandbox.self.__KINETIC_PADDING_CONTROL___MODULE;
}

// Minimal element stub: enough surface for popup.js (get/setAttribute, textContent,
// className, hidden, value, addEventListener + a dispatch() to simulate events).
function makeEl(id) {
  const attrs = {};
  const listeners = {};
  return {
    id,
    textContent: "",
    className: "",
    hidden: false,
    value: "",
    setAttribute(name, val) {
      attrs[name] = String(val);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    dispatch(type) {
      for (const fn of listeners[type] || []) {
        fn({ type });
      }
    },
  };
}

function makeChromeShim() {
  const store = {};
  const changeListeners = [];
  return {
    store,
    api: {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: "0.1.0" }),
      },
      storage: {
        local: {
          get(defaults, cb) {
            const out = {};
            for (const k of Object.keys(defaults)) {
              out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : defaults[k];
            }
            cb(out);
          },
          set(updates, cb) {
            const changes = {};
            for (const k of Object.keys(updates)) {
              changes[k] = { oldValue: store[k], newValue: updates[k] };
              store[k] = updates[k];
            }
            for (const fn of changeListeners) {
              fn(changes, "local");
            }
            if (cb) cb();
          },
        },
        onChanged: {
          addListener(fn) {
            changeListeners.push(fn);
          },
        },
      },
      tabs: {
        // No active Kinetic tab in this harness -> popup shows the "open a Kinetic tab" note.
        query(_q, cb) {
          cb([]);
        },
      },
    },
  };
}

async function loadPopup() {
  const ids = [
    "toggle",
    "toggle-state",
    "apply-hint",
    "mode",
    "mode-note",
    "scope",
    "st-applied",
    "st-mode",
    "st-bundle",
    "st-anchors",
    "st-note",
    "version",
    "toggle-autofit",
    "toggle-autofit-state",
    "autofit-density",
    "autofit-density-pct",
    "autofit-density-reset",
    "toggle-header-wrap",
    "toggle-header-wrap-state",
    "toggle-full-width",
    "toggle-full-width-state",
    "toggle-textarea-autosize",
    "toggle-textarea-autosize-state",
  ];
  const els = {};
  for (const id of ids) {
    els[id] = makeEl(id);
  }
  globalThis.document = {
    readyState: "complete",
    getElementById: (id) => els[id] || null,
    addEventListener() {},
  };
  const shim = makeChromeShim();
  globalThis.chrome = shim.api;

  // Fresh module instance each call (cache-bust via a unique counter — Date.now() can collide
  // within the same millisecond and return a cached module bound to a prior test's elements).
  loadPopup.seq = (loadPopup.seq || 0) + 1;
  const href = pathToFileURL(path.join(root, "popup", "popup.js")).href + `?n=${loadPopup.seq}`;
  await import(href);
  return { els, shim };
}

test("popup.html declares an accessible default-OFF switch", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /href="popup\.css"/);
  assert.match(html, /src="popup\.js"/);
});

test("popup reflects default OFF state on open", async () => {
  const { els } = await loadPopup();
  assert.equal(els.toggle.getAttribute("aria-checked"), "false");
  assert.equal(els["toggle-state"].textContent, "Off");
  assert.equal(els.version.textContent, "v0.1.0");
});

test("flipping the switch persists gridFixEnabled=true and shows the apply hint", async () => {
  const { els, shim } = await loadPopup();
  els.toggle.dispatch("click");
  assert.equal(els.toggle.getAttribute("aria-checked"), "true");
  assert.equal(els["toggle-state"].textContent, "On");
  assert.equal(els["apply-hint"].hidden, false);
  // Debounced write (120ms) -> poll until it lands (robust under test-runner load).
  for (let i = 0; i < 40 && shim.store.gridFixEnabled !== true; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.gridFixEnabled, true);
});

test("flipping the Wrap-column-headers switch persists gridHeaderWrapEnabled (live, no reload hint)", async () => {
  const { els, shim } = await loadPopup();
  // Default OFF on open.
  assert.equal(els["toggle-header-wrap"].getAttribute("aria-checked"), "false");
  assert.equal(els["toggle-header-wrap-state"].textContent, "Off");
  // Flip on.
  els["toggle-header-wrap"].dispatch("click");
  assert.equal(els["toggle-header-wrap"].getAttribute("aria-checked"), "true");
  assert.equal(els["toggle-header-wrap-state"].textContent, "On");
  for (let i = 0; i < 40 && shim.store.gridHeaderWrapEnabled !== true; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.gridHeaderWrapEnabled, true, "persisted the new flag");
  // It is a LIVE feature -> flipping it must NOT touch the main grid-fix flag (which carries the reload hint).
  assert.notEqual(shim.store.gridFixEnabled, true, "header-wrap does not enable the debugger-delivered grid fix");
  // Flip back off.
  els["toggle-header-wrap"].dispatch("click");
  for (let i = 0; i < 40 && shim.store.gridHeaderWrapEnabled !== false; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.gridHeaderWrapEnabled, false, "toggled back off");
});

test("flipping the Text-area auto-size switch persists textAreaAutoSizeEnabled (live, no reload hint)", async () => {
  const { els, shim } = await loadPopup();
  assert.equal(els["toggle-textarea-autosize"].getAttribute("aria-checked"), "false");
  assert.equal(els["toggle-textarea-autosize-state"].textContent, "Off");

  els["toggle-textarea-autosize"].dispatch("click");
  assert.equal(els["toggle-textarea-autosize"].getAttribute("aria-checked"), "true");
  assert.equal(els["toggle-textarea-autosize-state"].textContent, "On");
  for (let i = 0; i < 40 && shim.store.textAreaAutoSizeEnabled !== true; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.textAreaAutoSizeEnabled, true, "persisted the new flag");
  assert.notEqual(shim.store.gridFixEnabled, true, "text-area auto-size does not enable the reload-gated grid fix");

  els["toggle-textarea-autosize"].dispatch("click");
  for (let i = 0; i < 40 && shim.store.textAreaAutoSizeEnabled !== false; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.textAreaAutoSizeEnabled, false, "toggled back off");
});

test("flipping the Full-width switch persists fullWidthEnabled (live, no reload hint)", async () => {
  const { els, shim } = await loadPopup();
  assert.equal(els["toggle-full-width"].getAttribute("aria-checked"), "false");
  assert.equal(els["toggle-full-width-state"].textContent, "Off");

  els["toggle-full-width"].dispatch("click");
  assert.equal(els["toggle-full-width"].getAttribute("aria-checked"), "true");
  assert.equal(els["toggle-full-width-state"].textContent, "On");
  for (let i = 0; i < 40 && shim.store.fullWidthEnabled !== true; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.fullWidthEnabled, true, "persisted the new flag");
  assert.notEqual(shim.store.gridFixEnabled, true, "full-width mode does not enable the reload-gated grid fix");

  els["toggle-full-width"].dispatch("click");
  for (let i = 0; i < 40 && shim.store.fullWidthEnabled !== false; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.fullWidthEnabled, false, "toggled back off");
});

test("with no Kinetic tab the status shows a guiding note, not an error", async () => {
  const { els } = await loadPopup();
  assert.match(els["st-note"].textContent, /Kinetic/);
});

// =====================================================================================================
// Theme controls — pure popup helpers (kinetic-theme-control-extension, Track D · T_D_04, §4.1/§4.2/§4.4).
// popup.js exposes them on globalThis.__KINETIC_POPUP_LOGIC__ before its DOM auto-init. Imported here
// with NO document so auto-init is skipped — the helpers are pure (no DOM / no chrome.*).
// =====================================================================================================

async function getPopupLogic() {
  globalThis.document = undefined; // skip popup.js auto-init; we only want the pure helpers
  getPopupLogic.seq = (getPopupLogic.seq || 0) + 1;
  const href = pathToFileURL(path.join(root, "popup", "popup.js")).href + `?logic=${getPopupLogic.seq}`;
  await import(href);
  return globalThis.__KINETIC_POPUP_LOGIC__;
}

test("popup FAMILIES mirror the §4.2 table (10 families, same keys/order as the engine)", async () => {
  const L = await getPopupLogic();
  assert.equal(L.FAMILIES.length, 10);
  assert.deepEqual(
    L.FAMILIES.map((f) => f.key),
    ["primary", "secondary", "tertiary", "accent", "base", "interactive", "focus", "error", "success", "warning"]
  );
  // every family carries the HSL needed to render its stock swatch
  for (const f of L.FAMILIES) {
    assert.equal(typeof f.label, "string");
    assert.ok(f.h >= 0 && f.h <= 360 && f.s >= 0 && f.s <= 100 && f.l >= 0 && f.l <= 100, f.key + " HSL in range");
  }
});

test("stockHex hydrates each family swatch to a valid 6-digit hex == hslToHex of its stock HSL", async () => {
  const L = await getPopupLogic();
  for (const f of L.FAMILIES) {
    const hex = L.stockHex(f.key);
    assert.match(hex, /^#[0-9a-f]{6}$/, f.key + " stock hex");
    assert.equal(hex, L.hslToHex({ h: f.h, s: f.s, l: f.l }), f.key + " swatch matches its HSL");
  }
  assert.equal(L.stockHex("nope"), "#000000", "unknown family -> safe default");
});

test("isValidHex + normHex canonicalization (color inputs need lowercase #rrggbb)", async () => {
  const L = await getPopupLogic();
  assert.equal(L.isValidHex("#1A73E8"), true);
  assert.equal(L.isValidHex("abc"), true);
  assert.equal(L.isValidHex("#12"), false);
  assert.equal(L.normHex("#1A73E8"), "#1a73e8", "lowercased");
  assert.equal(L.normHex("ABC"), "#aabbcc", "3-digit expanded + hashed");
  assert.equal(L.normHex("1a73e8"), "#1a73e8", "hash added");
  assert.equal(L.normHex("bogus"), null, "invalid -> null");
});

test("nextOverrideValues: read-modify-write/delete reducer is immutable (§4.1)", async () => {
  const L = await getPopupLogic();
  const a = {};
  const b = L.nextOverrideValues(a, "primary", "#1A73E8");
  assert.deepEqual(b, { primary: "#1a73e8" }, "sets canonical hex");
  assert.deepEqual(a, {}, "does not mutate the previous object");

  const c = L.nextOverrideValues(b, "accent", "#112233");
  assert.deepEqual(c, { primary: "#1a73e8", accent: "#112233" });

  const d = L.nextOverrideValues(c, "primary", null);
  assert.deepEqual(d, { accent: "#112233" }, "null deletes the family");

  const e = L.nextOverrideValues(c, "primary", "not-a-hex");
  assert.deepEqual(e, { accent: "#112233" }, "invalid hex deletes the family");

  const f = L.nextOverrideValues(c, "bogusfamily", "#1a73e8");
  assert.deepEqual(f, { primary: "#1a73e8", accent: "#112233" }, "unknown family is ignored");
});

test("countOverrides counts only known families with a valid hex", async () => {
  const L = await getPopupLogic();
  assert.equal(L.countOverrides({}), 0);
  assert.equal(L.countOverrides({ primary: "#1a73e8" }), 1);
  assert.equal(L.countOverrides({ primary: "#1a73e8", accent: "#112233" }), 2);
  assert.equal(L.countOverrides({ primary: "bogus", nope: "#1a73e8" }), 0);
});

test("themeStatusText: §4.4 marker takes precedence, storage-derived intent is the fallback", async () => {
  const L = await getPopupLogic();
  // marker-driven (live on a Kinetic tab)
  assert.match(L.themeStatusText({ themeDisabled: true }), /Disabled/);
  assert.match(L.themeStatusText({ colorOverride: true, families: ["primary", "accent"] }), /Custom — 2 families/);
  assert.match(L.themeStatusText({ colorOverride: true, families: ["primary"] }), /Custom — 1 family/);
  assert.match(L.themeStatusText({ themeDisabled: false, colorOverride: false, families: [] }), /Native/);
  // storage-derived (off a Kinetic tab / marker absent) -> "applies on a Kinetic tab"
  assert.match(L.themeStatusText(null, { themeDisableEnabled: true }), /Disabled.*Kinetic tab/);
  assert.match(L.themeStatusText(null, { colorOverrideEnabled: true, colorOverrideValues: { primary: "#1a73e8" } }), /Custom \(1\).*Kinetic tab/);
  assert.match(L.themeStatusText(null, {}), /Native/);
});

test("isThemeActive mirrors the §4.4 active rule for marker and storage", async () => {
  const L = await getPopupLogic();
  assert.equal(L.isThemeActive({ themeDisabled: true, families: [] }), true);
  assert.equal(L.isThemeActive({ colorOverride: true, families: ["primary"] }), true);
  assert.equal(L.isThemeActive({ colorOverride: true, families: [] }), false, "override w/ no families is inert");
  assert.equal(L.isThemeActive({ themeDisabled: false, colorOverride: false, families: [] }), false);
  assert.equal(L.isThemeActive(null, { themeDisableEnabled: true }), true);
  assert.equal(L.isThemeActive(null, { colorOverrideEnabled: true, colorOverrideValues: {} }), false);
  assert.equal(L.isThemeActive(null, {}), false);
});

test("neutral tint (v3.6.0): neutralActiveSS + status helpers reflect the surface-tint control", async () => {
  const L = await getPopupLogic();
  assert.equal(typeof L.NEUTRAL_DEFAULT_HEX, "string");
  assert.ok(L.isValidHex(L.NEUTRAL_DEFAULT_HEX), "default neutral hex is valid");
  // neutralActiveSS: needs both the toggle AND a valid hex
  assert.equal(L.neutralActiveSS({ neutralTintEnabled: true, neutralTintHex: "#5b7088" }), true);
  assert.equal(L.neutralActiveSS({ neutralTintEnabled: false, neutralTintHex: "#5b7088" }), false);
  assert.equal(L.neutralActiveSS({ neutralTintEnabled: true, neutralTintHex: "nope" }), false);
  assert.equal(L.neutralActiveSS({}), false);
  // marker-driven status
  assert.match(L.themeStatusText({ themeDisabled: false, colorOverride: false, families: [], neutralTint: true }), /Surface tint/);
  assert.equal(L.isThemeActive({ neutralTint: true, families: [] }), true);
  // storage-derived status
  assert.match(L.themeStatusText(null, { neutralTintEnabled: true, neutralTintHex: "#5b7088" }), /Surface tint.*Kinetic tab/);
  assert.equal(L.isThemeActive(null, { neutralTintEnabled: true, neutralTintHex: "#5b7088" }), true);
  // disable/override still take precedence in the headline; neutral alone is the fallback
  assert.match(L.themeStatusText({ themeDisabled: true, neutralTint: true }), /Disabled/);
});

// =====================================================================================================
// Density / padding controls (per component family) — pure popup helpers + popup<->engine lockstep.
// =====================================================================================================

test("popup FAMILIES_PAD are in lockstep with the padding-control engine (family + dim key/label/range/def)", async () => {
  const L = await getPopupLogic();
  const E = loadPaddingEngine();
  assert.equal(L.FAMILIES_PAD.length, E.FAMILIES.length, "same family count");
  for (let i = 0; i < E.FAMILIES.length; i += 1) {
    const ef = E.FAMILIES[i];
    const pf = L.FAMILIES_PAD[i];
    assert.equal(pf.key, ef.key, `family ${i} key matches`);
    assert.equal(pf.label, ef.label, `family ${ef.key} label matches`);
    assert.equal(pf.dims.length, ef.dims.length, `family ${ef.key} dim count matches`);
    for (let j = 0; j < ef.dims.length; j += 1) {
      const ed = ef.dims[j];
      const pd = pf.dims[j];
      for (const field of ["key", "label", "min", "max", "step", "def"]) {
        assert.equal(pd[field], ed[field], `family ${ef.key} dim ${ed.key} field ${field} matches the engine`);
      }
    }
  }
});

// Load the grid-autofit engine the same vm way (for the popup<->engine density-bounds lockstep test).
function loadAutofitEngine() {
  const src = fs.readFileSync(path.join(root, "src", "grid-autofit.js"), "utf8");
  const sandbox = { self: {}, module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: "grid-autofit.js" });
  return sandbox.module.exports;
}

test("popup auto-fit density bounds are in lockstep with the grid-autofit engine (DENSITY_MIN/MAX/DEF)", async () => {
  const L = await getPopupLogic();
  const E = loadAutofitEngine();
  assert.equal(L.AUTOFIT_DENSITY_MIN, E.DENSITY_MIN, "min matches the engine");
  assert.equal(L.AUTOFIT_DENSITY_MAX, E.DENSITY_MAX, "max matches the engine");
  assert.equal(L.AUTOFIT_DENSITY_DEF, E.DENSITY_DEF, "default matches the engine");
});

test("dragging the column-spacing slider persists a clamped gridAutoFitDensity and updates the % readout", async () => {
  const { els, shim } = await loadPopup();
  // Default reflects 100% on open.
  assert.equal(els["autofit-density-pct"].textContent, "100%");
  // Drag to 0.6 (denser).
  els["autofit-density"].value = "0.6";
  els["autofit-density"].dispatch("input");
  assert.equal(els["autofit-density-pct"].textContent, "60%");
  for (let i = 0; i < 40 && shim.store.gridAutoFitDensity !== 0.6; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.gridAutoFitDensity, 0.6, "persisted the new density");
  // Out-of-range drag is clamped to the slider max.
  els["autofit-density"].value = "9";
  els["autofit-density"].dispatch("change");
  for (let i = 0; i < 40 && shim.store.gridAutoFitDensity !== 1.5; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.gridAutoFitDensity, 1.5, "clamped to max");
  // Reset returns to 100% / default.
  els["autofit-density-reset"].dispatch("click");
  assert.equal(els["autofit-density-pct"].textContent, "100%");
  for (let i = 0; i < 40 && shim.store.gridAutoFitDensity !== 1; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(shim.store.gridAutoFitDensity, 1, "reset to default");
});

test("clampFactor + factorPct: clamp per family+dim and render a % label", async () => {
  const L = await getPopupLogic();
  assert.equal(L.clampFactor("grid", "rowHeight", 9), 1.8);
  assert.equal(L.clampFactor("grid", "rowHeight", 0.1), 0.6);
  assert.equal(L.clampFactor("button", "font", 9), 1.6);
  assert.equal(L.clampFactor("nope", "x", 1), null);
  assert.equal(L.clampFactor("grid", "nope", 1), null);
  assert.equal(L.factorPct(1), "100%");
  assert.equal(L.factorPct(1.3), "130%");
  assert.equal(L.factorPct(0.75), "75%");
});

test("nextComponentDensity: immutable nested RMW; default/invalid/unknown delete or no-op + prune empty family", async () => {
  const L = await getPopupLogic();
  const a = {};
  const b = L.nextComponentDensity(a, "grid", "rowHeight", 1.3);
  assert.deepEqual(b, { grid: { rowHeight: 1.3 } }, "sets a non-default factor under its family");
  assert.deepEqual(a, {}, "does not mutate the previous object");

  const c = L.nextComponentDensity(b, "grid", "font", 1.2);
  assert.deepEqual(c, { grid: { rowHeight: 1.3, font: 1.2 } });
  assert.deepEqual(b, { grid: { rowHeight: 1.3 } }, "previous nested object not mutated");

  const c2 = L.nextComponentDensity(c, "button", "padding", 1.5);
  assert.deepEqual(c2, { grid: { rowHeight: 1.3, font: 1.2 }, button: { padding: 1.5 } });

  const d = L.nextComponentDensity(c, "grid", "rowHeight", 1); // factor at default -> delete
  assert.deepEqual(d, { grid: { font: 1.2 } }, "dragging back to 100% removes that dim");

  const e = L.nextComponentDensity({ grid: { rowHeight: 1.3 } }, "grid", "rowHeight", null); // reset -> delete + prune family
  assert.deepEqual(e, {}, "removing a family's last dim prunes the empty family map");

  const f = L.nextComponentDensity(c, "grid", "rowHeight", 99); // out of range -> clamped to 1.8
  assert.deepEqual(f, { grid: { rowHeight: 1.8, font: 1.2 } });

  const g = L.nextComponentDensity(c, "grid", "bogus", 1.5); // unknown dim -> ignored
  assert.deepEqual(g, { grid: { rowHeight: 1.3, font: 1.2 } });
  const h = L.nextComponentDensity(c, "bogus", "x", 1.5); // unknown family -> ignored
  assert.deepEqual(h, { grid: { rowHeight: 1.3, font: 1.2 } });
});

test("componentDensityPreset pins every family+dim to its floor / ceiling (min / max presets)", async () => {
  const L = await getPopupLogic();

  const min = L.componentDensityPreset("min");
  const max = L.componentDensityPreset("max");

  // Every known dimension whose extreme differs from its default must appear at exactly that extreme,
  // and the result is a valid, fully-active density map.
  for (const fam of L.FAMILIES_PAD) {
    for (const dim of fam.dims) {
      if (!L.isDefaultFactor(fam.key, dim.key, dim.min)) {
        assert.equal(min[fam.key][dim.key], dim.min, `${fam.key}.${dim.key} min`);
      }
      if (!L.isDefaultFactor(fam.key, dim.key, dim.max)) {
        assert.equal(max[fam.key][dim.key], dim.max, `${fam.key}.${dim.key} max`);
      }
    }
  }

  // No dim left at its default (it would have been pruned), and the maps round-trip through the counter.
  const totalDims = L.FAMILIES_PAD.reduce((n, f) => n + f.dims.length, 0);
  assert.equal(L.countComponentAdjustments(min), totalDims, "all dims adjusted at min");
  assert.equal(L.countComponentAdjustments(max), totalDims, "all dims adjusted at max");

  // Unknown extreme defaults to the min floor (wantMax is strictly === "max").
  assert.deepEqual(L.componentDensityPreset("nonsense"), min, "non-'max' extreme behaves as min");
});

test("countComponentAdjustments counts only known family+dims with a non-default factor", async () => {
  const L = await getPopupLogic();
  assert.equal(L.countComponentAdjustments({}), 0);
  assert.equal(L.countComponentAdjustments({ grid: { rowHeight: 1.3 } }), 1);
  assert.equal(L.countComponentAdjustments({ grid: { rowHeight: 1.3, font: 1.2 }, button: { padding: 0.8 } }), 3);
  assert.equal(L.countComponentAdjustments({ grid: { rowHeight: 1 } }), 0, "factor at default doesn't count");
  assert.equal(L.countComponentAdjustments({ nope: { x: 1.5 } }), 0, "unknown family doesn't count");
  assert.equal(L.countComponentAdjustments({ grid: { nope: 1.5 } }), 0, "unknown dim doesn't count");
});

test("densityStatusText: marker takes precedence, storage intent is the fallback", async () => {
  const L = await getPopupLogic();
  assert.match(L.densityStatusText({ active: true, adjustments: [{ family: "grid", dim: "rowHeight", factor: 1.3 }] }), /Custom — 1 adjustment/);
  assert.match(L.densityStatusText({ active: true, adjustments: [{ family: "grid", dim: "rowHeight" }, { family: "button", dim: "font" }] }), /Custom — 2 adjustments/);
  assert.match(L.densityStatusText({ active: false, adjustments: [] }), /Default spacing/);
  assert.match(L.densityStatusText(null, { componentDensity: { grid: { rowHeight: 1.3 } } }), /Custom \(1\).*Kinetic tab/);
  assert.match(L.densityStatusText({ active: true, adjustments: [], textAreaAutoSize: true }), /Text areas auto-size/);
  assert.match(L.densityStatusText(null, { textAreaAutoSizeEnabled: true }), /Text areas auto-size.*Kinetic tab/);
  assert.match(L.densityStatusText({ active: true, adjustments: [], fullWidth: true }), /Full width/);
  assert.match(L.densityStatusText(null, { fullWidthEnabled: true }), /Full width.*Kinetic tab/);
  assert.match(L.densityStatusText({ active: true, adjustments: [{ family: "grid", dim: "rowHeight" }], fullWidth: true, textAreaAutoSize: true }), /Custom — 1 adjustment \+ full width \+ text areas/);
  assert.match(L.densityStatusText(null, {}), /Default spacing/);
});

test("isDensityActive mirrors the marker active rule for marker and storage", async () => {
  const L = await getPopupLogic();
  assert.equal(L.isDensityActive({ active: true, adjustments: [{ family: "grid", dim: "rowHeight", factor: 1.3 }] }), true);
  assert.equal(L.isDensityActive({ active: false, adjustments: [] }), false);
  assert.equal(L.isDensityActive({ active: true, adjustments: [], textAreaAutoSize: true }), true);
  assert.equal(L.isDensityActive({ active: true, adjustments: [], fullWidth: true }), true);
  assert.equal(L.isDensityActive(null, { componentDensity: { grid: { rowHeight: 1.3 } } }), true);
  assert.equal(L.isDensityActive(null, { textAreaAutoSizeEnabled: true }), true);
  assert.equal(L.isDensityActive(null, { fullWidthEnabled: true }), true);
  assert.equal(L.isDensityActive(null, { componentDensity: {} }), false);
  assert.equal(L.isDensityActive(null, {}), false);
});

test("custom host helpers normalize domains, wildcard subdomains, URLs, and invalid input", async () => {
  const L = await getPopupLogic();

  assert.deepEqual(L.normalizeHostInput("tenant.example.com"), {
    ok: true,
    host: "tenant.example.com",
    wildcard: false,
    patterns: ["*://tenant.example.com/*"]
  });
  assert.deepEqual(L.normalizeHostInput("https://Tenant.Example.com/SaaS950/apps/erp/home").patterns, ["*://tenant.example.com/*"]);
  assert.deepEqual(L.normalizeHostInput("*.example.com").patterns, ["*://example.com/*", "*://*.example.com/*"]);
  assert.equal(L.normalizeHostInput("bad host").ok, false);
  assert.equal(L.normalizeHostInput("foo.*.example.com").ok, false);

  assert.deepEqual(
    L.mergeHostPatterns(["*://tenant.example.com/*"], ["*://tenant.example.com/*", "*://*.example.com/*"]),
    ["*://tenant.example.com/*", "*://*.example.com/*"]
  );
  assert.equal(L.hostLabelFromPattern("*://*.example.com/*"), "*.example.com");
});

test("custom host matcher accepts default epicorsaas plus stored exact/wildcard hosts", async () => {
  const L = await getPopupLogic();

  assert.equal(L.isSupportedTabUrl("https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home", []), true);
  assert.equal(L.isSupportedTabUrl("https://kinetic.example.com/SaaS950", ["*://kinetic.example.com/*"]), true);
  assert.equal(L.isSupportedTabUrl("https://tenant.apps.example.com/SaaS950", ["*://*.apps.example.com/*"]), true);
  assert.equal(L.isSupportedTabUrl("https://notepicorsaas.com.evil.com/SaaS950", []), false);
  assert.equal(L.isSupportedTabUrl("https://other.example.com/SaaS950", ["*://kinetic.example.com/*"]), false);
});
