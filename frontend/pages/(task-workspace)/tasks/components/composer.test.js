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
      return selector === "textarea[name='prompt']" ? textarea : null;
    },
    querySelectorAll: () => [],
    stateFor() {
      return { selectionStart: null, selectionEnd: null };
    },
    focus: composer.focus,
    actionHintButtonTargets(options) {
      return composer.actionHintButtonTargets.call(this, options);
    },
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

function composerButton({ action = "", primaryAction = "", imageId = "" }) {
  return {
    dataset: { composerAction: action, primaryAction, imageId },
    disabled: false,
    title: "",
    textContent: action || primaryAction,
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides the current Composer button catalog without retargeting it", () => {
  const browse = composerButton({ action: "browse-cwd" });
  const voice = composerButton({ action: "voice" });
  const cancelVoice = composerButton({ action: "cancel-voice" });
  const cancel = composerButton({ action: "cancel" });
  const primary = composerButton({ primaryAction: "start" });
  const preview = composerButton({ action: "preview-image", imageId: "image-a" });
  const remove = composerButton({ action: "remove-image", imageId: "image-a" });
  let controls = [
    browse,
    voice,
    cancelVoice,
    cancel,
    primary,
    preview,
    remove,
  ];
  const matches = (selector) => {
    if (selector.includes("task-primary-action-button")) {
      return controls.filter(({ dataset }) => dataset.primaryAction);
    }
    const actions = Array.from(
      selector.matchAll(/data-composer-action="([^"]+)"/g),
      (match) => match[1],
    );
    return controls.filter(({ dataset }) =>
      actions.includes(dataset.composerAction) &&
      (!selector.includes("[data-image-id]") || dataset.imageId)
    );
  };
  const owner = {
    isConnected: true,
    context: { mode: "create", threadId: "", cwd: "/repo" },
    state: {
      activeSubmissionId: null,
      images: [{ id: "image-a" }],
    },
    stateFor() {
      return this.state;
    },
    querySelector: (selector) => matches(selector)[0] ?? null,
    querySelectorAll: matches,
  };

  const targets = composer.actionHintButtonTargets.call(owner, {
    mode: "create",
    scopeId: "new",
    clipRoots: [{}],
  });
  assert.deepEqual(targets.map(({ id }) => id), [
    "task-composer:new:browse-cwd",
    "task-composer:new:voice",
    "task-composer:new:cancel-voice",
    "task-composer:new:cancel",
    "task-composer:new:primary:start",
    "task-composer:new:preview-image:image-a",
    "task-composer:new:remove-image:image-a",
  ]);
  targets.forEach((target) => target.activate());
  assert.deepEqual(
    controls.map(({ clicks }) => clicks),
    [1, 1, 1, 1, 1, 1, 1],
  );

  owner.state.images = [];
  assert.equal(targets[5].isActionable(), false);
  owner.state.activeSubmissionId = "submission-a";
  assert.equal(targets[0].isActionable(), false);
  controls = controls.filter((control) => control !== voice);
  assert.equal(targets[1].isActionable(), false);
});
