import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
const previousDocument = globalThis.document;
globalThis.Element = globalThis.HTMLElement;
globalThis.document = { activeElement: null };
await import("./task-turn-options.js");
const turnOptions = registry.element("caffold-task-turn-options").prototype;
after(() => {
  restoreGlobal("Element", previousElement);
  restoreGlobal("document", previousDocument);
  registry.restore();
});

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
    focusOptions: null,
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    focus(options) {
      this.focusOptions = options;
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
    isConnected: true,
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
  assert.deepEqual(control.focusOptions, { preventScroll: true });

  popoverOpen = true;
  assert.equal(target.isActionable(), false);
  popoverOpen = false;
  owner.context.locked = true;
  assert.equal(target.isActionable(), false);
  owner.context.locked = false;
  currentControl = { ...control };
  assert.equal(target.isActionable(), false);
});

test("provides Permission through the same retained native popover contract", () => {
  let focused = false;
  let clicked = false;
  const control = {
    disabled: false,
    focus() {
      focused = true;
    },
    click() {
      clicked = true;
    },
    getAttribute(name) {
      return new Map([
        ["aria-label", "Choose approval mode"],
        ["popovertarget", "permission-options"],
        ["popovertargetaction", "toggle"],
      ]).get(name) ?? null;
    },
  };
  const popover = {
    id: "permission-options",
    matches: () => false,
  };
  const picker = { hidden: false };
  const owner = {
    isConnected: true,
    context: { locked: false },
    ensureRendered() {},
    permissionButton: () => control,
    permissionPicker: () => picker,
    permissionPopover: () => popover,
  };

  const target = turnOptions.actionHintPermissionTarget.call(owner, {
    scopeId: "new",
  });
  assert.equal(target.actionId, "task.permission.open");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(focused, true);
  assert.equal(clicked, true);

  picker.hidden = true;
  assert.equal(target.isActionable(), false);
});

test("keeps the popover shell while replacing only its option body", () => {
  const content = control();
  content.contains = () => false;
  const popover = {
    querySelector: () => content,
    matches: () => false,
  };

  turnOptions.patchPopover.call({}, popover, "new");
  turnOptions.patchPopover.call({}, popover, "new");
  assert.deepEqual(
    { html: content.innerHTML, assignments: content.assignments },
    { html: "new", assignments: 1 },
  );
  assert.equal(popover.querySelector(), content);
});

test("provides selected model options and excludes disabled permission options", () => {
  const selectedModel = optionControl({
    action: "select-model",
    provider: "codex",
    model: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
  });
  const selectedReasoning = optionControl({
    action: "select-effort",
    effort: "max",
    label: "max",
  });
  const selectedSpeed = optionControl({
    action: "select-fast-mode",
    fastMode: "false",
    label: "Normal",
  });
  const blockedPermission = optionControl({
    action: "select-permission",
    permissionMode: "fullAccess",
    label: "Full access",
    disabled: true,
  });
  const modelPopover = popoverWithOptions([
    selectedModel,
    selectedReasoning,
    selectedSpeed,
  ]);
  const permissionPopover = popoverWithOptions([blockedPermission]);
  const owner = {
    isConnected: true,
    context: { locked: false },
    modelPopover: () => modelPopover,
    permissionPopover: () => permissionPopover,
  };

  const modelScope = turnOptions.popoverActionHintScope.call(owner, {
    contextId: "new:model",
    kind: "model",
    popover: modelPopover,
  });
  assert.deepEqual(
    modelScope.targets.map(({ actionId }) => actionId),
    ["task.model.select", "task.reasoning.select", "task.speed.select"],
  );
  assert.equal(modelScope.targets.every(({ isActionable }) => isActionable()), true);
  assert.deepEqual(
    turnOptions.popoverActionHintScope.call(owner, {
      contextId: "new:permission",
      kind: "permission",
      popover: permissionPopover,
    }).targets,
    [],
  );
});

test("uses provider and model together as the option identity", () => {
  const codex = optionControl({
    action: "select-model",
    provider: "codex",
    model: "shared-model",
    label: "Codex Shared",
  });
  const claude = optionControl({
    action: "select-model",
    provider: "claude",
    model: "shared-model",
    label: "Claude Shared",
  });
  const popover = popoverWithOptions([codex, claude]);
  const owner = {
    isConnected: true,
    context: { locked: false, provider: "" },
    selection: {
      provider: "",
      model: "",
      effort: "",
      fastMode: false,
      modelExplicit: false,
      fastModeExplicit: false,
    },
    modelOptions: [
      { provider: "codex", model: "shared-model", supportedReasoningEfforts: [] },
      { provider: "claude", model: "shared-model", supportedReasoningEfforts: [] },
    ],
    offeredModels() {
      return this.modelOptions;
    },
    selectedModel() {
      return turnOptions.selectedModel.call(this);
    },
    modelPopover: () => popover,
    permissionPopover: () => null,
    hidePopover() {},
    render() {},
    emitChange() {},
    loadPermissions() {},
  };

  const scope = turnOptions.popoverActionHintScope.call(owner, {
    contextId: "new:model",
    kind: "model",
    popover,
  });
  assert.equal(new Set(scope.targets.map(({ id }) => id)).size, 2);

  turnOptions.selectModel.call(owner, "shared-model", "claude");
  assert.equal(owner.selectedModel().provider, "claude");
});

