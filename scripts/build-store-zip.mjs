#!/usr/bin/env node
// build-store-zip.mjs — reproducible Chrome Web Store package builder for the
// Kinetic Grid Grouping Fix extension.
//
// Emits, under dist/:
//   unpacked/                                  loadable via chrome://extensions -> "Load unpacked"
//   kinetic-grid-grouping-fix-<ver>.zip        upload THIS to the Chrome Web Store dashboard
//   kinetic-grid-grouping-fix-<ver>.zip.sha256 checksum sidecar
//   build-manifest.json                        version, file list, per-file + zip sha256
//
// Dependency-light: Node stdlib + the system `zip` binary only (no npm deps).
// The archive is content-reproducible: every staged file gets a fixed mtime and
// entries are added in a fixed sorted order, so rebuilding identical sources on a
// given `zip` implementation yields an identical zip sha256. manifest.json sits at
// the archive ROOT, which is what the Chrome Web Store uploader expects.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // extension root (holds manifest.json)
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, "unpacked");

// Fixed timestamp for reproducible archives (2020-01-01T00:00:00Z).
const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

// The ONLY files that ship in the store package. Anything not listed is excluded:
// tests under verify/, the falsified src/patch-transform.js, package.json,
// README.md, icons/make-icons.mjs, .output/ evidence, scripts/, dist/ itself.
// Note: src/grid-revirtualize-fix.js + src/inject-main-world.js are not declared
// in manifest.json (background.js loads them via importScripts + dynamic
// registerContentScripts), so they are listed here explicitly. src/theme-control.js
// and src/padding-control.js ARE declared (manifest content_scripts) and are also
// cross-checked in step 2 below.
const RUNTIME_FILES = [
  "manifest.json",
  "src/background.js",
  "src/grid-revirtualize-fix.js",
  "src/grid-blank-fix.js",
  "src/grid-checkbox-style-fix.js",
  "src/inject-main-world.js",
  "src/theme-control.js",
  "src/padding-control.js",
  "src/grid-autofit.js",
  "src/grid-focus-scroll-fix.js",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
];

// Defense-in-depth: these must never ship even if a future edit adds them to the
// allowlist by mistake (patch-transform.js is the falsified provider transform).
const FORBIDDEN = ["src/patch-transform.js"];

