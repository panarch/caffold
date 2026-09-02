import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./directory-picker.js");
const picker = registry.element("caffold-task-directory-picker").prototype;
after(() => registry.restore());

test("merges owned picker buttons with the child-owned directory rows", () => {
  const controls = new Map([
    [".task-directory-picker-close", button("Close directory picker")],
    [
      ".task-directory-picker-footer [data-directory-picker-action='close']",
      button("Cancel"),
    ],
    [
      ".task-directory-picker-footer [data-directory-picker-action='choose']",
      button("Use This Folder"),
    ],
  ]);
  const body = {};
  const childTarget = { id: "new:directory-picker:file:folder" };
  let childOptions;
  const tree = {
    actionHintScope(options) {
      childOptions = options;
      return {
        targets: [childTarget],
        mutationRoots: [tree],
        scrollRoots: [{}],
      };
    },
  };
  const dialog = {
    open: true,
    querySelector(selector) {
      return selector === ".task-directory-picker-body"
        ? body
        : controls.get(selector);
    },
  };
  const owner = {
    isConnected: true,
    ensureRendered() {},
    dialog: () => dialog,
    tree: () => tree,
  };
  const scope = picker.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.slice(0, 3).map(({ label }) => label), [
    "Close directory picker",
    "Cancel",
    "Use This Folder",
  ]);
  assert.equal(scope.targets[3], childTarget);
  assert.equal(childOptions.includeDirectories, true);
  assert.equal(childOptions.disclosureActionId, undefined);
  assert.deepEqual(childOptions.clipRoots, [dialog, body]);
});

test("declares only the exact retained file-tree scroller", () => {
  const scrollport = layoutElement({ clientHeight: 100, scrollHeight: 220 });
  const tree = { scroller: () => scrollport };
  const dialog = layoutElement({ open: true });
  const owner = {
    isConnected: true,
    ensureRendered() {},
    dialog: () => dialog,
    tree: () => tree,
  };
  const scope = picker.scrollSurfaceScope.call(owner);

  assert.equal(scope.surfaces.length, 1);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 101;
  assert.equal(scope.surfaces[0].isEligible(), true);
});

function button(label) {
  return {
    disabled: false,
    textContent: label,
    getAttribute: (name) => name === "aria-label" && label.startsWith("Close")
      ? label
      : "",
    focus() {},
    click() {},
  };
}

function layoutElement(properties = {}) {
  return {
    getClientRects: () => [{}],
    ...properties,
  };
}
