import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pane-resizer.js");
const resizer = registry.element("caffold-pane-resizer").prototype;
after(() => registry.restore());

test("provides its exact visible keyboard-operable separator", () => {
  const parent = {};
  let current = true;
  const calls = [];
  const owner = {
    hidden: false,
    isConnected: true,
    parentElement: parent,
    handle: { id: "handle" },
    canResize: () => true,
    getAttribute: () => "Resize review navigator",
    getClientRects: () => [{}],
    focus: (options) => calls.push(options),
  };

  const scope = resizer.actionHintScope.call(owner, {
    scopeId: "review:thread:navigator",
    actionId: "control.separator.focus",
    clipRoots: [{ id: "review" }],
    isCurrent: () => current,
  });
  assert.equal(scope.targets.length, 1);
  assert.equal(
    scope.targets[0].id,
    "review:thread:navigator:separator",
  );
  assert.equal(scope.targets[0].controlKind, "separator");
  assert.equal(scope.targets[0].label, "Resize review navigator");
  assert.equal(scope.targets[0].control, owner);
  assert.equal(scope.targets[0].anchor, owner.handle);
  scope.targets[0].activate();
  assert.deepEqual(calls, [{ preventScroll: true }]);

  current = false;
  assert.equal(scope.targets[0].isActionable(), false);
  current = true;
  owner.parentElement = {};
  assert.equal(scope.targets[0].isActionable(), false);
  owner.parentElement = parent;
  owner.canResize = () => false;
  assert.deepEqual(resizer.actionHintScope.call(owner, {
    scopeId: "review:thread:navigator",
    actionId: "control.separator.focus",
  }).targets, []);
});

test("keeps the start pane within its maximum, the end minimum, and 70% of the container", () => {
  const panel = (container, attributes = {}) =>
    Object.assign(Object.create(resizer), {
      parentElement: { getBoundingClientRect: () => ({ width: container }) },
      getAttribute: (name) => attributes[name] ?? null,
      getClientRects: () => [{}],
    });
  const navigation = {
    "start-min": "280",
    "start-max": "520",
    "end-min": "520",
  };

  assert.equal(panel(1280, navigation).clampValue(10_000), 520);
  assert.equal(panel(900, navigation).clampValue(10_000), 380);
  assert.equal(panel(700, navigation).clampValue(10_000), 280);
  assert.equal(panel(1280).clampValue(10_000), 896);
});

test("returns to the chosen width when its container widens again", () => {
  let containerWidth = 1280;
  const updates = [];
  const attributes = {
    "start-min": "280",
    "start-max": "520",
    "end-min": "520",
  };
  const pane = Object.assign(Object.create(resizer), {
    currentValue: 380,
    preferredValue: 380,
    parentElement: { getBoundingClientRect: () => ({ width: containerWidth }) },
    getAttribute: (name) => attributes[name] ?? null,
    getClientRects: () => [{}],
    setAttribute() {},
    dispatchEvent: (event) => updates.push(event.detail.value),
  });

  pane.updateValue(500);
  containerWidth = 900;
  pane.handleContainerResize();
  assert.equal(pane.value, 380);
  containerWidth = 1280;
  pane.handleContainerResize();
  assert.equal(pane.value, 500);
  assert.deepEqual(updates, [500, 380, 500]);
});

test("remembers the chosen width under its storage key", () => {
  const previousWindow = globalThis.window;
  const stored = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
  };
  const attributes = {
    "start-default": "380",
    "storage-key": "caffold:pane-width:test",
  };
  const connect = () => {
    const pane = Object.assign(Object.create(resizer), {
      currentValue: 320,
      preferredValue: null,
      parentElement: { getBoundingClientRect: () => ({ width: 1280 }) },
      getAttribute: (name) => attributes[name] ?? null,
      getClientRects: () => [{}],
      setAttribute() {},
      dispatchEvent() {},
    });
    pane.restorePreferredValue();
    return pane;
  };

  try {
    const first = connect();
    assert.equal(first.value, 380);
    first.adjustFromKeyboard({
      key: "ArrowRight",
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(stored.get("caffold:pane-width:test"), "404");
    assert.equal(connect().value, 404);

    globalThis.window = {
      get localStorage() {
        throw new Error("Storage is unavailable");
      },
    };
    first.restorePreferredValue();
    assert.equal(first.value, 404);
  } finally {
    globalThis.window = previousWindow;
  }
});
