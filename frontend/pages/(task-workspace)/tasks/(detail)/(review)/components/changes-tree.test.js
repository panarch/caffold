import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./changes-tree.js");
const changesTree = registry.element("caffold-git-diff-changes-tree").prototype;
after(() => registry.restore());

test("forwards file and disclosure semantics to its retained File Tree", () => {
  const target = { id: "directory-src" };
  let options = null;
  const tree = {
    actionHintScope(input) {
      options = input;
      return { targets: [target] };
    },
  };
  const owner = {
    hidden: false,
    state: { status: "ready" },
    selectedPath: "src/a.js",
    fileTree: () => tree,
  };
  const clipRoot = {};

  assert.deepEqual(changesTree.actionHintScope.call(owner, {
    scopeId: "review:working",
    actionId: "navigation.file.open",
    disclosureActionId: "disclosure.toggle",
    clipRoots: [clipRoot],
  }).targets, [target]);
  assert.equal(options.actionId, "navigation.file.open");
  assert.equal(options.disclosureActionId, "disclosure.toggle");
  assert.deepEqual(options.clipRoots, [owner, clipRoot]);
  assert.equal(options.isCurrent({ source: { path: "src/a.js" } }), true);
});
