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
    ensureRendered() {},
    taskCreate: () => ({
      keyboardNavigationContexts(options) {
        assert.equal(options.scopeId, "new");
        return [createContext];
      },
    }),
  };

  assert.deepEqual(taskNew.keyboardNavigationContexts.call(owner), [createContext]);
  owner.taskCreate = () => null;
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
    ensureRendered() {},
    querySelector: () => scrollRoot,
    taskCreate: () => taskCreate,
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
    taskCreate: () => ({ ownsEditingEscape: (element) => element === directoryInput }),
  };

  assert.equal(taskNew.ownsEditingEscape.call(owner, directoryInput), true);
  assert.equal(taskNew.ownsEditingEscape.call(owner, { id: "prompt" }), false);
  owner.hidden = true;
  assert.equal(taskNew.ownsEditingEscape.call(owner, directoryInput), false);
});

test("provides the retained New Task workspace and Task Create's folder list", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 280,
    getClientRects: () => [{}],
  };
  const folders = { id: "new:directory:scroll" };
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    selectedContextPath: () => "/repo",
    getClientRects: () => [{}],
    querySelector: () => scrollport,
    taskCreate: () => ({
      scrollSurfaceScope(options) {
        assert.equal(options.scopeId, "new");
        return { surfaces: [folders] };
      },
    }),
  };

  const scope = taskNew.scrollSurfaceScope.call(owner);
  assert.deepEqual(scope.surfaces.map(({ id }) => id), [
    "new:/repo:scroll",
    "new:directory:scroll",
  ]);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.selectedContextPath = () => "/other";
  assert.equal(scope.surfaces[0].isEligible(), false);
});
