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
  const fileAnchor = { id: "next-icon" };
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
    querySelector() {
      return fileAnchor;
    },
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
    entityKey: "review-a",
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
      anchor: target.anchor,
    },
    {
      id: "review:files:file:src%2Fnext.js",
      actionId: "navigation.file.open",
      label: "Open next.js",
      controlKind: "button",
      anchor: fileAnchor,
    },
  );
  assert.deepEqual(target.clipRoots, [clipRoot, scroller]);
  assert.equal(target.isActionable(), true);

  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  owner.entityKey = "review-b";
  assert.equal(target.isActionable(), false);
  owner.entityKey = "review-a";
  nodes.delete("src/next.js");
  assert.equal(target.isActionable(), false);
});

test("provides expandable directories only as stable disclosure targets", () => {
  const expandedKeys = new Set();
  const focusOptions = [];
  let clicks = 0;
  const anchor = { id: "src-icon" };
  const control = {
    dataset: { fileTreeKey: "src" },
    disabled: false,
    getAttribute(name) {
      if (name !== "aria-label") return null;
      return "src directory";
    },
    querySelector() {
      return anchor;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const node = {
    key: "src",
    kind: "directory",
    name: "src",
    selectable: false,
    children: [{
      key: "src/a.js",
      kind: "file",
      name: "a.js",
    }],
  };
  const nodes = new Map([["src", node]]);
  const owner = {
    hidden: false,
    isConnected: true,
    entityKey: "review-a",
    expandedKeys,
    nodeByKey: nodes,
    ensureRendered() {},
    scroller: () => ({}),
    querySelectorAll: () => [control],
    rowForKey: () => ({ querySelector: () => control }),
  };
  const options = {
    scopeId: "review:files",
    actionId: "navigation.file.open",
    disclosureActionId: "disclosure.toggle",
    includeDirectories: true,
    isCurrent: () => true,
  };

  const collapsed = fileTree.actionHintScope.call(owner, options);
  assert.equal(collapsed.targets.length, 1);
  assert.deepEqual(
    {
      id: collapsed.targets[0].id,
      actionId: collapsed.targets[0].actionId,
      label: collapsed.targets[0].label,
      controlKind: collapsed.targets[0].controlKind,
      anchor: collapsed.targets[0].anchor,
    },
    {
      id: "review:files:disclosure:src",
      actionId: "disclosure.toggle",
      label: "Expand src",
      controlKind: "disclosure",
      anchor,
    },
  );
  collapsed.targets[0].activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  expandedKeys.add("src");
  const expanded = fileTree.actionHintScope.call(owner, options);
  assert.equal(expanded.targets[0].id, collapsed.targets[0].id);
  assert.equal(expanded.targets[0].label, "Collapse src");
  assert.equal(expanded.targets[0].isActionable(), true);

  owner.entityKey = "review-b";
  assert.equal(expanded.targets[0].isActionable(), false);
  owner.entityKey = "review-a";

  node.children = { status: "loading", message: "Loading..." };
  assert.equal(expanded.targets[0].isActionable(), true);
  node.children = { status: "ready", nodes: [{
    key: "src/b.js",
    kind: "file",
    name: "b.js",
  }] };
  assert.equal(expanded.targets[0].isActionable(), true);

  const originalQuerySelector = control.querySelector;
  control.querySelector = () => ({ id: "replacement-icon" });
  assert.equal(expanded.targets[0].isActionable(), false);
  control.querySelector = originalQuerySelector;

  const originalRowForKey = owner.rowForKey;
  owner.rowForKey = () => ({ querySelector: () => ({ id: "replacement-row" }) });
  assert.equal(expanded.targets[0].isActionable(), false);
  owner.rowForKey = originalRowForKey;

  owner.isConnected = false;
  assert.equal(expanded.targets[0].isActionable(), false);
  owner.isConnected = true;
  owner.hidden = true;
  assert.equal(expanded.targets[0].isActionable(), false);
  assert.equal(fileTree.actionHintScope.call(owner, options).targets.length, 0);
  owner.hidden = false;
  control.disabled = true;
  assert.equal(expanded.targets[0].isActionable(), false);
  assert.equal(fileTree.actionHintScope.call(owner, options).targets.length, 0);
  control.disabled = false;

  node.children = { status: "none", nodes: [] };
  assert.equal(expanded.targets[0].isActionable(), false);
});

test("includes enabled directory rows only when an owner explicitly requests them", () => {
  let clicks = 0;
  const anchor = { id: "folder-icon" };
  const directoryControl = {
    dataset: { fileTreeKey: "folder" },
    disabled: false,
    querySelector() {
      return anchor;
    },
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
    entityKey: "directory-picker-a",
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
  assert.equal(scope.targets[0].anchor, anchor);
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
