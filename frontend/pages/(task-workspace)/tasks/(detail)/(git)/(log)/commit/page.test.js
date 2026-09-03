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
  let resizerOptions = null;
  let treeOptions = null;
  let viewerOptions = null;
  const commitTree = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      treeOptions = options;
      return { targets: [treeTarget] };
    },
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
    commitTree,
    fileViewer,
    panelResizer,
    ensureRendered() {},
    currentCommitSha: () => "abcdef123456",
  };
  assert.deepEqual(page.actionHintScope.call(owner).targets, [
    treeTarget,
    { id: "separator" },
    viewerTarget,
  ]);
  assert.equal(treeOptions.disclosureActionId, "disclosure.toggle");
  assert.equal(viewerOptions.refreshActionId, "button.activate");
  assert.equal(viewerOptions.linkActionId, "link.open");
  assert.equal(resizerOptions.actionId, "control.separator.focus");
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [
    treeSurface,
    viewerSurface,
  ]);
  singlePane = true;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [viewerTarget]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
});
