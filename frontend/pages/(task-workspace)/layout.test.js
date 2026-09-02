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

test("composes the exact visible workspace separator as a focus target", () => {
  const previousWindow = globalThis.window;
  let wide = true;
  globalThis.window = { matchMedia: () => ({ matches: wide }) };
  try {
    let focused = 0;
    const control = {
      getAttribute: () => "Resize navigation pane",
      getClientRects: () => [{}],
      focus() {
        focused += 1;
      },
    };
    const owner = {
      hidden: false,
      isConnected: true,
      mode: "tasks",
      masterResizer: control,
      masterDetail: {},
      masterPane: null,
      backButton: null,
      closeButton: null,
      navigation: null,
      tasksPage: null,
      querySelector: () => null,
    };

    const scope = workspace.actionHintScope.call(owner);
    assert.equal(scope.targets.length, 1);
    assert.equal(scope.targets[0].id, "workspace:navigation-pane:separator");
    assert.equal(scope.targets[0].controlKind, "separator");
    assert.deepEqual(scope.mutationRoots, [control]);
    scope.targets[0].activate();
    assert.equal(focused, 1);

    wide = false;
    assert.equal(scope.targets[0].isActionable(), false);
    assert.deepEqual(workspace.actionHintScope.call(owner).targets, []);
    wide = true;
    owner.masterResizer = { getClientRects: () => [{}] };
    assert.equal(scope.targets[0].isActionable(), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
