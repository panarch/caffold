import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./section.js");
const section = registry.element("caffold-active-task-section").prototype;
after(() => registry.restore());

test("provides the managed Section header before delegated Task rows", () => {
  const clipRoot = {};
  let clicks = 0;
  const control = {
    disabled: false,
    focus() {},
    click() {
      clicks += 1;
    },
  };
  const taskTarget = { id: "task:thread-a" };
  const taskReorderTarget = { id: "task:thread-a:reorder" };
  const row = {
    actionHintTarget: () => taskTarget,
    reorderActionHintTarget: () => taskReorderTarget,
  };
  const sectionHandle = {
    disabled: false,
    getAttribute: () => "Reorder alpha",
    focus() {},
  };
  let currentControl = control;
  let currentHandle = sectionHandle;
  const owner = {
    isConnected: true,
    snapshot: {
      section: {
        id: "section-a",
        name: "/repo/alpha",
        label: "alpha",
        recovery: false,
      },
      reorderMode: "none",
    },
    querySelector(selector) {
      return selector.includes("section-reorder-handle")
        ? currentHandle
        : currentControl;
    },
    querySelectorAll() {
      return [row];
    },
  };

  const targets = section.actionHintTargets.call(owner, {
    clipRoots: [clipRoot],
  });
  assert.equal(targets.length, 2);
  assert.deepEqual(
    {
      id: targets[0].id,
      actionId: targets[0].actionId,
      label: targets[0].label,
      controlKind: targets[0].controlKind,
    },
    {
      id: "section:section-a",
      actionId: "navigation.section.open",
      label: "Open section: alpha",
      controlKind: "button",
    },
  );
  assert.deepEqual(targets[0].clipRoots, [clipRoot]);
  assert.equal(targets[0].isActionable(), true);
  targets[0].activate();
  assert.equal(clicks, 1);
  assert.equal(targets[1], taskTarget);

  owner.snapshot.reorderMode = "tasks";
  assert.deepEqual(section.actionHintTargets.call(owner), [taskReorderTarget]);

  owner.snapshot.reorderMode = "sections";
  assert.equal(targets[0].isActionable(), false);
  const reorderTargets = section.actionHintTargets.call(owner);
  assert.equal(reorderTargets.length, 1);
  assert.deepEqual(
    {
      id: reorderTargets[0].id,
      actionId: reorderTargets[0].actionId,
      controlKind: reorderTargets[0].controlKind,
      label: reorderTargets[0].label,
    },
    {
      id: "section:section-a:reorder",
      actionId: "task.reorder.handle.focus",
      controlKind: "reorder-handle",
      label: "Reorder alpha",
    },
  );
  assert.equal(reorderTargets[0].isActionable(), true);
  currentHandle = { ...sectionHandle };
  assert.equal(reorderTargets[0].isActionable(), false);
  owner.snapshot.pending = true;
  assert.deepEqual(section.actionHintTargets.call(owner), []);
  owner.snapshot.pending = false;
  owner.snapshot.section.recovery = true;
  assert.deepEqual(section.actionHintTargets.call(owner), []);
});
