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
    workspace.workspaceScrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface],
  );
  assert.equal(calls, 1);

  owner.hidden = true;
  assert.deepEqual(
    workspace.workspaceScrollSurfaceScope.call(owner).surfaces,
    [],
  );
  assert.equal(calls, 1);
});
