import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./runtime-restart-dialog.js");
const restartDialog = registry.element(
  "caffold-codex-runtime-restart-dialog",
).prototype;
after(() => registry.restore());

test("provides both owned Codex restart dialog buttons", () => {
  const calls = [];
  const controls = new Map([
    ["cancel", button("Cancel", calls)],
    ["restart", button("Restart Codex", calls)],
  ]);
  const dialog = {
    open: true,
    querySelector: (selector) => controls.get(selector.match(/value="([^"]+)/)?.[1]),
  };
  const owner = {
    isConnected: true,
    dialog: () => dialog,
  };

  const scope = restartDialog.actionHintScope.call(owner);
  assert.deepEqual(
    scope.targets.map(({ id, label }) => [id, label]),
    [
      ["codex-runtime-restart:cancel", "Cancel"],
      ["codex-runtime-restart:restart", "Restart Codex"],
    ],
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
  scope.targets[1].activate();
  assert.deepEqual(calls, ["focus:Restart Codex", "click:Restart Codex"]);
});

function button(label, calls) {
  return {
    disabled: false,
    textContent: label,
    focus: () => calls.push(`focus:${label}`),
    click: () => calls.push(`click:${label}`),
  };
}
