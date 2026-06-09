// Track C verification (kinetic-theme-control-extension, T_C_02/T_C_03/T_C_04). Boots src/background.js
// in a vm sandbox with a controllable chrome mock and asserts:
//   1. First-run defaults seed the §4.1 theme keys default-OFF / {} (T_C_02).
//   2. A theme-key change refreshes the badge/title but NEVER attaches the debugger or reloads a tab
//      (T_C_03 badge-only + T_C_04 debugger-free/reload-free). The badge enumerates active features.
//   3. Positive control: a grid-key change STILL drives the debugger attach + hard-reload path, proving
//      the theme guard is specific to the theme keys (T_C_04).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

const FULL_DEFAULTS = {
  gridFixEnabled: false,
  gridFixScope: "kinetic-only",
  gridFixMode: "runtime",
  themeDisableEnabled: false,
  colorOverrideEnabled: false,
  colorOverrideValues: {},
  neutralTintEnabled: false,
  neutralTintHex: "",
  componentDensity: {}
};

function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// background.js runs in a vm realm, so objects it creates (e.g. a seeded `{}`) have that realm's
// Object.prototype and fail deepStrictEqual against a test-realm literal. Normalize before comparing.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Boots background.js with a chrome mock. Captures the storage.onChanged listener (so a test can drive a
// config change exactly like the popup's chrome.storage.local.set would), the action badge writes, and a
// running count of every debugger/scripting/tab mutation so the theme path can be proven inert.
function createHarness(initialStorage, options = {}) {
  const storage = { ...initialStorage };
  const debuggerGranted = options.debuggerGranted !== false;
  const storageListeners = [];
  const badge = { text: undefined, title: undefined, color: undefined };
  const calls = {
    attach: 0,
    registerContentScripts: 0,
    unregisterContentScripts: 0,
    reload: 0,
    getTargets: 0
  };

  function emitChange(changes) {
    for (const listener of storageListeners) {
      listener(changes, "local");
    }
  }

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      lastError: null
    },
    permissions: {
      contains(request, callback) {
        callback(debuggerGranted);
      }
    },
    storage: {
      local: {
        get(query, callback) {
          if (Array.isArray(query)) {
            const result = {};
            for (const key of query) {
              if (Object.prototype.hasOwnProperty.call(storage, key)) {
                result[key] = storage[key];
              }
            }
            callback(result);
            return;
          }
          callback({ ...(query || {}), ...storage });
        },
        set(updates, callback) {
          Object.assign(storage, updates || {});
          if (callback) {
            callback();
          }
        }
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      }
    },
    action: {
      setBadgeText(details) { badge.text = details.text; },
      setBadgeBackgroundColor(details) { badge.color = details.color; },
      setTitle(details) { badge.title = details.title; }
    },
    tabs: {
      query(query, callback) {
        callback([{ id: 7, url: "https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home/" }]);
      },
      reload() { calls.reload += 1; },
      onUpdated: { addListener() {} }
    },
    scripting: {
      registerContentScripts(options, callback) {
        calls.registerContentScripts += 1;
        if (callback) { callback(); }
      },
      unregisterContentScripts(options, callback) {
        calls.unregisterContentScripts += 1;
        if (callback) { callback(); }
      }
    },
    debugger: {
      attach(target, protocolVersion, callback) {
        calls.attach += 1;
        callback();
      },
      detach(target, callback) { if (callback) { callback(); } },
      getTargets(callback) { calls.getTargets += 1; callback([]); },
      sendCommand(target, method, params, callback) { if (callback) { callback({}); } },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} }
    }
  };

  // Drive a config change through the captured onChanged listener exactly as Chrome would after a
  // chrome.storage.local.set: mutate the backing store, then fire onChanged with old/new values.
  function changeConfig(patch) {
    const changes = {};
    for (const key of Object.keys(patch)) {
      changes[key] = { oldValue: storage[key], newValue: patch[key] };
      storage[key] = patch[key];
    }
    emitChange(changes);
  }

  const context = {
    chrome,
    console,
    URL,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Promise,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    atob(value) { return Buffer.from(value, "base64").toString("binary"); },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); }
  };
  context.self = context;
  context.globalThis = context;
  context.importScripts = function importScripts(scriptName) {
    const script = fs.readFileSync(path.join(root, "src", scriptName), "utf8");
    vm.runInContext(script, context, { filename: scriptName });
  };

  vm.createContext(context);
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  vm.runInContext(background, context, { filename: "background.js" });

  return { storage, badge, calls, changeConfig };
}

test("first-run seeds the theme keys default-OFF / {} (T_C_02)", async () => {
  const harness = createHarness({}); // nothing stored yet — simulate a clean install
  await settle();

  assert.equal(harness.storage.themeDisableEnabled, false, "themeDisableEnabled defaults false");
  assert.equal(harness.storage.colorOverrideEnabled, false, "colorOverrideEnabled defaults false");
  assert.deepEqual(plain(harness.storage.colorOverrideValues), {}, "colorOverrideValues defaults to empty map");
  assert.equal(harness.storage.neutralTintEnabled, false, "neutralTintEnabled defaults false");
  assert.equal(harness.storage.neutralTintHex, "", "neutralTintHex defaults empty");

  // The density map is also seeded default-OFF (empty => the padding injector is fully inert).
  assert.deepEqual(plain(harness.storage.componentDensity), {}, "componentDensity defaults to empty map");

  // The grid defaults must still be seeded too (no regression to the existing initializer).
  assert.equal(harness.storage.gridFixEnabled, false);
  assert.equal(harness.storage.gridFixScope, "kinetic-only");
  assert.equal(harness.storage.gridFixMode, "runtime");
});

