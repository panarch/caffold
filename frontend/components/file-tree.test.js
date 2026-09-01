import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-tree.js");
const fileTree = registry.element("caffold-file-tree").prototype;
after(() => registry.restore());

test("provides selectable non-current file leaves through owned row buttons", () => {
  const clipRoot = {};
  const scroller = {};
  const focusOptions = [];
  let clicks = 0;
  const directoryControl = {
    dataset: { fileTreeKey: "src" },
    disabled: false,
  };
  const currentControl = {
    dataset: { fileTreeKey: "src/current.js" },
    disabled: false,
  };
  const fileControl = {
    dataset: { fileTreeKey: "src/next.js" },
    disabled: false,
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const controls = [directoryControl, currentControl, fileControl];
  const nodes = new Map([
    ["src", { key: "src", kind: "directory", name: "src" }],
    ["src/current.js", {
      key: "src/current.js",
      kind: "file",
      name: "current.js",
    }],
    ["src/next.js", {
      key: "src/next.js",
      kind: "file",
      name: "next.js",
      ariaLabel: "Open next.js",
    }],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    nodeByKey: nodes,
    ensureRendered() {},
    scroller() {
      return scroller;
    },
    querySelectorAll() {
      return controls;
    },
    rowForKey(key) {
      const control = controls.find(
        (candidate) => candidate.dataset.fileTreeKey === key,
      );
      return control ? { querySelector: () => control } : null;
    },
  };

  const scope = fileTree.actionHintScope.call(owner, {
    scopeId: "review:files",
    actionId: "navigation.file.open",
    clipRoots: [clipRoot],
    isCurrent: (node) => node.key === "src/current.js",
  });

  assert.equal(scope.targets.length, 1);
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(scope.scrollRoots, [scroller]);
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:files:file:src%2Fnext.js",
      actionId: "navigation.file.open",
      label: "Open next.js",
      controlKind: "button",
    },
  );
  assert.deepEqual(target.clipRoots, [clipRoot, scroller]);
  assert.equal(target.isActionable(), true);

  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  nodes.delete("src/next.js");
  assert.equal(target.isActionable(), false);
});

test("includes enabled directory rows only when an owner explicitly requests them", () => {
  let clicks = 0;
  const directoryControl = {
    dataset: { fileTreeKey: "folder" },
    disabled: false,
    focus() {},
    click() {
      clicks += 1;
    },
  };
  const nodes = new Map([
    ["folder", {
      key: "folder",
      kind: "directory",
      name: "folder",
      ariaLabel: "Open folder",
    }],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    nodeByKey: nodes,
    ensureRendered() {},
    scroller: () => ({}),
    querySelectorAll: () => [directoryControl],
    rowForKey: () => ({ querySelector: () => directoryControl }),
  };
  const options = {
    scopeId: "directory-picker",
    actionId: "dialog.button",
    isCurrent: () => false,
  };

  assert.equal(fileTree.actionHintScope.call(owner, options).targets.length, 0);
  const scope = fileTree.actionHintScope.call(owner, {
    ...options,
    includeDirectories: true,
  });
  assert.equal(scope.targets.length, 1);
  assert.equal(scope.targets[0].label, "Open folder");
  scope.targets[0].activate();
  assert.equal(clicks, 1);
  directoryControl.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
});

test("provides its exact retained tree scrollport", () => {
  let currentScroller;
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  currentScroller = scrollport;
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    getClientRects: () => [{}],
    scroller: () => currentScroller,
  };

  const scope = fileTree.scrollSurfaceScope.call(owner, {
    scopeId: "review:files",
    label: "Changed files",
    clipRoots: [{ id: "pane" }],
  });

  assert.equal(scope.surfaces.length, 1);
  assert.equal(scope.surfaces[0].id, "review:files:scroll");
  assert.equal(scope.surfaces[0].label, "Changed files");
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(scope.resizeElements, [owner, scrollport]);
  assert.deepEqual(scope.scrollRoots, [scrollport]);

  currentScroller = null;
  assert.equal(scope.surfaces[0].isEligible(), false);
});
