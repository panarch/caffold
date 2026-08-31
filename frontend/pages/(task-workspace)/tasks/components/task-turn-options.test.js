import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./task-turn-options.js");
const turnOptions = registry.element("caffold-task-turn-options").prototype;
after(() => registry.restore());

test("provides Model through the owned native popover button", () => {
  const clipRoot = {};
  let clicks = 0;
  const attributes = new Map([
    ["aria-label", "Choose GPT-5.6 and reasoning"],
    ["popovertarget", "model-options"],
    ["popovertargetaction", "toggle"],
  ]);
  const control = {
    disabled: false,
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    click() {
      clicks += 1;
    },
  };
  let currentControl = control;
  let popoverOpen = false;
  const popover = {
    id: "model-options",
    matches(selector) {
      assert.equal(selector, ":popover-open");
      return popoverOpen;
    },
  };
  const owner = {
    context: { locked: false },
    ensureRendered() {},
    modelButton() {
      return currentControl;
    },
    modelPopover() {
      return popover;
    },
  };

  const target = turnOptions.actionHintModelTarget.call(owner, {
    scopeId: "task:thread-a",
    clipRoots: [clipRoot],
  });

  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "task-composer:task:thread-a:model",
      actionId: "task.model.choose",
      label: "Choose GPT-5.6 and reasoning",
      controlKind: "button",
    },
  );
  assert.equal(target.control, control);
  assert.equal(target.anchor, control);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(clicks, 1);

  popoverOpen = true;
  assert.equal(target.isActionable(), false);
  popoverOpen = false;
  owner.context.locked = true;
  assert.equal(target.isActionable(), false);
  owner.context.locked = false;
  currentControl = { ...control };
  assert.equal(target.isActionable(), false);
});
