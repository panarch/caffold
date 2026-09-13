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
  assert.equal(target.badgeAtEnd, false);
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

test("permission Action Hint is not actionable once the catalog has fixed the mode", () => {
  const control = {
    disabled: false,
    getAttribute(name) {
      return new Map([
        ["aria-label", "Choose approval mode"],
        ["popovertarget", "permission-options"],
        ["popovertargetaction", "toggle"],
      ]).get(name) ?? null;
    },
  };
  const owner = {
    isConnected: true,
    context: { locked: false, provider: "grok" },
    permissionFixedWhenConversationStarts: true,
    ensureRendered() {},
    permissionButton: () => control,
    permissionPicker: () => ({ hidden: false }),
    permissionPopover: () => ({
      id: "permission-options",
      matches: () => false,
    }),
  };

  const target = turnOptions.actionHintPermissionTarget.call(owner, {
    scopeId: "task:thread-a",
  });
  assert.equal(target.isActionable(), false);
});

test("locks only the approval picker when the conversation exists and the catalog fixes the mode", () => {
  const modelButton = control();
  const permissionButton = control();
  const owner = renderOwner({
    context: { locked: false, placement: "below", provider: "grok" },
    permissionFixedWhenConversationStarts: true,
    selectedPermissionMode: () => "ask",
    selectedPermission: () => ({
      mode: "ask",
      label: "Ask first",
      allowed: true,
    }),
    modelButton: () => modelButton,
    permissionButton: () => permissionButton,
  });

  turnOptions.render.call(owner);

  assert.equal(modelButton.disabled, false);
  assert.equal(permissionButton.disabled, true);
  assert.equal(
    permissionButton.title,
    "Grok fixes the permission mode when the conversation starts; start a new Task to change it.",
  );
});

test("keeps the approval picker editable on a new Task even when the catalog would fix the mode later", () => {
  const permissionButton = control();
  const owner = renderOwner({
    context: { locked: false, placement: "below", provider: "" },
    permissionFixedWhenConversationStarts: true,
    selectedPermissionMode: () => "ask",
    selectedPermission: () => ({
      mode: "ask",
      label: "Ask first",
      allowed: true,
    }),
    permissionButton: () => permissionButton,
  });

  turnOptions.render.call(owner);

  assert.equal(permissionButton.disabled, false);
  assert.equal(permissionButton.title, "Ask first");
});

test("prefers the conversation-start lock copy over the active-turn lock on a fixed approval picker", () => {
  const modelButton = control();
  const permissionButton = control();
  const owner = renderOwner({
    context: { locked: true, placement: "below", provider: "grok" },
    permissionFixedWhenConversationStarts: true,
    selectedPermissionMode: () => "ask",
    selectedPermission: () => ({
      mode: "ask",
      label: "Ask first",
      allowed: true,
    }),
    modelButton: () => modelButton,
    permissionButton: () => permissionButton,
  });

  turnOptions.render.call(owner);

  assert.equal(modelButton.disabled, true);
  assert.equal(
    modelButton.title,
    "Model, reasoning, and speed can be changed after the active turn finishes.",
  );
  assert.equal(permissionButton.disabled, true);
  assert.equal(
    permissionButton.title,
    "Grok fixes the permission mode when the conversation starts; start a new Task to change it.",
  );
});

