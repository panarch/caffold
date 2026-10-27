import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./archived-delete-dialog.js");
const deleteDialog = registry.element("caffold-task-archived-delete-dialog").prototype;
after(() => registry.restore());

test("keeps a reopened retained dialog bound across a stale close event", () => {
  const owner = elementStandIn(deleteDialog, {
    pendingThreadId: "thread/1",
    taskTitle: "Delete archived task",
    dialog: { value: { open: true, returnValue: "cancel" } },
    dispatchEvent() {
      throw new Error("A stale close event must not dispatch deletion.");
    },
  });

  owner.handleClose();

  assert.equal(owner.pendingThreadId, "thread/1");
  assert.equal(owner.taskTitle, "Delete archived task");
});
