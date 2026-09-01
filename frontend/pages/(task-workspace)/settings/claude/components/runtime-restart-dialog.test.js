import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./runtime-restart-dialog.js");
const restartDialog = registry.element(
  "caffold-claude-runtime-restart-dialog",
).prototype;
after(() => registry.restore());

test("provides both owned Claude restart dialog buttons", () => {
  const controls = new Map([
    ["cancel", button("Cancel")],
    ["restart", button("Restart Claude")],
  ]);
  const dialog = {
    open: true,
    querySelector: (selector) => controls.get(selector.match(/value="([^"]+)/)?.[1]),
  };
  const scope = restartDialog.actionHintScope.call({
    isConnected: true,
    dialog: () => dialog,
  });

  assert.deepEqual(
    scope.targets.map(({ id, label }) => [id, label]),
    [
      ["claude-runtime-restart:cancel", "Cancel"],
      ["claude-runtime-restart:restart", "Restart Claude"],
    ],
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
});

function button(textContent) {
  return { disabled: false, textContent, focus() {}, click() {} };
}
