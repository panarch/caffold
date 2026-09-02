import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./compare-tree.js");
const compareTree = registry.element("caffold-git-compare-tree").prototype;
after(() => registry.restore());

test("forwards file and disclosure semantics to its retained File Tree", () => {
  const target = { id: "directory-src" };
  let options = null;
  const tree = {
    actionHintScope(input) {
      options = input;
      return { targets: [target] };
    },
  };
  const owner = {
    hidden: false,
    state: { status: "ready" },
    selectedPath: "src/a.js",
    fileTree: () => tree,
  };
  const clipRoot = {};

  assert.deepEqual(compareTree.actionHintScope.call(owner, {
    scopeId: "git:compare",
    actionId: "navigation.file.open",
    disclosureActionId: "disclosure.toggle",
    clipRoots: [clipRoot],
  }).targets, [target]);
  assert.equal(options.actionId, "navigation.file.open");
  assert.equal(options.disclosureActionId, "disclosure.toggle");
  assert.deepEqual(options.clipRoots, [owner, clipRoot]);
  assert.equal(options.isCurrent({ source: { path: "src/a.js" } }), true);
});

test("composes its retained base select independently of File Tree readiness", () => {
  const calls = [];
  const control = {
    hidden: false,
    disabled: false,
    focus: (options) => calls.push(["focus", options]),
    showPicker: () => calls.push(["showPicker"]),
  };
  const anchor = {};
  const owner = Object.assign(Object.create(compareTree), {
    hidden: false,
    isConnected: true,
    state: { status: "loading" },
    baseSelection: {
      enabled: true,
      refs: [
        { name: "origin/main", kind: "remote" },
        { name: "origin/release", kind: "remote" },
      ],
      value: "origin/main",
    },
    fileTree: () => null,
    baseRefSelect: () => control,
    querySelector: (selector) => selector === ".compare-tree-primary"
      ? anchor
      : null,
  });
  const clipRoot = {};

  for (const status of ["loading", "error", "ready"]) {
    owner.state = status === "ready"
      ? { status, comparePayload: { files: [] } }
      : { status };
    const scope = owner.actionHintScope({
      scopeId: "review:branch",
      selectActionId: "control.select.open",
      clipRoots: [clipRoot],
    });
    assert.equal(scope.targets.length, 1);
    const [target] = scope.targets;
    assert.equal(target.id, "review:branch:base-ref");
    assert.equal(target.actionId, "control.select.open");
    assert.equal(
      target.label,
      "Choose comparison base (current origin/main)",
    );
    assert.equal(target.controlKind, "select");
    assert.equal(target.control, control);
    assert.equal(target.anchor, anchor);
    assert.deepEqual(target.clipRoots, [owner, clipRoot]);
    assert.deepEqual(scope.mutationRoots, [owner]);
  }

  const [target] = owner.actionHintScope({
    scopeId: "review:branch",
    selectActionId: "control.select.open",
  }).targets;
  target.activate();
  assert.deepEqual(calls, [
    ["focus", { preventScroll: true }],
    ["showPicker"],
  ]);
});

test("merges the base select before ready File Tree targets", () => {
  const selectControl = {
    hidden: false,
    disabled: false,
    focus() {},
  };
  const selectAnchor = {};
  let treeOptions = null;
  const treeTarget = { id: "review:branch:file" };
  const tree = {
    actionHintScope(options) {
      treeOptions = options;
      return { targets: [treeTarget] };
    },
  };
  const owner = Object.assign(Object.create(compareTree), {
    hidden: false,
    isConnected: true,
    state: { status: "ready", comparePayload: { files: [{}] } },
    selectedPath: "src/a.js",
    baseSelection: {
      enabled: true,
      refs: [{ name: "origin/main", kind: "remote" }],
      value: "origin/main",
    },
    fileTree: () => tree,
    baseRefSelect: () => selectControl,
    querySelector: (selector) => selector === ".compare-tree-primary"
      ? selectAnchor
      : null,
  });

  const scope = owner.actionHintScope({
    scopeId: "review:branch",
    actionId: "navigation.file.open",
    disclosureActionId: "disclosure.toggle",
    selectActionId: "control.select.open",
  });

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "review:branch:base-ref",
    "review:branch:file",
  ]);
  assert.equal(treeOptions.actionId, "navigation.file.open");
  assert.equal(treeOptions.disclosureActionId, "disclosure.toggle");
});

