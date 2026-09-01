import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./archived-delete-dialog.js");
const deleteDialog = registry.element("caffold-task-archived-delete-dialog").prototype;
after(() => registry.restore());

test("binds Cancel and Delete to the pending archived Task identity", () => {
  const controls = new Map([
    ["cancel", button("Cancel")],
    ["delete", button("Delete permanently")],
  ]);
  const dialog = {
    open: true,
    querySelector: (selector) => controls.get(selector.match(/value="([^"]+)/)?.[1]),
  };
  const owner = {
    isConnected: true,
    pendingThreadId: "thread/1",
    dialog: () => dialog,
  };
  const scope = deleteDialog.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "archived-task-delete:thread%2F1:cancel",
    "archived-task-delete:thread%2F1:delete",
  ]);
  assert.ok(scope.targets.every((target) => target.isActionable()));
  owner.pendingThreadId = "thread/2";
  assert.ok(scope.targets.every((target) => !target.isActionable()));
});

function button(textContent) {
  return { disabled: false, textContent, focus() {}, click() {} };
}
