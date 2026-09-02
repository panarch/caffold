import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const review = registry.element("caffold-task-review").prototype;
after(() => registry.restore());

function scope(id) {
  return { targets: [{ id }], mutationRoots: [], scrollRoots: [] };
}

test("merges Review axes with only the active navigator and selected viewer", () => {
  const calls = { working: 0, branch: 0, files: 0, viewer: 0 };
  const actionOptions = { working: null, branch: null, files: null };
  const pane = () => ({
    visible: true,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
  });
  const panes = { navigator: pane(), viewer: pane() };
  const owner = {
    active: true,
    hidden: false,
    task: { threadId: "thread-a", worktree: { rootPath: "/repo" } },
    contextKey: "thread-a\0/repo\0/repo",
    route: { navigator: "changes", scope: "working", viewer: "diff", path: "" },
    ensureRendered() {},
    querySelector(selector) {
      if (selector.includes("empty-action")) return null;
      if (selector.includes("navigator-pane")) return panes.navigator;
      if (selector.includes("viewer-pane")) return panes.viewer;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    axisControl(axis) {
      return { actionHintScope: () => scope(`${axis}-axis`) };
    },
    workingTree() {
      return { actionHintScope: (options) => {
        calls.working += 1;
        actionOptions.working = options;
        return scope("working");
      } };
    },
    branchTree() {
      return { actionHintScope: (options) => {
        calls.branch += 1;
        actionOptions.branch = options;
        return scope("branch");
      } };
    },
    fileNavigator() {
      return { actionHintScope: (options) => {
        calls.files += 1;
        actionOptions.files = options;
        return scope("files");
      } };
    },
    viewer() {
      return { actionHintScope: () => {
        calls.viewer += 1;
        return scope("viewer");
      } };
    },
  };

  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "viewer-axis", "working"],
  );
  assert.deepEqual(calls, { working: 1, branch: 0, files: 0, viewer: 0 });
  assert.equal(actionOptions.working.disclosureActionId, "disclosure.toggle");

  owner.route = { ...owner.route, scope: "branch", path: "src/a.js" };
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "viewer-axis", "branch", "viewer"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 0, viewer: 1 });
  assert.equal(actionOptions.branch.disclosureActionId, "disclosure.toggle");

  owner.route = { ...owner.route, navigator: "files" };
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "viewer-axis", "files", "viewer"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 1, viewer: 2 });
  assert.equal(actionOptions.files.disclosureActionId, "disclosure.toggle");

  panes.navigator.visible = false;
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["viewer-axis", "viewer"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 1, viewer: 3 });

  panes.navigator.visible = true;
  panes.viewer.visible = false;
  owner.route = { ...owner.route, path: "" };
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "files"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 2, viewer: 3 });
});

test("composes the shared Review panel resizer through its public scope", () => {
  let options = null;
  const panelResizer = {
    actionHintScope(input) {
      options = input;
      return scope("separator");
    },
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    task: { threadId: "thread-a" },
    contextKey: "thread-a\0/repo",
    route: { navigator: "changes", scope: "working", path: "" },
    ensureRendered() {},
    querySelector(selector) {
      if (selector.includes("empty-action")) return null;
      return { getClientRects: () => [{}] };
    },
    axisControl: () => null,
    workingTree: () => ({ actionHintScope: () => scope("working") }),
    resizer: () => panelResizer,
  };

  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["working", "separator"],
  );
  assert.equal(options.actionId, "control.separator.focus");
  assert.equal(options.isCurrent(), true);
  owner.contextKey = "thread-a\0/other";
  assert.equal(options.isCurrent(), false);
});

test("merges only visible Review navigator and viewer Scroll leaves", () => {
  const navigatorSurface = { id: "working-tree" };
  const viewerSurface = { id: "diff" };
  const pane = () => ({
    visible: true,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
  });
  const panes = { navigator: pane(), viewer: pane() };
  const owner = {
    active: true,
    hidden: false,
    task: { threadId: "thread-a" },
    contextKey: "thread-a\0/repo",
    route: { navigator: "changes", scope: "working", path: "src/a.js" },
    ensureRendered() {},
    querySelector(selector) {
      return selector.includes("navigator-pane") ? panes.navigator : panes.viewer;
    },
    workingTree: () => ({
      scrollSurfaceScope: () => ({ surfaces: [navigatorSurface] }),
    }),
    branchTree: () => null,
    fileNavigator: () => null,
    viewer: () => ({
      scrollSurfaceScope: () => ({ surfaces: [viewerSurface] }),
    }),
  };

  assert.deepEqual(
    review.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface, viewerSurface],
  );
  panes.navigator.visible = false;
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
  panes.viewer.visible = false;
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, []);
});
