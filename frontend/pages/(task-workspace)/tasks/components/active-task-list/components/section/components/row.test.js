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
