import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./changes-tree.ts");
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

  const actions = {
    file: "navigation.file.open",
    disclosure: "disclosure.toggle",
  };

  assert.deepEqual(changesTree.actionHintScope.call(owner, {
    scopeId: "review:working",
    actions,
    clipRoots: [clipRoot],
  }).targets, [target]);
  assert.deepEqual(options, {
    scopeId: "review:working",
    actions,
    clipRoots: [owner, clipRoot],
  });
});