function fail(message) {
  console.error("BUILD FAILED: " + message);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// 1. Read + validate the manifest.
const manifestPath = join(ROOT, "manifest.json");
if (!existsSync(manifestPath)) {
  fail("manifest.json not found at " + manifestPath);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+(\.\d+){0,2}$/.test(version || "")) {
  fail("manifest.version is not a valid extension version: " + version);
}
if (manifest.manifest_version !== 3) {
  fail("manifest_version must be 3 (got " + manifest.manifest_version + ")");
}
// Chrome Web Store hard limits: description <= 132 chars, name <= 75 chars.
// (The uploader rejects the package otherwise.)
if (typeof manifest.description !== "string" || manifest.description.length > 132) {
  fail(
    "manifest.description must be a string <= 132 chars (Chrome Web Store limit); got " +
      (manifest.description ? manifest.description.length : "missing")
  );
}
if (typeof manifest.name !== "string" || manifest.name.length > 75) {
  fail(
    "manifest.name must be a string <= 75 chars (Chrome Web Store limit); got " +
      (manifest.name ? manifest.name.length : "missing")
  );
}

// 2. Cross-check: every file the manifest statically references must be allowlisted.
const referenced = new Set();
const addRef = (p) => {
  if (typeof p === "string") {
    referenced.add(p.replace(/^\.?\//, ""));
  }
};
if (manifest.background && manifest.background.service_worker) {
  addRef(manifest.background.service_worker);
}
if (manifest.action && manifest.action.default_popup) {
  addRef(manifest.action.default_popup);
}
// Every declarative content script must ship — otherwise the feature silently breaks in the store
// build (this is exactly how src/theme-control.js could have been dropped before v3.3.0).
for (const cs of manifest.content_scripts || []) {
  for (const js of cs.js || []) {
    addRef(js);
  }
}
for (const dict of [manifest.icons, manifest.action && manifest.action.default_icon]) {
  if (dict) {
    for (const key of Object.keys(dict)) {
      addRef(dict[key]);
    }
  }
}
const allow = new Set(RUNTIME_FILES);
for (const ref of referenced) {
  if (!allow.has(ref)) {
    fail("manifest references '" + ref + "' but it is not in RUNTIME_FILES");
  }
}

// 3. Forbidden files must not be allowlisted.
for (const forbidden of FORBIDDEN) {
  if (allow.has(forbidden)) {
    fail("forbidden file present in RUNTIME_FILES: " + forbidden);
  }
}

// 4. Every allowlisted file must exist.
for (const rel of RUNTIME_FILES) {
  if (!existsSync(join(ROOT, rel))) {
    fail("missing runtime file: " + rel);
  }
}

// 5. Clean + stage the loadable unpacked dir. Only remove THIS build's outputs —
//    leave sibling dist/ artifacts (e.g. dist/store-assets/ from render-assets.mjs) intact.
const zipNameEarly = "kinetic-grid-grouping-fix-" + version + ".zip";
rmSync(STAGE, { recursive: true, force: true });
rmSync(join(DIST, zipNameEarly), { force: true });
rmSync(join(DIST, zipNameEarly + ".sha256"), { force: true });
rmSync(join(DIST, "build-manifest.json"), { force: true });
mkdirSync(STAGE, { recursive: true });

const perFile = [];
for (const rel of [...RUNTIME_FILES].sort()) {
  const srcPath = join(ROOT, rel);
  const dstPath = join(STAGE, rel);
  mkdirSync(dirname(dstPath), { recursive: true });
  cpSync(srcPath, dstPath);
  utimesSync(dstPath, FIXED_MTIME, FIXED_MTIME);
  const bytes = readFileSync(srcPath);
  perFile.push({ path: rel, bytes: statSync(srcPath).size, sha256: sha256(bytes) });
}

// 6. Create the zip with manifest.json at the archive root.
//    -X drops extra attrs (uid/gid/atime); -D omits directory entries (smaller,
//    fully reproducible); -q quiet. Entries added in a fixed sorted order.
const zipName = "kinetic-grid-grouping-fix-" + version + ".zip";
const zipPath = join(DIST, zipName);
const sortedRel = [...RUNTIME_FILES].sort();
execFileSync("zip", ["-X", "-D", "-q", zipName, ...sortedRel], { cwd: STAGE });
// zip wrote dist/unpacked/<zipName>; move it up to dist/ (same mount, cheap rename).
cpSync(join(STAGE, zipName), zipPath);
rmSync(join(STAGE, zipName), { force: true });

// 7. Hash + write sidecars.
const zipBuf = readFileSync(zipPath);
const zipHash = sha256(zipBuf);
writeFileSync(zipPath + ".sha256", zipHash + "  " + zipName + "\n");

const buildManifest = {
  name: manifest.name,
  version,
  manifestVersion: manifest.manifest_version,
  zip: { file: zipName, bytes: zipBuf.length, sha256: zipHash },
  files: perFile,
  permissions: manifest.permissions || [],
  hostPermissions: manifest.host_permissions || [],
  builtFrom: "apps/kinetic-grid-fix-extension",
  reproducible:
    "Fixed mtime (2020-01-01Z) + sorted entries + zip -X -D. Identical sources -> identical zip sha256 on a given zip implementation."
};
writeFileSync(join(DIST, "build-manifest.json"), JSON.stringify(buildManifest, null, 2) + "\n");

// 8. Verify the zip really has manifest.json at the root.
const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
if (!listing.includes("manifest.json")) {
  fail("zip is missing manifest.json at the archive root");
}
const extra = listing.filter((entry) => !allow.has(entry));
if (extra.length) {
  fail("zip contains unexpected entries: " + extra.join(", "));
}

console.log("OK  Kinetic Grid Grouping Fix - store package built");
console.log("    version:     " + version);
console.log("    files:       " + RUNTIME_FILES.length);
console.log("    unpacked:    " + relative(ROOT, STAGE) + "/   (chrome://extensions -> Load unpacked)");
console.log("    zip:         " + relative(ROOT, zipPath) + "   (" + zipBuf.length + " bytes)");
console.log("    sha256:      " + zipHash);
console.log("    permissions: " + (manifest.permissions || []).join(", "));
console.log("    host perms:  " + (manifest.host_permissions || []).join(", "));
