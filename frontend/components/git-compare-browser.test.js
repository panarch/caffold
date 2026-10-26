import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
let singlePane = false;
globalThis.window = { matchMedia: () => ({ matches: singlePane }) };
const registry = installCustomElementUnitRegistry();
await import("./git-compare-browser.ts");
const browser = registry.element("caffold-git-compare-browser").prototype;
after(() => {
  registry.restore();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("composes only the Compare tree and viewer that are shown", () => {
  const treeTarget = { id: "file" };
  const viewerTarget = { id: "back" };
  const treeSurface = { id: "tree" };
  const viewerSurface = { id: "viewer" };
  let treePull = null;
  let viewerPull = null;
  const compareTree = {
    actionHintScope(pull) {
      treePull = pull;
      return { targets: [treeTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [treeSurface] }),
  };
  const viewer = {
    actionHintScope(pull) {
      viewerPull = pull;
      return { targets: [viewerTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [viewerSurface] }),
  };
  const owner = {
    detailView: "viewer",
    compareTree,
    viewer,
    panelResizer: {
      collapsed: false,
      actionHintScope: () => ({ targets: [] }),
    },
    sidePaneCollapsed: browser.sidePaneCollapsed,
  };
  const actions = {
    file: "navigation.file.open",
    disclosure: "disclosure.toggle",
    select: "control.select.open",
    parent: "navigation.parent",
    details: "file.details.open",
    refresh: "button.activate",
    link: "link.open",
  };
  const pull = { scopeId: "git:compare", actions };
  assert.deepEqual(browser.actionHintScope.call(owner, pull).targets, [
    treeTarget,
    viewerTarget,
  ]);
  assert.deepEqual(treePull, { ...pull, scopeId: "git:compare:compare", clipRoots: [owner] });
  assert.deepEqual(viewerPull, { ...pull, scopeId: "git:compare:viewer", clipRoots: [owner] });
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, pull).surfaces, [
    treeSurface,
    viewerSurface,
  ]);

  owner.panelResizer.collapsed = true;
  assert.deepEqual(browser.actionHintScope.call(owner, pull).targets, [viewerTarget]);
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, pull).surfaces, [viewerSurface]);
  owner.panelResizer.collapsed = false;

  singlePane = true;
  assert.deepEqual(browser.actionHintScope.call(owner, pull).targets, [viewerTarget]);
  assert.deepEqual(browser.scrollSurfaceScope.call(owner, pull).surfaces, [viewerSurface]);
  singlePane = false;
});

test("hands the resizer its separator action", () => {
  let received = null;
  const owner = {
    detailView: "list",
    panelResizer: {
      actionHintScope(pull) {
        received = pull;
        return { targets: [{ id: "git:compare:separator" }] };
      },
    },
    sidePaneCollapsed: browser.sidePaneCollapsed,
    compareTree: { actionHintScope: () => ({ targets: [] }) },
    viewer: { actionHintScope: () => ({ targets: [] }) },
  };

  assert.deepEqual(browser.actionHintScope.call(owner, {
    scopeId: "git:compare",
    actions: { separator: "control.separator.focus" },
  }).targets, [{ id: "git:compare:separator" }]);
  assert.deepEqual(received, {
    scopeId: "git:compare",
    actionId: "control.separator.focus",
    clipRoots: [owner],
  });
});
