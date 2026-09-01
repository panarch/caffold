import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
let singlePane = false;
globalThis.window = { matchMedia: () => ({ matches: singlePane }) };
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-git-log-commit-page").prototype;
after(() => {
  registry.restore();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("composes only active Commit tree/viewer leaves", () => {
  const treeTarget = { id: "file" };
  const viewerTarget = { id: "back" };
  const treeSurface = { id: "tree" };
  const viewerSurface = { id: "viewer" };
  let viewerOptions = null;
  const commitTree = {
    getClientRects: () => [{}],
    actionHintScope: () => ({ targets: [treeTarget] }),
    scrollSurfaceScope: () => ({ surfaces: [treeSurface] }),
  };
  const fileViewer = {
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
    commitTree,
    fileViewer,
    ensureRendered() {},
    currentCommitSha: () => "abcdef123456",
  };
  assert.deepEqual(page.actionHintScope.call(owner).targets, [treeTarget, viewerTarget]);
  assert.equal(viewerOptions.refreshActionId, "button.activate");
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [
    treeSurface,
    viewerSurface,
  ]);
  singlePane = true;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [viewerTarget]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
});