test("keeps value-only updates actionable and rejects stale base controls", () => {
  let currentControl = {
    hidden: false,
    disabled: false,
    focus() {},
  };
  let currentAnchor = {};
  const owner = Object.assign(Object.create(compareTree), {
    hidden: false,
    isConnected: true,
    state: { status: "loading" },
    baseSelection: {
      enabled: true,
      refs: [
        { name: "origin/main", kind: "remote" },
        { name: "origin/release", kind: "remote" },
      ],
      value: "origin/main",
    },
    fileTree: () => null,
    baseRefSelect: () => currentControl,
    querySelector: (selector) => selector === ".compare-tree-primary"
      ? currentAnchor
      : null,
  });

  const scope = owner.actionHintScope({
    scopeId: "review:branch",
    selectActionId: "control.select.open",
  });
  const [target] = scope.targets;
  owner.baseSelection = { ...owner.baseSelection, value: "origin/release" };
  const [updatedTarget] = owner.actionHintScope({
    scopeId: "review:branch",
    selectActionId: "control.select.open",
  }).targets;
  assert.equal(updatedTarget.id, target.id);
  assert.equal(updatedTarget.control, target.control);
  assert.equal(updatedTarget.anchor, target.anchor);
  assert.equal(
    updatedTarget.label,
    "Choose comparison base (current origin/release)",
  );
  assert.equal(target.isActionable(), true);

  target.control.disabled = true;
  assert.equal(target.isActionable(), false);
  target.control.disabled = false;
  owner.hidden = true;
  assert.equal(target.isActionable(), false);
  owner.hidden = false;
  owner.isConnected = false;
  assert.equal(target.isActionable(), false);
  owner.isConnected = true;
  currentControl = { hidden: false, disabled: false, focus() {} };
  assert.equal(target.isActionable(), false);
  currentControl = target.control;
  currentAnchor = {};
  assert.equal(target.isActionable(), false);
  currentAnchor = target.anchor;
  owner.baseSelection = { enabled: false, refs: [], value: "" };
  assert.equal(target.isActionable(), false);
  assert.deepEqual(owner.actionHintScope({
    scopeId: "review:branch",
    selectActionId: "control.select.open",
  }).targets, []);

  owner.baseSelection = {
    enabled: true,
    refs: [{ name: "origin/main", kind: "remote" }],
    value: "",
  };
  const [unselectedTarget] = owner.actionHintScope({
    scopeId: "review:branch",
    selectActionId: "control.select.open",
  }).targets;
  assert.equal(unselectedTarget.label, "Choose comparison base");
  assert.equal(unselectedTarget.isActionable(), true);
});

test("omits unavailable base selections", () => {
  const control = { hidden: false, disabled: false, focus() {} };
  const owner = Object.assign(Object.create(compareTree), {
    hidden: false,
    isConnected: true,
    state: { status: "loading" },
    baseSelection: {
      enabled: true,
      refs: [{ name: "origin/main", kind: "remote" }],
      value: "origin/main",
    },
    fileTree: () => null,
    baseRefSelect: () => control,
    querySelector: () => ({}),
  });
  const targets = () => owner.actionHintScope({
    scopeId: "review:branch",
    selectActionId: "control.select.open",
  }).targets;

  owner.hidden = true;
  assert.deepEqual(targets(), []);
  owner.hidden = false;
  owner.isConnected = false;
  assert.deepEqual(targets(), []);
  owner.isConnected = true;
  control.hidden = true;
  assert.deepEqual(targets(), []);
  control.hidden = false;
  control.disabled = true;
  assert.deepEqual(targets(), []);
  control.disabled = false;
  owner.baseSelection = { enabled: false, refs: [], value: "" };
  assert.deepEqual(targets(), []);
});
