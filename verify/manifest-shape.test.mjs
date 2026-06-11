import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("manifest exposes the Track A mechanisms and remains Kinetic-scoped", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.deepEqual(manifest.host_permissions, ["*://*.epicorsaas.com/*"]);
  // `debugger` MUST be a REQUIRED permission: Chrome forbids it in optional_permissions (manifestError
  // id 21 — "Permission 'debugger' cannot be listed as optional. This permission will be omitted."),
  // which silently breaks the debugger-mode request. So it lives in `permissions`, not optional.
  assert.ok(manifest.permissions.includes("debugger"), "debugger is a required permission (cannot be optional)");
  assert.ok(!manifest.optional_permissions || !manifest.optional_permissions.includes("debugger"),
    "debugger must NOT be in optional_permissions (Chrome omits it there)");
  assert.deepEqual(manifest.optional_host_permissions, ["*://*/*"]);
});

test("manifest registers the theme-control content script ISOLATED at document_start (§4.6)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  assert.ok(Array.isArray(manifest.content_scripts), "content_scripts array present");
  const entry = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("src/theme-control.js")
  );
  assert.ok(entry, "an entry delivers src/theme-control.js");
  assert.deepEqual(entry.js, ["src/theme-control.js"], "delivers exactly the theme injector");
  assert.deepEqual(entry.matches, ["*://*.epicorsaas.com/*"], "scoped to the already-granted Kinetic host");
  assert.equal(entry.run_at, "document_start", "runs at document_start to land its <style> early");
  assert.equal(entry.all_frames, false, "top frame only");
  // ISOLATED world is the default content-script world — it MUST NOT declare world:MAIN (§4.6). The
  // injector needs chrome.storage (ISOLATED has it) and only touches the shared DOM.
  assert.notEqual(entry.world, "MAIN", "theme injector runs ISOLATED, never MAIN world");
  assert.ok(!("world" in entry), "ISOLATED is expressed by omitting the world key");

  // The referenced file must exist and be syntactically declared as a content script (not the SW or popup).
  assert.ok(fs.existsSync(path.join(root, "src", "theme-control.js")), "src/theme-control.js exists");
});

test("manifest registers the padding-control content script ISOLATED at document_start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  const entry = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("src/padding-control.js")
  );
  assert.ok(entry, "an entry delivers src/padding-control.js");
  assert.deepEqual(entry.js, ["src/padding-control.js"], "delivers exactly the density injector");
  assert.deepEqual(entry.matches, ["*://*.epicorsaas.com/*"], "scoped to the already-granted Kinetic host");
  assert.equal(entry.run_at, "document_start", "runs at document_start to land its <style> early");
  assert.equal(entry.all_frames, false, "top frame only");
  // ISOLATED world (default): the injector needs chrome.storage and only touches the shared DOM.
  assert.notEqual(entry.world, "MAIN", "density injector runs ISOLATED, never MAIN world");
  assert.ok(!("world" in entry), "ISOLATED is expressed by omitting the world key");

  // It must be a SEPARATE entry from the theme injector (so each feature stays independent).
  const themeEntry = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("src/theme-control.js")
  );
  assert.notEqual(entry, themeEntry, "padding + theme are distinct content_scripts entries");

  assert.ok(fs.existsSync(path.join(root, "src", "padding-control.js")), "src/padding-control.js exists");
});

test("manifest registers the grid-autofit content script ISOLATED at document_start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  const entry = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("src/grid-autofit.js")
  );
  assert.ok(entry, "an entry delivers src/grid-autofit.js");
  assert.deepEqual(entry.js, ["src/grid-autofit.js"], "delivers exactly the autofit injector");
  assert.deepEqual(entry.matches, ["*://*.epicorsaas.com/*"], "scoped to the already-granted Kinetic host");
  assert.equal(entry.run_at, "document_start", "runs at document_start");
  assert.equal(entry.all_frames, false, "top frame only");
  // ISOLATED world (default): the injector needs chrome.storage and only touches the shared DOM. It must
  // NOT run MAIN — it never rewrites main.js and never needs the page's JS objects.
  assert.notEqual(entry.world, "MAIN", "autofit injector runs ISOLATED, never MAIN world");
  assert.ok(!("world" in entry), "ISOLATED is expressed by omitting the world key");

  // Distinct entry from theme + padding (each feature stays independent).
  const themeEntry = manifest.content_scripts.find((cs) => Array.isArray(cs.js) && cs.js.includes("src/theme-control.js"));
  const padEntry = manifest.content_scripts.find((cs) => Array.isArray(cs.js) && cs.js.includes("src/padding-control.js"));
  assert.notEqual(entry, themeEntry, "autofit + theme are distinct entries");
  assert.notEqual(entry, padEntry, "autofit + padding are distinct entries");

  assert.ok(fs.existsSync(path.join(root, "src", "grid-autofit.js")), "src/grid-autofit.js exists");
});

