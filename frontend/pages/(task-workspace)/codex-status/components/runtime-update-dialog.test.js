import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./runtime-update-dialog.js");
const updateDialog = registry.element(
  "caffold-codex-runtime-update-dialog",
).prototype;
after(() => registry.restore());

test("provides both owned Codex update dialog buttons", () => {
  const calls = [];
  const controls = new Map([
    ["cancel", button("Cancel", calls)],
    ["update", button("Update Codex", calls)],
  ]);
  const dialog = {
    open: true,
    querySelector: (selector) => controls.get(selector.match(/value="([^"]+)/)?.[1]),
  };
  const owner = {
    isConnected: true,
    dialog: () => dialog,
  };

  const scope = updateDialog.actionHintScope.call(owner);
  assert.deepEqual(
    scope.targets.map(({ id, label }) => [id, label]),
    [
      ["codex-runtime-update:cancel", "Cancel"],
      ["codex-runtime-update:update", "Update Codex"],
    ],
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
  scope.targets[1].activate();
  assert.deepEqual(calls, ["focus:Update Codex", "click:Update Codex"]);
});

function button(label, calls) {
  return {
    disabled: false,
    textContent: label,
    focus: () => calls.push(`focus:${label}`),
    click: () => calls.push(`click:${label}`),
  };
}
