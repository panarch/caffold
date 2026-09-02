import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
let singlePane = false;
globalThis.window = {
  matchMedia: () => ({ matches: singlePane }),
};
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-pull-files-page").prototype;
after(() => {
  registry.restore();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("composes active PR tree/viewer actions and Scroll leaves", () => {
  const treeTarget = { id: "file" };
  const viewerTarget = { id: "back" };
  const treeSurface = { id: "tree-scroll" };
  const viewerSurface = { id: "diff-scroll" };
  let resizerOptions = null;
  let treeActionOptions = null;
  let viewerActionOptions = null;
  const tree = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      treeActionOptions = options;
      return { targets: [treeTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [treeSurface] }),
  };
  const fileViewer = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      viewerActionOptions = options;
      return { targets: [viewerTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [viewerSurface] }),
  };
  const panelResizer = {
    getClientRects: () => singlePane ? [] : [{}],
    actionHintScope(options) {
      resizerOptions = options;
      return { targets: [{ id: "separator" }] };
    },
  };
  const owner = {
    hidden: false,
    detailView: "viewer",
    tree,
    fileViewer,
    panelResizer,
    ensureRendered() {},
    currentPullNumber: () => 7,
  };

  assert.deepEqual(page.actionHintScope.call(owner).targets, [
    treeTarget,
    { id: "separator" },
    viewerTarget,
  ]);
  assert.equal(treeActionOptions.disclosureActionId, "disclosure.toggle");
  assert.equal(viewerActionOptions.refreshActionId, "button.activate");
  assert.equal(resizerOptions.actionId, "control.separator.focus");
  assert.deepEqual(
    page.scrollSurfaceScope.call(owner).surfaces,
    [treeSurface, viewerSurface],
  );

  singlePane = true;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [viewerTarget]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
});
