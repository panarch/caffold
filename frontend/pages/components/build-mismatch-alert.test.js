import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./build-mismatch-alert.js");
const buildMismatchAlert = registry.element(
  "caffold-build-mismatch-alert",
).prototype;
after(() => registry.restore());

test("provides only its current visible Reload button", () => {
  const calls = [];
  const control = {
    disabled: false,
    textContent: "Reload",
    getClientRects: () => [{}],
    focus: () => calls.push("focus"),
    click: () => calls.push("click"),
  };
  let current = control;
  const owner = {
    hidden: false,
    isConnected: true,
    status: { serverLabel: "next" },
    querySelector: () => current,
  };

  const scope = buildMismatchAlert.actionHintScope.call(owner);
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label }) => [id, actionId, label]),
    [["app:build-mismatch:reload", "button.activate", "Reload"]],
  );
  assert.equal(scope.targets[0].isActionable(), true);
  scope.targets[0].activate();
  assert.deepEqual(calls, ["focus", "click"]);

  current = { ...control };
  assert.equal(scope.targets[0].isActionable(), false);
  owner.hidden = true;
  assert.deepEqual(buildMismatchAlert.actionHintScope.call(owner).targets, []);
  assert.deepEqual(
    buildMismatchAlert.actionHintScope.call(owner).mutationRoots,
    [owner],
  );
});
