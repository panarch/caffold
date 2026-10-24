import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./archived-delete-dialog.ts");
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
  const owner = Object.assign(Object.create(deleteDialog), {
    isConnected: true,
    pendingThreadId: "thread/1",
    querySelector(selector) {
      assert.equal(selector, ":scope > dialog");
      return dialog;
    },
  });
  const scope = owner.actionHintScope();

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "archived-task-delete:thread%2F1:cancel",
    "archived-task-delete:thread%2F1:delete",
  ]);
  assert.ok(scope.targets.every((target) => target.isActionable()));
  owner.pendingThreadId = "thread/2";
  assert.ok(scope.targets.every((target) => !target.isActionable()));
});

test("keeps a reopened retained dialog bound across a stale close event", () => {
  const owner = Object.assign(Object.create(deleteDialog), {
    pendingThreadId: "thread/1",
    taskTitle: "Delete archived task",
    querySelector: () => ({ open: true, returnValue: "cancel" }),
    dispatchEvent() {
      throw new Error("A stale close event must not dispatch deletion.");
    },
  });

  owner.handleClose();

  assert.equal(owner.pendingThreadId, "thread/1");
  assert.equal(owner.taskTitle, "Delete archived task");
});

function button(textContent) {
  return { disabled: false, textContent, focus() {}, click() {} };
}
