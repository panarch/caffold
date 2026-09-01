import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const taskNew = registry.element("caffold-task-new").prototype;
after(() => registry.restore());

test("merges Task Create popovers and Directory Picker modal independently", () => {
  const createContext = { id: "task-create-popover" };
  const directoryContext = { id: "directory-picker" };
  const owner = {
    hidden: false,
    ensureRendered() {},
    taskCreate: () => ({
      keyboardNavigationContexts(options) {
        assert.equal(options.scopeId, "new");
        return [createContext];
      },
    }),
    directoryPicker: () => ({
      keyboardNavigationContexts: () => [directoryContext],
    }),
  };

  assert.deepEqual(
    taskNew.keyboardNavigationContexts.call(owner),
    [createContext, directoryContext],
  );
  owner.taskCreate = () => null;
  assert.deepEqual(
    taskNew.keyboardNavigationContexts.call(owner),
    [directoryContext],
  );
  owner.hidden = true;
  assert.deepEqual(taskNew.keyboardNavigationContexts.call(owner), []);
});

test("provides only the retained overflowing New Task workspace", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 280,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    selectedContextPath: () => "/repo",
    getClientRects: () => [{}],
    querySelector: () => scrollport,
  };

  const scope = taskNew.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].id, "new:/repo:scroll");
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.selectedContextPath = () => "/other";
  assert.equal(scope.surfaces[0].isEligible(), false);
});
