import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const buildInfoHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("build-info.js")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const BUILD_INFO={id:'test',version:'test',number:0}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const workspace = registry.element("caffold-task-workspace").prototype;
after(() => {
  registry.restore();
  buildInfoHook.deregister();
});

test("keeps the visible Task navigator scope when the detail-side Tasks host is hidden", () => {
  const navigatorSurface = { id: "task-list" };
  let calls = 0;
  const tasksPage = {
    getClientRects: () => [],
    scrollSurfaceScope() {
      calls += 1;
      return { surfaces: [navigatorSurface] };
    },
  };
  const owner = {
    hidden: false,
    mode: "tasks",
    tasksPage,
  };

  assert.deepEqual(
    workspace.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface],
  );
  assert.equal(calls, 1);

  owner.hidden = true;
  assert.deepEqual(
    workspace.scrollSurfaceScope.call(owner).surfaces,
    [],
  );
  assert.equal(calls, 1);
});

test("composes the navigation pane resizer through its public scope", () => {
  let options = null;
  const masterResizer = {
    getClientRects: () => [{}],
    actionHintScope(input) {
      options = input;
      return { targets: [{ id: "separator" }] };
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    mode: "tasks",
    masterResizer,
    masterDetail: {},
    masterPane: null,
    backButton: null,
    closeButton: null,
    navigation: null,
    tasksPage: null,
    querySelector: () => null,
  };

  assert.deepEqual(workspace.actionHintScope.call(owner).targets, [
    { id: "separator" },
  ]);
  assert.equal(options.scopeId, "workspace:navigation-pane");
  assert.equal(options.actionId, "control.separator.focus");
  assert.deepEqual(options.clipRoots, [owner, owner.masterDetail]);
  assert.equal(options.isCurrent(), true);
  owner.masterResizer = { getClientRects: () => [{}] };
  assert.equal(options.isCurrent(), false);
});
