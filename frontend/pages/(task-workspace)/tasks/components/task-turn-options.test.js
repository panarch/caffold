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
  const owner = {
    isConnected: true,
    context: { locked: false },
    ensureRendered() {},
    permissionButton: () => control,
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
});

test("keeps the popover shell while replacing only its option body", () => {
  const content = {
    renderedHtml: "old",
    innerHTML: "old",
    contains: () => false,
  };
  const popover = {
    querySelector: () => content,
    matches: () => false,
  };

  turnOptions.patchPopover.call({}, popover, "new");
  assert.equal(content.innerHTML, "new");
  assert.equal(content.renderedHtml, "new");
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
  const permissionPopover = control();
  let modelHtml = "";
  const owner = {
    context: { locked: false, placement: "below" },
    dataset: {},
    modelLoading: false,
    modelError: null,
    permissionLoading: false,
    permissionError: null,
    permissionOptions: [],
    ensureRendered() {},
    offeredModels: () => [codex, claude],
    selectedModel: () => codex,
    selectedEffort: () => "",
    selectedFastMode: () => false,
    selectedPermissionMode: () => "",
    selectedPermission: () => null,
    modelButton: () => control(),
    modelPopover: () => modelPopover,
    permissionButton: () => control(),
    permissionPopover: () => permissionPopover,
    patchPopover(popover, html) {
      if (popover === modelPopover) {
        modelHtml = html;
      }
    },
  };

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

function control() {
  return {
    classList: { toggle() {} },
    setAttribute() {},
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