test("pre-seeded install does not re-write storage (idempotent seeding)", async () => {
  const harness = createHarness({ ...FULL_DEFAULTS, colorOverrideValues: { primary: "#1a73e8" } });
  await settle();

  // A user who already set a color must keep it — seeding only fills MISSING keys.
  assert.deepEqual(plain(harness.storage.colorOverrideValues), { primary: "#1a73e8" });
});

test("theme-key changes refresh the badge but never attach the debugger or reload (T_C_03/T_C_04)", async () => {
  const harness = createHarness({ ...FULL_DEFAULTS });
  await settle();

  // Baseline after boot: grid OFF → teardown unregisters + probes targets, but never attaches/reloads.
  assert.equal(harness.calls.attach, 0, "no debugger attach at boot when everything is OFF");
  assert.equal(harness.calls.reload, 0, "no tab reload at boot when everything is OFF");
  const registerBaseline = harness.calls.registerContentScripts;

  // 1) Disable-theming ON → badge shows "theming off" (live, no reload hint), no debugger/reload work.
  harness.changeConfig({ themeDisableEnabled: true });
  await settle(300); // wait well past the 200ms grid debounce to catch any deferred mechanism work
  assert.equal(harness.badge.text, "ON", "badge text reflects an active feature");
  assert.match(harness.badge.title, /theming off/, "title mentions theming off");
  assert.doesNotMatch(harness.badge.title, /reload/, "theme labels carry no reload hint (applies live)");

  // 2) Override ON but no colors yet → NOT counted as active (mirrors §4.4 marker rule).
  harness.changeConfig({ colorOverrideEnabled: true });
  await settle();
  assert.doesNotMatch(harness.badge.title, /custom colors/, "override with no colors is inert");

  // 3) A family color is set → "custom colors" joins the title alongside "theming off".
  harness.changeConfig({ colorOverrideValues: { primary: "#1a73e8" } });
  await settle();
  assert.match(harness.badge.title, /theming off/);
  assert.match(harness.badge.title, /custom colors/, "title enumerates both active theme features");

  // 4) Neutral tint is a theme key too: badge refresh only, no debugger/reload path.
  harness.changeConfig({ neutralTintEnabled: true, neutralTintHex: "#5b7088" });
  await settle();
  assert.match(harness.badge.title, /surface tint/, "title mentions the neutral surface tint");

  // The whole sequence touched only the badge — the debugger/runtime delivery path stayed untouched.
  assert.equal(harness.calls.attach, 0, "theme changes never attach the debugger");
  assert.equal(harness.calls.reload, 0, "theme changes never reload a tab");
  assert.equal(
    harness.calls.registerContentScripts,
    registerBaseline,
    "theme changes never (un)register the MAIN-world grid probe"
  );
});

test("density-key change refreshes the badge ('spacing adjusted') but never attaches/reloads", async () => {
  const harness = createHarness({ ...FULL_DEFAULTS });
  await settle();
  assert.equal(harness.calls.attach, 0, "no debugger attach at boot");
  const registerBaseline = harness.calls.registerContentScripts;

  // A density adjustment is stored as a non-empty componentDensity map (the popup only stores non-default
  // entries and prunes empty families). The badge must light up "spacing adjusted" — applied live, no reload hint.
  harness.changeConfig({ componentDensity: { grid: { rowHeight: 1.3 } } });
  await settle(300); // past the 200ms grid debounce, to catch any deferred mechanism work
  assert.equal(harness.badge.text, "ON", "badge reflects an active feature");
  assert.match(harness.badge.title, /spacing adjusted/, "title mentions the density adjustment");
  assert.doesNotMatch(harness.badge.title, /reload/, "density label carries no reload hint (applies live)");

  // An empty map (user reset everything) drops the label again.
  harness.changeConfig({ componentDensity: {} });
  await settle();
  assert.doesNotMatch(harness.badge.title || "", /spacing adjusted/, "empty density map is inert");

  // The whole sequence touched only the badge — debugger/runtime delivery stayed untouched.
  assert.equal(harness.calls.attach, 0, "density changes never attach the debugger");
  assert.equal(harness.calls.reload, 0, "density changes never reload a tab");
  assert.equal(harness.calls.registerContentScripts, registerBaseline, "density changes never (un)register the grid probe");
});

test("grid-key change STILL drives the debugger attach + reload path (positive control, T_C_04)", async () => {
  const harness = createHarness({ ...FULL_DEFAULTS, gridFixMode: "debugger" });
  await settle();
  assert.equal(harness.calls.attach, 0);

  harness.changeConfig({ gridFixEnabled: true });
  await settle(300); // past the 200ms debounce

  assert.ok(harness.calls.attach >= 1, "enabling the grid fix attaches the debugger");
  assert.ok(harness.calls.reload >= 1, "enabling the grid fix hard-reloads the Kinetic tab");
  assert.match(harness.badge.title, /grid fix on/, "badge reflects the grid fix being on");
  assert.match(harness.badge.title, /reload Kinetic tab to apply/, "grid label keeps its reload hint");
});

test("debugger mode falls back to runtime delivery when optional debugger permission is absent", async () => {
  const harness = createHarness({ ...FULL_DEFAULTS, gridFixMode: "debugger" }, { debuggerGranted: false });
  await settle();
  const registerBaseline = harness.calls.registerContentScripts;

  harness.changeConfig({ gridFixEnabled: true });
  await settle(300);

  assert.equal(harness.calls.attach, 0, "no debugger attach without optional permission");
  assert.ok(
    harness.calls.registerContentScripts > registerBaseline,
    "runtime MAIN-world fallback is registered instead"
  );
  assert.ok(harness.calls.reload >= 1, "matching tabs still reload so document_start runtime hooks apply");
});
