import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./force-archive-dialog.js");
const Dialog = registry.element("caffold-task-force-archive-dialog");
after(() => registry.restore());

function fixture() {
  const dialog = { open: false, returnValue: "", showModal() { this.open = true; }, close() { this.open = false; } };
  const owner = Object.create(Dialog.prototype, Object.getOwnPropertyDescriptors({
    target: null, opener: null, dialog: { value: dialog }, events: [],
    dispatchEvent(event) { this.events.push(event.detail); },
  }));
  return { owner, dialog };
}

const target = { threadId: "task", worktreeId: "owned", title: "Task", path: "/managed/owned" };

test("Cancel and Escape never confirm; only an explicit confirmation emits the captured identity once", () => {
  for (const result of ["", "cancel", "confirm"]) {
    const { owner, dialog } = fixture();
    const supplied = { ...target };
    owner.openTask(supplied);
    supplied.worktreeId = "different";
    dialog.returnValue = result;
    dialog.close();
    owner.handleClose();
    owner.handleClose();
    assert.deepEqual(owner.events, result === "confirm" ? [{ threadId: "task", worktreeId: "owned" }] : []);
  }
});

test("leaving the Task invalidates a queued close and does not restore old focus", () => {
  const { owner, dialog } = fixture();
  owner.openTask(target);
  let focused = false;
  owner.opener = { isConnected: true, focus() { focused = true; } };
  dialog.returnValue = "confirm";
  owner.reset();
  owner.handleClose();
  assert.deepEqual(owner.events, []);
  assert.equal(focused, false);
  owner.openTask({ ...target, threadId: "next" });
  owner.handleClose();
  assert.equal(dialog.open, true);
  assert.equal(dialog.returnValue, "");
  assert.deepEqual(owner.events, []);
});

test("closing the current confirmation returns focus to its stable opener", () => {
  const { owner, dialog } = fixture();
  owner.openTask(target);
  let focused = false;
  owner.opener = { isConnected: true, focus() { focused = true; } };
  dialog.close();
  owner.handleClose();
  assert.equal(focused, true);
});