test("does not change approval mode after the catalog has fixed it", () => {
  const owner = {
    context: { provider: "grok" },
    permissionFixedWhenConversationStarts: true,
    permissionOptions: [
      { mode: "ask", allowed: true, dangerous: false },
      { mode: "yoloMode", allowed: true, dangerous: true },
    ],
    selection: {
      permissionMode: "ask",
      permissionExplicit: false,
    },
  };

  turnOptions.selectPermission.call(owner, "yoloMode");
  assert.equal(owner.selection.permissionMode, "ask");
  assert.equal(owner.selection.permissionExplicit, false);
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
  const provider = optionControl({
    action: "browse-provider",
    provider: "claude",
    label: "Claude",
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
    provider,
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
  assert.equal(modelScope.targets.every(({ badgeAtEnd }) => badgeAtEnd), true);
  assert.deepEqual(
    modelScope.targets.map(({ actionId }) => actionId),
    ["task.model.provider.browse", "task.model.select", "task.reasoning.select", "task.speed.select"],
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

test("declares a session-bound Action Hint context for both retained popover contexts", () => {
  const presentation = {
    actionHintDialog: () => ({}),
    scrollModeHud: () => ({}),
    scrollSurfaceSelector: () => ({}),
  };
  const popover = () => ({
    matches: () => false,
    querySelector: () => presentation,
    querySelectorAll: () => [],
  });
  const owner = {
    isConnected: true,
    context: { locked: false },
    ensureRendered() {},
    modelPopover: () => modelPopover,
    permissionPopover: () => permissionPopover,
    popoverKeyboardNavigationContext:
      turnOptions.popoverKeyboardNavigationContext,
    popoverActionHintScope: turnOptions.popoverActionHintScope,
  };
  const modelPopover = popover();
  const permissionPopover = popover();

  const contexts = turnOptions.keyboardNavigationContexts.call(owner, {
    scopeId: "task:thread-a",
  });

  assert.deepEqual(
    contexts.map(({ id, kind, root, actionHints }) => ({
      id,
      kind,
      root,
      sessionBound: actionHints.sessionBound,
    })),
    [
      {
        id: "task-composer:task:thread-a:model-options",
        kind: "popover",
        root: modelPopover,
        sessionBound: true,
      },
      {
        id: "task-composer:task:thread-a:permission-options",
        kind: "popover",
        root: permissionPopover,
        sessionBound: true,
      },
    ],
  );
});

test("marks only the selected model and permission options as the popover autofocus", () => {
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
  const approveForMe = {
    mode: "approveForMe",
    label: "Approve for me",
    description: "Approves routine actions",
    allowed: true,
    dangerous: false,
  };
  const fullAccess = {
    mode: "fullAccess",
    label: "Full access",
    description: "Removes restrictions",
    allowed: true,
    dangerous: true,
  };
  const modelPopover = control();
  const permissionPopover = control();
  let modelHtml = "";
  let permissionHtml = "";
  const owner = renderOwner({
    offeredModels: () => [codex, claude],
    selectedModel: () => codex,
    permissionOptions: [approveForMe, fullAccess],
    selectedPermissionMode: () => "approveForMe",
    selectedPermission: () => approveForMe,
    modelPopover: () => modelPopover,
    permissionPopover: () => permissionPopover,
    patchPopover(popover, html) {
      if (popover === modelPopover) {
        modelHtml += html;
      } else if (popover === permissionPopover) {
        permissionHtml = html;
      }
    },
  });

  turnOptions.render.call(owner);

  assert.match(
    modelHtml,
    /data-provider="codex"[\s\S]*?aria-pressed="true"\s+autofocus/,
  );
  assert.equal(modelHtml.match(/autofocus/g).length, 1);
  assert.match(
    permissionHtml,
    /data-permission-mode="approveForMe"[\s\S]*?aria-pressed="true"\s+autofocus/,
  );
  assert.equal(permissionHtml.match(/autofocus/g).length, 1);
});

test("hides only its own popover when a bound Action Hint session is dismissed", () => {
  const hidden = [];
  const modelPopover = {};
  const permissionPopover = {};
  const owner = {
    modelPopover: () => modelPopover,
    permissionPopover: () => permissionPopover,
    hidePopover: (popover) => hidden.push(popover),
  };
  turnOptions.handleDismiss.call(owner, { target: {} });
  turnOptions.handleDismiss.call(owner, { target: permissionPopover });
  turnOptions.handleDismiss.call(owner, { target: modelPopover });
  assert.deepEqual(hidden, [permissionPopover, modelPopover]);
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
        modelHtml += html;
      }
    },
  });

  turnOptions.render.call(owner);

  assert.match(
    modelHtml,
    /data-provider="codex"[\s\S]*?data-model="shared-model"[\s\S]*?aria-pressed="true"/,
  );
  assert.doesNotMatch(modelHtml, /Claude Shared/);
  owner.browsedProvider = "claude";
  modelHtml = "";
  turnOptions.render.call(owner);
  assert.match(
    modelHtml,
    /data-provider="claude"[\s\S]*?data-model="shared-model"[\s\S]*?aria-pressed="false"/,
  );
  assert.doesNotMatch(modelHtml, /Codex Shared/);
});

test("browsing a provider leaves the chosen model and its settings untouched", () => {
  const owner = selectionOwner();
  const selection = { ...owner.selection };
  turnOptions.browseProvider.call(owner, "claude");
  assert.equal(owner.browsedProvider, "claude");
  assert.deepEqual(owner.selection, selection);
  assert.equal(owner.changes, 0);
  assert.equal(owner.permissionRequests, 0);

  turnOptions.browseProvider.call(owner, "unavailable");
  assert.equal(owner.browsedProvider, "claude");
});

test("a new model uses its own default even when effort names and speed overlap", () => {
  const owner = selectionOwner();
  turnOptions.selectModel.call(owner, "shared", "claude");
  assert.equal(owner.selection.provider, "claude");
  assert.equal(owner.selection.effort, "low");
  assert.equal(owner.selection.fastMode, false);
  assert.equal(owner.browsedProvider, "claude");
  assert.equal(owner.changes, 1);
  assert.equal(owner.permissionRequests, 1);
  assert.equal(owner.dismissals, 0);

  owner.selection.effort = "high";
  owner.selection.fastMode = true;
  turnOptions.selectModel.call(owner, "shared", "claude");
  assert.equal(owner.selection.effort, "high");
  assert.equal(owner.selection.fastMode, true);
});

test("a Task's provider boundary rejects browsing and choosing other agents", () => {
  const owner = selectionOwner();
  owner.context.provider = "codex";
  const selection = { ...owner.selection };
  turnOptions.browseProvider.call(owner, "claude");
  turnOptions.selectModel.call(owner, "shared", "claude");
  assert.deepEqual(owner.selection, selection);
  assert.equal(owner.browsedProvider, "");
  assert.equal(owner.changes, 0);
  assert.equal(owner.permissionRequests, 0);
});

test("an effort must be offered even when an unavailable default is supplied", () => {
  const owner = selectionOwner();
  owner.selection.effort = "missing";
  owner.modelOptions[0].defaultReasoningEffort = "missing";
  assert.equal(turnOptions.selectedEffort.call(owner), "low");
  owner.modelOptions[0].supportedReasoningEfforts = [];
  assert.equal(turnOptions.selectedEffort.call(owner), "");
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
    disabled: false,
    querySelector: (selector) => ({ selector }),
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
    renderModelPopover: turnOptions.renderModelPopover,
    patchPopover() {},
    hidePopover() {},
    ...overrides,
  };
}

function selectionOwner() {
  return {
    context: { provider: "" },
    browsedProvider: "",
    selection: { provider: "codex", model: "shared", effort: "high", fastMode: true },
    modelOptions: ["codex", "claude"].map((provider) => ({
      provider,
      model: "shared",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
      supportsFast: true,
    })),
    offeredModels: turnOptions.offeredModels,
    selectedModel: turnOptions.selectedModel,
    modelPopover: () => ({}),
    changes: 0,
    permissionRequests: 0,
    dismissals: 0,
    hidePopover() { this.dismissals += 1; },
    render() {},
    emitChange() { this.changes += 1; },
    loadPermissions() { this.permissionRequests += 1; },
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
