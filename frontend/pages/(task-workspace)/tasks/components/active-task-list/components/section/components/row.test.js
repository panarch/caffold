import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./row.js");
const row = registry.element("caffold-active-task-row").prototype;
after(() => registry.restore());

test("provides a frozen Task action through the owned row button", () => {
  const clipRoot = {};
  const clipRoots = [clipRoot];
  const focusOptions = [];
  let clicks = 0;
  let currentControl = {
    dataset: { activeTaskRowAction: "open-task" },
    disabled: false,
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    snapshot: {
      task: { threadId: "thread-a", title: "Alpha" },
    },
    ensureState() {},
    querySelector() {
      return currentControl;
    },
  };

  const target = row.actionHintTarget.call(owner, { clipRoots });

  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "task:thread-a",
      actionId: "task.open",
      label: "Open task: Alpha",
      controlKind: "button",
    },
  );
  assert.equal(target.control, currentControl);
  assert.equal(target.anchor, currentControl);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.notEqual(target.clipRoots, clipRoots);
  assert.equal(target.isActionable(), true);

  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  currentControl.dataset.activeTaskRowAction = "open-task-recovery";
  assert.equal(target.isActionable(), false);
  const recovery = row.actionHintTarget.call(owner);
  assert.equal(recovery.actionId, "task.open-recovery");
  assert.equal(recovery.label, "Open task recovery: Alpha");

  currentControl = { ...currentControl };
  assert.equal(recovery.isActionable(), false);
});

test("provides the exact Task reorder handle as a focus-only target", () => {
  let focused = 0;
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute: () => "Reorder Alpha. Use Up and Down arrow keys to move.",
    focus() {
      focused += 1;
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    isConnected: true,
    snapshot: {
      task: { threadId: "thread-a", title: "Alpha" },
      reorderMode: true,
      reorderable: true,
      pending: false,
    },
    ensureState() {},
    querySelector: () => control,
  };

  const target = row.reorderActionHintTarget.call(owner, {
    clipRoots: [{ id: "task-list" }],
  });
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      controlKind: target.controlKind,
      label: target.label,
    },
    {
      id: "task:thread-a:reorder",
      actionId: "task.reorder.handle.focus",
      controlKind: "reorder-handle",
      label: "Reorder Alpha. Use Up and Down arrow keys to move.",
    },
  );
  target.activate();
  assert.equal(focused, 1);
  assert.equal(clicks, 0);

  owner.snapshot.pending = true;
  assert.equal(target.isActionable(), false);
  assert.equal(row.reorderActionHintTarget.call(owner), null);
  owner.snapshot.pending = false;
  control = { ...control };
  assert.equal(target.isActionable(), false);
  owner.snapshot.reorderMode = false;
  assert.equal(row.reorderActionHintTarget.call(owner), null);
});