test("restores a retained dangerous permission option after confirmation is canceled", () => {
  const previousWindow = globalThis.window;
  const frames = [];
  const control = optionControl({
    action: "select-permission",
    permissionMode: "fullAccess",
    label: "Full access",
  });
  let focusOptions = null;
  control.focus = (options) => {
    focusOptions = options;
  };
  const popover = popoverWithOptions([control]);
  const owner = {
    isConnected: true,
    permissionOptions: [{
      mode: "fullAccess",
      allowed: true,
      dangerous: true,
    }],
    selection: {
      permissionMode: "approveForMe",
      permissionExplicit: false,
    },
    permissionPopover: () => popover,
    restorePermissionOptionFocus(target, mode) {
      turnOptions.restorePermissionOptionFocus.call(this, target, mode);
    },
  };
  globalThis.window = {
    confirm: () => false,
    requestAnimationFrame: (callback) => frames.push(callback),
  };

  try {
    turnOptions.selectPermission.call(owner, "fullAccess", control);
    assert.equal(owner.selection.permissionMode, "approveForMe");
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(focusOptions, null);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.deepEqual(focusOptions, { preventScroll: true });
  } finally {
    restoreGlobal("window", previousWindow);
  }
});

test("renders only the exact provider and model identity as selected", () => {
  const codex = {
    provider: "codex",
    model: "shared-model",
    displayName: "Codex Shared",
    supportedReasoningEfforts: [],
    supportsFast: false,
  };
  const claude = {
    provider: "claude",
    model: "shared-model",
    displayName: "Claude Shared",
    supportedReasoningEfforts: [],
    supportsFast: false,
  };
  const modelPopover = control();
  let modelHtml = "";
  const owner = renderOwner({
    offeredModels: () => [codex, claude],
    selectedModel: () => codex,
    modelPopover: () => modelPopover,
    patchPopover(popover, html) {
      if (popover === modelPopover) {
        modelHtml = html;
      }
    },
  });

  turnOptions.render.call(owner);

  assert.match(
    modelHtml,
    /data-provider="codex"[\s\S]*?data-model="shared-model"[\s\S]*?aria-pressed="true"/,
  );
  assert.match(
    modelHtml,
    /data-provider="claude"[\s\S]*?data-model="shared-model"[\s\S]*?aria-pressed="false"/,
  );
});

