import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./refresh-button.ts");
const refreshButton = registry.element("caffold-settings-refresh-button").prototype;
after(() => registry.restore());

test("provides its Refresh action only while it can be pressed", () => {
  const button = {
    disabled: false,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  const owner = { isConnected: true, button };
  let current = true;
  const scope = refreshButton.actionHintScope.call(owner, {
    scopeId: "settings:grok",
    isCurrent: () => current,
  });

  assert.deepEqual(scope.targets.map(({ id, label }) => [id, label]), [
    ["settings:grok:refresh", "Refresh"],
  ]);
  assert.equal(scope.targets[0].isActionable(), true);
  current = false;
  assert.equal(scope.targets[0].isActionable(), false);
  current = true;
  button.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
  assert.deepEqual(
    refreshButton.actionHintScope.call(owner, { scopeId: "settings:grok" }).targets,
    [],
  );
});
