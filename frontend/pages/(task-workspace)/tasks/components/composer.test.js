import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./composer.js");
const composer = registry.element("caffold-task-composer").prototype;
after(() => registry.restore());

test("provides Model, Permission, and Prompt through their existing component actions", () => {
  const clipRoot = {};
  let modelClicks = 0;
  let permissionClicks = 0;
  let promptFocuses = 0;
  const modelControl = {};
  const modelTarget = {
    id: "task-composer:task:thread-a:model",
    actionId: "task.model.choose",
    label: "Choose model and reasoning",
    controlKind: "button",
    control: modelControl,
    anchor: modelControl,
    clipRoots: [clipRoot],
    isActionable: () => true,
    activate: () => {
      modelClicks += 1;
    },
  };
  const permissionControl = {};
  const permissionTarget = {
    id: "task-composer:task:thread-a:permission",
    actionId: "task.permission.open",
    label: "Choose approval mode",
    controlKind: "button",
    control: permissionControl,
    anchor: permissionControl,
    clipRoots: [clipRoot],
    isActionable: () => true,
    activate: () => {
      permissionClicks += 1;
    },
  };
  let delegatedOptions = null;
  const options = {
    actionHintModelTarget(value) {
      delegatedOptions = value;
      return modelTarget;
    },
    actionHintPermissionTarget(value) {
      assert.deepEqual(value, delegatedOptions);
      return permissionTarget;
    },
  };
  const textarea = {
    disabled: false,
    focus() {
      promptFocuses += 1;
    },
  };
  const owner = {
    context: { mode: "follow-up" },
    ensureState() {},
    turnOptions() {
      return options;
    },
    querySelector(selector) {
      assert.equal(selector, "textarea[name='prompt']");
      return textarea;
    },
    stateFor() {
      return { selectionStart: null, selectionEnd: null };
    },
    focus: composer.focus,
  };

  const targets = composer.actionHintTargets.call(owner, {
    scopeId: "task:thread-a",
    clipRoots: [clipRoot],
  });

  assert.equal(targets.length, 3);
  assert.deepEqual(delegatedOptions, {
    scopeId: "task:thread-a",
    clipRoots: [clipRoot],
  });
  const [model, permission, prompt] = targets;
  assert.equal(model.control, modelControl);
  assert.equal(model.isActionable(), true);
  model.activate();
  assert.equal(modelClicks, 1);

  assert.equal(permission.control, permissionControl);
  assert.equal(permission.isActionable(), true);
  permission.activate();
  assert.equal(permissionClicks, 1);

  assert.deepEqual(
    {
      id: prompt.id,
      actionId: prompt.actionId,
      label: prompt.label,
      controlKind: prompt.controlKind,
    },
    {
      id: "task-composer:task:thread-a:prompt",
      actionId: "task.prompt.focus",
      label: "Edit follow-up prompt",
      controlKind: "textbox",
    },
  );
  assert.equal(prompt.control, textarea);
  assert.equal(prompt.anchor, textarea);
  assert.deepEqual(prompt.clipRoots, [clipRoot]);
  assert.equal(prompt.isActionable(), true);
  prompt.activate();
  assert.equal(promptFocuses, 1);

  owner.context.mode = "review";
  assert.equal(model.isActionable(), false);
  assert.equal(permission.isActionable(), false);
  assert.equal(prompt.isActionable(), false);
});