test("keeps a closed picker wordless while its list loads", () => {
  const modelButton = control();
  const permissionButton = control();
  const permissionPicker = { hidden: false };
  const owner = renderOwner({
    modelLoading: true,
    permissionLoading: true,
    modelButton: () => modelButton,
    permissionButton: () => permissionButton,
    permissionPicker: () => permissionPicker,
  });

  turnOptions.render.call(owner);
  assert.equal(modelButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(modelButton.classList.contains("is-deferred"), true);
  assert.equal(modelButton.attributes.get("aria-busy"), "true");
  assert.equal(modelButton.attributes.get("aria-label"), "Choose model");
  assert.equal(modelButton.title, "Loading models");
  assert.equal(permissionPicker.hidden, true);
  assert.equal(permissionButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(permissionButton.classList.contains("is-deferred"), true);
  assert.equal(permissionButton.attributes.get("aria-busy"), "true");

  // Showing the ring changes the button's class, not the slot's nodes.
  owner.modelLoadingFeedback.visible = true;
  turnOptions.render.call(owner);
  assert.equal(modelButton.classList.contains("is-deferred"), false);
  assert.equal(modelButton.assignments, 1);
  assert.equal(permissionButton.classList.contains("is-deferred"), true);
});

test("shows the permission picker once the model is known and its label once a list describes it", () => {
  const codex = {
    provider: "codex",
    model: "gpt-test",
    displayName: "GPT Test",
    supportedReasoningEfforts: [{ value: "low" }],
    supportsFast: false,
  };
  const permissionButton = control();
  const permissionPicker = { hidden: true };
  const owner = renderOwner({
    offeredModels: () => [codex],
    selectedModel: () => codex,
    selectedEffort: () => "low",
    permissionLoading: true,
    permissionLoadingFeedback: { timer: null, visible: true },
    permissionButton: () => permissionButton,
    permissionPicker: () => permissionPicker,
  });

  turnOptions.render.call(owner);
  assert.equal(permissionPicker.hidden, false);
  assert.equal(permissionButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(permissionButton.classList.contains("is-deferred"), false);
  assert.equal(permissionButton.attributes.get("aria-busy"), "true");
  assert.equal(permissionButton.title, "Loading permission modes");

  owner.permissionLoading = false;
  owner.permissionOptions = [
    {
      mode: "approveForMe",
      label: "Approve for me",
      description: "",
      allowed: true,
      dangerous: false,
    },
  ];
  owner.selectedPermissionMode = () => "approveForMe";
  owner.selectedPermission = () => owner.permissionOptions[0];
  turnOptions.render.call(owner);
  assert.equal(permissionButton.innerHTML, "<span>Auto review</span>");
  assert.equal(permissionButton.attributes.has("aria-busy"), false);
  assert.equal(permissionButton.title, "Approve for me");

  // A list fetched again keeps the previous label but says it is busy.
  owner.permissionLoading = true;
  turnOptions.render.call(owner);
  assert.equal(permissionButton.innerHTML, "<span>Auto review</span>");
  assert.equal(permissionButton.classList.contains("is-deferred"), false);
  assert.equal(permissionButton.attributes.get("aria-busy"), "true");
  assert.equal(permissionButton.title, "Approve for me");
});

test("counts a pending list once across the requests that ask for it", () => {
  const previousWindow = globalThis.window;
  const timers = [];
  const cleared = [];
  globalThis.window = {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
  };

  try {
    let renders = 0;
    const owner = {
      render() {
        renders += 1;
      },
    };
    const feedback = { timer: null, visible: false };

    turnOptions.startLoadingFeedback.call(owner, feedback);
    assert.deepEqual(
      { delay: timers[0].delay, timer: feedback.timer },
      { delay: 180, timer: 1 },
    );
    // A superseding request while the timer is armed keeps that timer.
    turnOptions.startLoadingFeedback.call(owner, feedback);
    assert.deepEqual({ timers: timers.length, timer: feedback.timer }, {
      timers: 1,
      timer: 1,
    });

    timers[0].callback();
    assert.deepEqual(
      { visible: feedback.visible, timer: feedback.timer, renders },
      { visible: true, timer: null, renders: 1 },
    );
    // A superseding request while the ring is showing keeps it showing.
    turnOptions.startLoadingFeedback.call(owner, feedback);
    assert.deepEqual({ timers: timers.length, visible: feedback.visible }, {
      timers: 1,
      visible: true,
    });

    turnOptions.endLoadingFeedback.call(owner, feedback);
    assert.deepEqual(
      { visible: feedback.visible, timer: feedback.timer },
      { visible: false, timer: null },
    );
    turnOptions.startLoadingFeedback.call(owner, feedback);
    assert.deepEqual({ timers: timers.length, timer: feedback.timer }, {
      timers: 2,
      timer: 2,
    });
    turnOptions.endLoadingFeedback.call(owner, feedback);
    assert.equal(cleared.includes(2), true);
  } finally {
    restoreGlobal("window", previousWindow);
  }
});

function optionControl({
  action,
  provider,
  model,
  effort,
  fastMode,
  permissionMode,
  label,
  disabled = false,
}) {
  return {
    dataset: {
      turnOptionsAction: action,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(fastMode === undefined ? {} : { fastMode }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    },
    disabled,
    textContent: label,
    getAttribute: () => null,
    focus() {},
    click() {},
  };
}

const LOADING_SLOT_HTML =
  '<span class="task-picker-spinner" aria-hidden="true"></span>';

function control() {
  const attributes = new Map();
  const classes = new Set();
  let html = "";
  return {
    attributes,
    assignments: 0,
    title: "",
    classList: {
      toggle(name, force) {
        if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      contains(name) {
        return classes.has(name);
      },
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      this.assignments += 1;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

function renderOwner(overrides = {}) {
  return {
    context: { locked: false, placement: "below" },
    dataset: {},
    modelLoading: false,
    modelError: null,
    modelLoadingFeedback: { timer: null, visible: false },
    permissionLoading: false,
    permissionError: null,
    permissionOptions: [],
    permissionLoadingFeedback: { timer: null, visible: false },
    ensureRendered() {},
    offeredModels: () => [],
    selectedModel: () => null,
    selectedEffort: () => "",
    selectedFastMode: () => false,
    selectedPermissionMode: () => "",
    selectedPermission: () => undefined,
    modelButton: () => control(),
    modelPopover: () => control(),
    permissionButton: () => control(),
    permissionPicker: () => ({ hidden: false }),
    permissionPopover: () => control(),
    patchPickerButton: turnOptions.patchPickerButton,
    patchPopover() {},
    ...overrides,
  };
}

function popoverWithOptions(options) {
  return {
    matches: () => true,
    contains: (control) => options.includes(control),
    querySelectorAll: () => options,
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
