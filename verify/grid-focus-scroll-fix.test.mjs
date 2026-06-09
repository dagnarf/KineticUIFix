import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "grid-focus-scroll-fix.js"), "utf8");

const plain = (value) => JSON.parse(JSON.stringify(value));

function makeWorld(marker) {
  const listeners = {};

  class FakeElement {
    constructor({ grid = false, cell = false } = {}) {
      this.grid = grid;
      this.cell = cell;
      this.focusCalls = [];
    }

    matches(selector) {
      if (selector.indexOf(".k-grid") >= 0 && selector.indexOf("td.k-table-td") >= 0) {
        return this.cell;
      }
      return false;
    }

    closest(selector) {
      if (selector === ".k-grid" && (this.grid || this.cell)) {
        return this.gridNode || this;
      }
      return null;
    }

    focus(options) {
      this.focusCalls.push(options);
    }
  }

  const document = {
    documentElement: { dataset: {} },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener(type, fn) {
      if (listeners[type] === fn) {
        delete listeners[type];
      }
    }
  };
  if (marker) {
    document.documentElement.dataset.kineticPaddingControl = JSON.stringify(marker);
  }

  let tick = 1000;
  const context = {
    document,
    Date,
    Element: FakeElement,
    HTMLElement: FakeElement,
    performance: { now: () => tick },
    console,
    module: { exports: {} }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "grid-focus-scroll-fix.js" });

  return {
    context,
    listeners,
    FakeElement,
    advance(ms) {
      tick += ms;
    }
  };
}

const denseMarker = {
  active: true,
  adjustments: [{ family: "grid", dim: "rowHeight", factor: 0.6 }]
};

test("grid focus guard is inert without dense grid row-height marker", () => {
  const world = makeWorld(null);
  const cell = new world.FakeElement({ cell: true });

  world.listeners.wheel({ target: cell });
  cell.focus();

  assert.equal(cell.focusCalls.length, 1);
  assert.equal(cell.focusCalls[0], undefined, "native focus args are preserved");
  assert.equal(world.context.__KINETIC_GRID_FOCUS_SCROLL_FIX__.preventions, 0);
});

test("grid focus guard applies preventScroll after a recent wheel in a dense grid", () => {
  const world = makeWorld(denseMarker);
  const grid = new world.FakeElement({ grid: true });
  const cell = new world.FakeElement({ cell: true });
  cell.gridNode = grid;

  world.listeners.wheel({ target: cell });
  world.advance(20);
  cell.focus();

  assert.deepEqual(plain(cell.focusCalls), [{ preventScroll: true }]);
  assert.equal(world.context.__KINETIC_GRID_FOCUS_SCROLL_FIX__.preventions, 1);
  assert.equal(world.context.__KINETIC_GRID_FOCUS_SCROLL_FIX__.denseGridRows, true);
});

test("grid focus guard preserves existing focus options and ignores stale wheel windows", () => {
  const world = makeWorld(denseMarker);
  const cell = new world.FakeElement({ cell: true });

  world.listeners.wheel({ target: cell });
  world.advance(20);
  cell.focus({ focusVisible: true });
  assert.deepEqual(plain(cell.focusCalls[0]), { focusVisible: true, preventScroll: true });

  world.advance(1000);
  cell.focus({ focusVisible: true });
  assert.deepEqual(plain(cell.focusCalls[1]), { focusVisible: true }, "stale wheel window leaves native focus options alone");
});

test("grid focus guard ignores non-grid focus during wheel windows", () => {
  const world = makeWorld(denseMarker);
  const cell = new world.FakeElement({ cell: true });
  const input = new world.FakeElement();

  world.listeners.wheel({ target: cell });
  world.advance(20);
  input.focus();

  assert.equal(input.focusCalls[0], undefined);
  assert.equal(world.context.__KINETIC_GRID_FOCUS_SCROLL_FIX__.preventions, 0);
});
