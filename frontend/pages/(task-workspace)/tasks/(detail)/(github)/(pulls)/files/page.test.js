import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
globalThis.window = {};
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
  const shown = { list: true, detail: true };
  const split = {
    listShown: () => shown.list,
    detailShown: () => shown.detail,
    actionHintScope(options) {
      resizerOptions = options;
      return { targets: shown.list ? [{ id: "separator" }] : [] };
    },
  };
  const owner = {
    hidden: false,
    detailView: "viewer",
    tree,
    fileViewer,
    split,
    currentPullNumber: () => 7,
  };

  assert.deepEqual(page.actionHintScope.call(owner).targets, [
    treeTarget,
    { id: "separator" },
    viewerTarget,
  ]);
  assert.equal(treeActionOptions.actions.disclosure, "disclosure.toggle");
  assert.equal(viewerActionOptions.actions.refresh, "button.activate");
  assert.equal(viewerActionOptions.actions.link, "link.open");
  assert.equal(resizerOptions.actionId, "control.separator.focus");
  assert.deepEqual(
    page.scrollSurfaceScope.call(owner).surfaces,
    [treeSurface, viewerSurface],
  );

  shown.list = false;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [viewerTarget]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
  shown.list = true;
  shown.detail = false;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [
    treeTarget,
    { id: "separator" },
  ]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [treeSurface]);
});
