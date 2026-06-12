// Unit tests for src/column-personalizer.js - the Personalize Columns panel bulk visibility controls.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

function loadModule() {
  const src = fs.readFileSync(path.join(root, "src", "column-personalizer.js"), "utf8");
  const sandbox = { self: {}, module: { exports: {} }, console, MouseEvent: class MouseEvent { constructor(type) { this.type = type; } } };
  sandbox.globalThis = sandbox.self;
  vm.runInNewContext(src, sandbox, { filename: "column-personalizer.js" });
  return sandbox.module.exports;
}

function classListFor(obj) {
  return {
    contains(cls) {
      return (" " + (obj.className || "") + " ").indexOf(" " + cls + " ") >= 0;
    }
  };
}

function makeSwitch(checked, attrs = {}) {
  const sw = {
    attrs: { "aria-checked": checked ? "true" : "false", ...attrs },
    className: checked ? "k-switch k-switch-on" : "k-switch k-switch-off",
    ownerDocument: { defaultView: {} },
    clicks: 0,
    get classList() { return classListFor(sw); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(sw.attrs, name) ? sw.attrs[name] : null; },
    dispatchEvent(event) {
      if (event.type === "click") {
        sw.clicks += 1;
        const next = sw.attrs["aria-checked"] !== "true";
        sw.attrs["aria-checked"] = next ? "true" : "false";
        sw.className = next ? "k-switch k-switch-on" : "k-switch k-switch-off";
      }
      return true;
    }
  };
  return sw;
}

function makeRow(sw, options = {}) {
  const row = {
    className: options.rowClass || "ep-list-box",
    attrs: options.attrs || {},
    get classList() { return classListFor(row); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(row.attrs, name) ? row.attrs[name] : null; },
    querySelector(sel) {
      if (sel.indexOf("kendo-switch") >= 0 || sel.indexOf("[role='switch']") >= 0) { return sw; }
      if (sel.indexOf(".k-svg-i-lock") >= 0 || sel.indexOf(".mdi-lock") >= 0 || sel.indexOf(".ep-locked") >= 0) {
        return options.locked ? {} : null;
      }
      return null;
    }
  };
  return row;
}

function makePanel(rows) {
  return {
    querySelectorAll(sel) {
      return sel === ".ep-list-box" ? rows : [];
    }
  };
}

test("setAllSwitches hides only eligible checked columns", () => {
  const M = loadModule();
  const visible = makeSwitch(true);
  const alreadyHidden = makeSwitch(false);
  const locked = makeSwitch(true);
  const disabled = makeSwitch(true, { "aria-disabled": "true" });
  const panel = makePanel([
    makeRow(visible),
    makeRow(alreadyHidden),
    makeRow(locked, { locked: true }),
    makeRow(disabled)
  ]);

  const result = M.setAllSwitches(panel, false);

  assert.equal(result.target, false);
  assert.equal(result.total, 2);
  assert.equal(result.changed, 1);
  assert.equal(visible.getAttribute("aria-checked"), "false");
  assert.equal(alreadyHidden.clicks, 0, "already-hidden row not clicked");
  assert.equal(locked.getAttribute("aria-checked"), "true", "locked row left alone");
  assert.equal(disabled.getAttribute("aria-checked"), "true", "disabled row left alone");
});

test("setAllSwitches shows eligible hidden columns", () => {
  const M = loadModule();
  const hidden = makeSwitch(false);
  const visible = makeSwitch(true);
  const panel = makePanel([makeRow(hidden), makeRow(visible)]);

  const result = M.setAllSwitches(panel, true);

  assert.equal(result.target, true);
  assert.equal(result.total, 2);
  assert.equal(result.changed, 1);
  assert.equal(hidden.getAttribute("aria-checked"), "true");
  assert.equal(visible.clicks, 0, "already-visible row not clicked");
});

test("host matcher accepts Epicor SaaS and custom hosts, rejects suffix spoofing", () => {
  const M = loadModule();
  const W = (host) => ({ location: { hostname: host } });
  assert.equal(M.hostAllowed(W("centralusdtedu00.epicorsaas.com"), {}), true);
  assert.equal(M.hostAllowed(W("evil-epicorsaas.com.attacker.test"), {}), false);
  assert.equal(M.hostAllowed(W("tenant.example.com"), { customHostPatterns: ["*://*.example.com/*"] }), true);
});

test("visiblePanels returns only the newest retained Kinetic panel instance", () => {
  const M = loadModule();
  const panels = [0, 1, 2].map((i) => ({
    id: i,
    querySelector(sel) {
      if (sel === ".ep-personalize-title" || sel === "#btnResetToDefault") { return {}; }
      return null;
    },
    closest() {
      return { getBoundingClientRect: () => ({ width: 500, height: 480 }) };
    }
  }));
  const D = { querySelectorAll(sel) { return sel === "ep-personalize-columns-panel" ? panels : []; } };

  assert.deepEqual(Array.from(M.visiblePanels(D)).map((p) => p.id), [2]);
});

test("module export contract", () => {
  const M = loadModule();
  for (const fn of ["switchChecked", "eligibleSwitches", "visiblePanels", "setAllSwitches", "styleText", "hostAllowed", "install"]) {
    assert.equal(typeof M[fn], "function", fn + " exported");
  }
});
