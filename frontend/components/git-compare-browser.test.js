import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
let singlePane = false;
globalThis.window = { matchMedia: () => ({ matches: singlePane }) };
const registry = installCustomElementUnitRegistry();
await import("./git-compare-browser.js");
const browser = registry.element("caffold-git-compare-browser").prototype;
after(() => {
  registry.restore();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("composes only active Compare tree/viewer leaves", () => {
  const treeTarget = { id: "file" };
  const viewerTarget = { id: "back" };
  const treeSurface = { id: "tree" };
  const viewerSurface = { id: "viewer" };
  let viewerOptions = null;
  const compareTree = {
    getClientRects: () => [{}],
    actionHintScope: () => ({ targets: [treeTarget] }),
    scrollSurfaceScope: () => ({ surfaces: [treeSurface] }),
  };
  const viewer = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      viewerOptions = options;
      return { targets: [viewerTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [viewerSurface] }),
  };
  const owner = {
    hidden: false,
    detailView: "viewer",
    compareTree,
    viewer,
    ensureRendered() {},
  };
  const actionOptions = {
    scopeId: "git:compare",
    fileActionId: "navigation.file.open",
    parentActionId: "navigation.parent",
    detailsActionId: "file.details.open",
    refreshActionId: "button.activate",
  };
  assert.deepEqual(browser.actionHintScope.call(owner, actionOptions).targets, [
    treeTarget,
    viewerTarget,
  ]);
  assert.equal(viewerOptions.refreshActionId, "button.activate");
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, actionOptions).surfaces, [
    treeSurface,
    viewerSurface,
  ]);

  singlePane = true;
  assert.deepEqual(browser.actionHintScope.call(owner, actionOptions).targets, [viewerTarget]);
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, actionOptions).surfaces, [viewerSurface]);
});
