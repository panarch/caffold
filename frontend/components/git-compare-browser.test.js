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
  let treeOptions = null;
  let viewerOptions = null;
  const compareTree = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      treeOptions = options;
      return { targets: [treeTarget] };
    },
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
    disclosureActionId: "disclosure.toggle",
    selectActionId: "control.select.open",
    parentActionId: "navigation.parent",
    detailsActionId: "file.details.open",
    refreshActionId: "button.activate",
    linkActionId: "link.open",
  };
  assert.deepEqual(browser.actionHintScope.call(owner, actionOptions).targets, [
    treeTarget,
    viewerTarget,
  ]);
  assert.equal(treeOptions.disclosureActionId, "disclosure.toggle");
  assert.equal(treeOptions.selectActionId, "control.select.open");
  assert.equal(viewerOptions.refreshActionId, "button.activate");
  assert.equal(viewerOptions.linkActionId, "link.open");
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, actionOptions).surfaces, [
    treeSurface,
    viewerSurface,
  ]);

  singlePane = true;
  assert.deepEqual(browser.actionHintScope.call(owner, actionOptions).targets, [viewerTarget]);
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, actionOptions).surfaces, [viewerSurface]);
});

test("composes the shared panel resizer through its public scope", () => {
  let options = null;
  let hasLayoutBox = true;
  const panelResizer = {
    getClientRects: () => hasLayoutBox ? [{}] : [],
    actionHintScope(input) {
      options = input;
      return { targets: [{ id: "separator" }] };
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    detailView: "list",
    panelResizer,
    compareTree: { actionHintScope: () => ({ targets: [] }) },
    viewer: { actionHintScope: () => ({ targets: [] }) },
    ensureRendered() {},
  };
  const actionOptions = {
    scopeId: "git:compare",
    separatorActionId: "control.separator.focus",
  };

  assert.deepEqual(browser.actionHintScope.call(owner, actionOptions).targets, [
    { id: "separator" },
  ]);
  assert.equal(options.scopeId, "git:compare");
  assert.equal(options.actionId, "control.separator.focus");
  assert.equal(options.clipRoots[0], owner);
  assert.equal(options.isCurrent(), true);
  owner.panelResizer = {};
  assert.equal(options.isCurrent(), false);

  owner.panelResizer = panelResizer;
  hasLayoutBox = false;
  assert.deepEqual(browser.actionHintScope.call(owner, actionOptions).targets, []);
});