test("manifest registers the grid-header-wrap content script ISOLATED at document_start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  const entry = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("src/grid-header-wrap.js")
  );
  assert.ok(entry, "an entry delivers src/grid-header-wrap.js");
  assert.deepEqual(entry.js, ["src/grid-header-wrap.js"], "delivers exactly the header-wrap injector");
  assert.deepEqual(entry.matches, ["*://*.epicorsaas.com/*"], "scoped to the already-granted Kinetic host");
  assert.equal(entry.run_at, "document_start", "runs at document_start");
  assert.equal(entry.all_frames, false, "top frame only");
  // ISOLATED world (default): the injector needs chrome.storage and only touches the shared DOM. It must
  // NOT run MAIN — it never rewrites main.js and never needs the page's JS objects.
  assert.notEqual(entry.world, "MAIN", "header-wrap injector runs ISOLATED, never MAIN world");
  assert.ok(!("world" in entry), "ISOLATED is expressed by omitting the world key");

  // Distinct entry from autofit (each feature stays an independent content_scripts entry).
  const autofitEntry = manifest.content_scripts.find((cs) => Array.isArray(cs.js) && cs.js.includes("src/grid-autofit.js"));
  assert.notEqual(entry, autofitEntry, "header-wrap + autofit are distinct entries");

  assert.ok(fs.existsSync(path.join(root, "src", "grid-header-wrap.js")), "src/grid-header-wrap.js exists");
});

test("manifest registers the grid focus-scroll guard MAIN-world at document_start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  const entry = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("src/grid-focus-scroll-fix.js")
  );
  assert.ok(entry, "an entry delivers src/grid-focus-scroll-fix.js");
  assert.deepEqual(entry.js, ["src/grid-focus-scroll-fix.js"], "delivers exactly the focus-scroll guard");
  assert.deepEqual(entry.matches, ["*://*.epicorsaas.com/*"], "scoped to the already-granted Kinetic host");
  assert.equal(entry.run_at, "document_start", "runs at document_start before Kendo grid focus handling");
  assert.equal(entry.world, "MAIN", "focus guard must run MAIN-world to wrap Kendo's page-world focus calls");
  assert.equal(entry.all_frames, false, "top frame only");

  const padEntry = manifest.content_scripts.find((cs) => Array.isArray(cs.js) && cs.js.includes("src/padding-control.js"));
  assert.notEqual(entry, padEntry, "focus guard is separate from the isolated density injector");
  assert.ok(fs.existsSync(path.join(root, "src", "grid-focus-scroll-fix.js")), "src/grid-focus-scroll-fix.js exists");
});

test("required permissions are {scripting,storage,tabs,debugger}; theme/density/autofit add none (§5)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  // debugger is REQUIRED, not optional: Chrome refuses an optional debugger permission and omits it, which
  // silently breaks debugger-mode delivery. The live ISOLATED features (theme/density/autofit) add nothing.
  assert.deepEqual([...manifest.permissions].sort(), ["debugger", "scripting", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["*://*.epicorsaas.com/*"], "no new host permission");
  assert.ok(!manifest.optional_permissions || manifest.optional_permissions.length === 0,
    "no optional_permissions (debugger cannot be optional)");
  assert.deepEqual(manifest.optional_host_permissions, ["*://*/*"], "custom hosts are runtime opt-in");
});

test("manifest wires the popup and icons (Track C shell)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  assert.equal(manifest.action.default_popup, "popup/popup.html");
  for (const size of ["16", "32", "48", "128"]) {
    const rel = manifest.action.default_icon[size];
    assert.ok(rel, `default_icon[${size}] present`);
    assert.equal(manifest.icons[size], rel, `icons[${size}] matches action icon`);
    const buf = fs.readFileSync(path.join(root, rel));
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.deepEqual(
      [...buf.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${rel} is a valid PNG`,
    );
  }
});
