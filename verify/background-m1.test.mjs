import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
// The binding-directive slice carries the `rebind(){this.checkForPrismSkip()` anchor the v3 transform
// keys on, so the mocked main.js body is actually patchable.
const fixture = fs
  .readFileSync(path.join(root, "verify", "fixtures", "binding-slice-437c1f00.js"), "utf8")
  .split("\n")
  .slice(1)
  .join("\n");

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(enabled) {
  const commands = [];
  const debuggerEvents = [];
  const reloadedTabs = [];
  const storage = {
    gridFixEnabled: enabled,
    gridFixScope: "kinetic-only",
    gridFixMode: "debugger"
  };

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      lastError: null
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
      onChanged: { addListener() {} }
    },
    tabs: {
      query(query, callback) {
        callback([
          {
            id: 7,
            url: "https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home/"
          }
        ]);
      },
      reload(tabId) {
        reloadedTabs.push(tabId);
      },
      onUpdated: { addListener() {} }
    },
    scripting: {
      unregisterContentScripts(options, callback) {
        if (callback) {
          callback();
        }
      },
      registerContentScripts(options, callback) {
        if (callback) {
          callback();
        }
      }
    },
    debugger: {
      attach(target, protocolVersion, callback) {
        commands.push({ method: "Debugger.attach", target, protocolVersion });
        callback();
      },
      detach(target, callback) {
        commands.push({ method: "Debugger.detach", target });
        if (callback) {
          callback();
        }
      },
      getTargets(callback) {
        callback([]);
      },
      sendCommand(target, method, params, callback) {
        commands.push({ target, method, params });
        if (method === "Fetch.getResponseBody") {
          callback({
            base64Encoded: false,
            body: `${fixture};window.__FAKE_MAIN_LOADED__=true;`
          });
          return;
        }
        callback({});
      },
      onEvent: {
        addListener(listener) {
          debuggerEvents.push(listener);
        }
      },
      onDetach: { addListener() {} }
    }
  };

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
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    }
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

  return { commands, debuggerEvents, reloadedTabs };
}

test("M1 fulfills Kinetic main.js with patched bundle text when enabled", async () => {
  const harness = createHarness(true);
  await settle();

  assert.ok(harness.commands.some((command) => command.method === "Fetch.enable"));
  assert.equal(harness.debuggerEvents.length, 1);

  harness.debuggerEvents[0](
    { tabId: 7 },
    "Fetch.requestPaused",
    {
      requestId: "request-1",
      request: { url: "https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home/main.437c1f00e1f99d77.js" },
      responseStatusCode: 200,
      responseStatusText: "OK",
      // main.<hash>.js is normally served immutable-cacheable — these must be stripped on fulfill.
      responseHeaders: [
        { name: "Content-Type", value: "application/javascript" },
        { name: "Cache-Control", value: "public, max-age=31536000, immutable" },
        { name: "ETag", value: "\"abc123\"" },
        { name: "Last-Modified", value: "Wed, 01 Jan 2025 00:00:00 GMT" }
      ]
    }
  );
  await settle();

  const fulfill = harness.commands.find((command) => command.method === "Fetch.fulfillRequest");
  assert.ok(fulfill);
  const patched = Buffer.from(fulfill.params.body, "base64").toString("utf8");
  // The v3 transform injects the rebind hook CALL, appends the hook DEF, and sets the §3 marker.
  assert.match(patched, /window\.__KINETIC_GRID_FIX__/);
  assert.match(patched, /rebind\(\)\{try\{window\.__KINETIC_GRID_FIX_HOOK__&&window\.__KINETIC_GRID_FIX_HOOK__\(this\);\}catch\(_kgf\)\{\}this\.checkForPrismSkip\(\)/);
  assert.match(patched, /window\.__KINETIC_GRID_FIX_HOOK__=function/);
  assert.match(patched, /"mode":"rebind-text"/);

  // The fulfilled response MUST be no-store and carry no cache/validation headers — otherwise Chrome
  // caches the patched content-hashed main.js and a normal reload after toggling OFF keeps serving the
  // cached patched bundle (the fix never reverts). Regression guard for that bug.
  const headerByName = (name) => fulfill.params.responseHeaders.find((h) => h.name.toLowerCase() === name);
  const cacheControl = headerByName("cache-control");
  assert.ok(cacheControl, "fulfilled response must set Cache-Control");
  assert.match(cacheControl.value, /no-store/);
  for (const banned of ["etag", "last-modified", "expires", "age"]) {
    assert.equal(headerByName(banned), undefined, `caching/validation header '${banned}' must be stripped`);
  }
});

test("M1 continues Kinetic main.js unchanged when disabled", async () => {
  const harness = createHarness(false);
  await settle();

  harness.debuggerEvents[0](
    { tabId: 7 },
    "Fetch.requestPaused",
    {
      requestId: "request-2",
      request: { url: "https://centralusdtedu00.epicorsaas.com/SaaS950/apps/erp/home/main.437c1f00e1f99d77.js" },
      responseStatusCode: 200,
      responseHeaders: []
    }
  );
  await settle();

  assert.ok(harness.commands.some((command) => command.method === "Fetch.continueRequest"));
  assert.equal(harness.commands.some((command) => command.method === "Fetch.fulfillRequest"), false);
});
