import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./review-panel-resizer.js");
const resizer = registry.element("caffold-review-panel-resizer").prototype;
after(() => registry.restore());

test("provides its exact visible keyboard-operable separator", () => {
  const parent = {};
  let current = true;
  const calls = [];
  const owner = {
    hidden: false,
    isConnected: true,
    parentElement: parent,
    canResize: () => true,
    getAttribute: () => "Resize review navigator",
    getClientRects: () => [{}],
    focus: (options) => calls.push(options),
  };

  const scope = resizer.actionHintScope.call(owner, {
    scopeId: "review:thread:navigator",
    actionId: "control.separator.focus",
    clipRoots: [{ id: "review" }],
    isCurrent: () => current,
  });
  assert.equal(scope.targets.length, 1);
  assert.equal(
    scope.targets[0].id,
    "review:thread:navigator:separator",
  );
  assert.equal(scope.targets[0].controlKind, "separator");
  assert.equal(scope.targets[0].label, "Resize review navigator");
  scope.targets[0].activate();
  assert.deepEqual(calls, [{ preventScroll: true }]);

  current = false;
  assert.equal(scope.targets[0].isActionable(), false);
  current = true;
  owner.parentElement = {};
  assert.equal(scope.targets[0].isActionable(), false);
  owner.parentElement = parent;
  owner.canResize = () => false;
  assert.deepEqual(resizer.actionHintScope.call(owner, {
    scopeId: "review:thread:navigator",
    actionId: "control.separator.focus",
  }).targets, []);
});
