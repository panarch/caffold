import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./list.js");
const list = registry.element("caffold-file-list").prototype;
after(() => registry.restore());

test("merges Refresh files with the owned tree and delegates Scroll", () => {
  const treeTarget = { id: "file-a" };
  const treeSurface = { id: "file-tree" };
  let treeActionOptions = null;
  let treeScrollOptions = null;
  let tree = {
    actionHintScope(options) {
      treeActionOptions = options;
      return { targets: [treeTarget], mutationRoots: [tree] };
    },
    scrollSurfaceScope(options) {
      treeScrollOptions = options;
      return { surfaces: [treeSurface] };
    },
  };
  const refresh = {
    disabled: false,
    getAttribute: () => "Refresh files",
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready" },
    selectedPath: "src/a.js",
    fileTree() {
      return list.fileTree.call(this);
    },
    querySelector(selector) {
      return selector === "caffold-file-tree" ? tree : refresh;
    },
  };
  const scope = list.actionHintScope.call(owner, {
    scopeId: "review:files",
    actionId: "navigation.file.open",
    disclosureActionId: "disclosure.toggle",
    refreshActionId: "button.activate",
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "review:files:refresh",
    "file-a",
  ]);
  assert.equal(treeActionOptions.actionId, "navigation.file.open");
  assert.equal(treeActionOptions.disclosureActionId, "disclosure.toggle");
  assert.equal(scope.targets[0].isActionable(), true);

  const scrollScope = list.scrollSurfaceScope.call(owner, {
    scopeId: "review:files",
  });
  assert.deepEqual(scrollScope.surfaces, [treeSurface]);
  assert.equal(treeScrollOptions.label, "Files");
  assert.equal(treeScrollOptions.isCurrent(), true);
  tree = {};
  assert.equal(treeScrollOptions.isCurrent(), false);
});
