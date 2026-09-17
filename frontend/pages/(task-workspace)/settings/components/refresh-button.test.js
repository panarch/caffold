import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./refresh-button.js");
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

test("disables Refresh while refreshing or disabled and turns its icon only while refreshing", () => {
  const classes = new Set();
  const owner = {
    mount() {},
    button: {
      disabled: false,
      classList: {
        toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
      },
    },
  };

  refreshButton.setState.call(owner, { refreshing: true });
  assert.equal(owner.button.disabled, true);
  assert.equal(classes.has("is-refreshing"), true);

  refreshButton.setState.call(owner, { disabled: true });
  assert.equal(owner.button.disabled, true);
  assert.equal(classes.has("is-refreshing"), false);

  refreshButton.setState.call(owner, {});
  assert.equal(owner.button.disabled, false);
  assert.equal(classes.has("is-refreshing"), false);
});
