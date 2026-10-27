import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./git-compare-tree.js");
const compareTree = registry.element("caffold-git-compare-tree").prototype;
after(() => registry.restore());

// A compare tree whose own declarations make `ownTargets` and whose drawn
// File Tree is `tree`.
function compareTreeWith({ status = "ready", tree = null, ownTargets = [] } = {}) {
  const owner = Object.create(compareTree);
  return Object.assign(owner, {
    state: { status },
    hints: {
      scope: () => ({ blocked: false, targets: ownTargets, mutationRoots: [owner], scrollRoots: [] }),
    },
    tree: { value: tree },
  });
}

test("passes the pull to the File Tree it draws once the compare is ready", () => {
  const target = { id: "directory-src" };
  let received = null;
  const tree = {
    actionHintScope(pull) {
      received = pull;
      return { targets: [target] };
    },
  };
  const owner = compareTreeWith({ tree });
  const clipRoot = {};
  const actions = { file: "navigation.file.open", disclosure: "disclosure.toggle" };

  assert.deepEqual(owner.actionHintScope({
    scopeId: "git:compare",
    actions,
    clipRoots: [clipRoot],
  }).targets, [target]);
  assert.deepEqual(received, {
    scopeId: "git:compare",
    actions,
    clipRoots: [owner, clipRoot],
  });

  owner.state = { status: "loading" };
  assert.deepEqual(owner.actionHintScope({ scopeId: "git:compare", actions }).targets, []);
});

test("puts its base select before the File Tree's targets", () => {
  const owner = compareTreeWith({
    tree: { actionHintScope: () => ({ targets: [{ id: "review:branch:file" }] }) },
    ownTargets: [{ id: "review:branch:base-ref" }],
  });

  assert.deepEqual(
    owner.actionHintScope({ scopeId: "review:branch" }).targets.map(({ id }) => id),
    ["review:branch:base-ref", "review:branch:file"],
  );
});
