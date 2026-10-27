import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const taskNew = registry.element("caffold-task-new").prototype;
after(() => registry.restore());

test("offers Task Create's popovers while shown", () => {
  const createContext = { id: "task-create-popover" };
  const owner = {
    hidden: false,
    performUpdate() {},
    create: {
      value: {
        keyboardNavigationContexts(options) {
          assert.equal(options.scopeId, "new");
          return [createContext];
        },
      },
    },
  };

  assert.deepEqual(taskNew.keyboardNavigationContexts.call(owner), [createContext]);
  owner.create = { value: undefined };
  assert.deepEqual(taskNew.keyboardNavigationContexts.call(owner), []);
  owner.hidden = true;
  assert.deepEqual(taskNew.keyboardNavigationContexts.call(owner), []);
});

test("combines Task Create's actions and folder list with its own workspace", () => {
  const scrollRoot = { id: "workspace" };
  const createTarget = { id: "directory-toggle" };
  const taskCreate = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "new");
      return { targets: [createTarget], mutationRoots: [taskCreate] };
    },
  };
  const owner = {
    performUpdate() {},
    workspace: { value: scrollRoot },
    create: { value: taskCreate },
  };

  assert.deepEqual(taskNew.actionHintScope.call(owner), {
    blocked: false,
    targets: [createTarget],
    mutationRoots: [taskCreate],
    scrollRoots: [scrollRoot],
  });
});

test("Escape belongs to Task Create's directory path only while New Task shows", () => {
  const directoryInput = { id: "directory-input" };
  const owner = {
    hidden: false,
    create: {
      value: { ownsEditingEscape: (element) => element === directoryInput },
    },
  };

  assert.equal(taskNew.ownsEditingEscape.call(owner, directoryInput), true);
  assert.equal(taskNew.ownsEditingEscape.call(owner, { id: "prompt" }), false);
  owner.hidden = true;
  assert.equal(taskNew.ownsEditingEscape.call(owner, directoryInput), false);
});

test("names its workspace New Task, beside Task Create's folder list", () => {
  const workspace = { id: "workspace" };
  const pulls = [];
  const owner = {
    workspace: { value: workspace },
    surfaces: {
      scope(pull) {
        pulls.push(["own", pull]);
        return { surfaces: [{ id: "new:/repo:scroll", label: pull.label }] };
      },
    },
    create: {
      value: {
        scrollSurfaceScope(pull) {
          pulls.push(["create", pull]);
          return { surfaces: [{ id: "new:directory:scroll", label: "Folders" }] };
        },
      },
    },
  };

  assert.deepEqual(
    taskNew.scrollSurfaceScope.call(owner).surfaces.map(({ label }) => label),
    ["New Task", "Folders"],
  );
  assert.deepEqual(pulls, [
    ["own", { label: "New Task" }],
    ["create", { scopeId: "new", clipRoots: [owner, workspace] }],
  ]);
});

test("a chosen directory becomes the route; a start request goes on", () => {
  const routes = [];
  let synced = 0;
  let stopped = 0;
  const owner = {
    cwd: ".",
    syncTaskCreate: () => { synced += 1; },
    dispatchEvent: (event) => routes.push(event.detail.route),
  };
  const intent = (detail) => ({
    detail,
    stopPropagation: () => { stopped += 1; },
  });

  taskNew.chooseCwd.call(owner, intent({ type: "start" }));
  assert.deepEqual([routes, synced, stopped], [[], 0, 0]);

  taskNew.chooseCwd.call(owner, intent({ type: "choose-cwd", path: "repo/app/" }));
  assert.equal(owner.cwd, "repo/app");
  assert.deepEqual(routes, [{ kind: "tasks", new: true, cwd: "repo/app" }]);
  assert.deepEqual([synced, stopped], [1, 1]);
});
