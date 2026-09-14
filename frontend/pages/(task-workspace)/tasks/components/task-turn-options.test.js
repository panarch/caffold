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

// The lists below keep the shape the agents answer with: Codex offers modes
// that do not depend on the model, only some Claude models may decide for
// themselves, and Grok fixes its mode when the conversation starts.
const CATALOG = {
  models: [
    {
      provider: "codex",
      model: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      isDefault: true,
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      supportsFastMode: true,
    },
    {
      provider: "codex",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: false,
      defaultEffort: "low",
      efforts: ["low", "medium", "high", "xhigh"],
      supportsFastMode: true,
    },
    {
      provider: "claude",
      model: "opus[1m]",
      displayName: "Opus",
      isDefault: false,
      defaultEffort: null,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      supportsFastMode: true,
    },
    {
      provider: "claude",
      model: "haiku",
      displayName: "Haiku",
      isDefault: false,
      defaultEffort: null,
      efforts: [],
      supportsFastMode: false,
    },
    {
      provider: "grok",
      model: "grok-4.6",
      displayName: "Grok 4.6",
      isDefault: true,
      defaultEffort: "xhigh",
      efforts: ["low", "medium", "high", "xhigh"],
      supportsFastMode: false,
    },
  ],
  unavailable: [],
};

const CODEX_MODES = {
  defaultMode: "approveForMe",
  fixedWhenConversationStarts: false,
  options: [
    {
      mode: "askForApproval",
      label: "Ask for approval",
      description: "Work in the workspace and ask before crossing its boundary.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "approveForMe",
      label: "Approve for me",
      description: "Keep the workspace boundary and review eligible requests automatically.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "fullAccess",
      label: "Full access",
      description: "Run without sandbox restrictions or approval prompts.",
      allowed: true,
      dangerous: true,
    },
  ],
};

function claudeModes(model) {
  const auto = model !== "haiku";
  return {
    defaultMode: auto ? "auto" : "default",
    fixedWhenConversationStarts: false,
    options: [
      {
        mode: "auto",
        label: "Automatic",
        description: "The model decides what needs asking about, and asks only for that.",
        allowed: auto,
        ...(auto
          ? {}
          : { unavailableReason: "This model cannot decide permissions for itself." }),
        dangerous: false,
      },
      {
        mode: "default",
        label: "Ask each time",
        description: "Stops for permission before every tool call it is not sure about.",
        allowed: true,
        dangerous: false,
      },
      {
        mode: "acceptEdits",
        label: "Accept edits",
        description: "Edits files without asking.",
        allowed: true,
        dangerous: false,
      },
      {
        mode: "plan",
        label: "Plan only",
        description: "Reads and reasons, and changes nothing until you accept a plan.",
        allowed: true,
        dangerous: false,
      },
      {
        mode: "bypassPermissions",
        label: "Full access",
        description: "Never asks.",
        allowed: true,
        dangerous: true,
      },
    ],
  };
}

const GROK_MODES = {
  defaultMode: "ask",
  fixedWhenConversationStarts: true,
  options: [
    {
      mode: "ask",
      label: "Ask first",
      description: "Grok asks before anything its own policy does not already allow.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "autoMode",
      label: "Grok decides",
      description: "Grok decides what to allow, and asks nobody.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "yoloMode",
      label: "Allow all",
      description: "Every tool call runs. Grok does not ask.",
      allowed: true,
      dangerous: true,
    },
  ],
};

const GROK_FIXED =
  "Grok fixes the permission mode when the conversation starts; start a new Task to change it.";

const SHARED_NAME_CATALOG = {
  models: [
    {
      provider: "codex",
      model: "shared",
      displayName: "Codex Shared",
      isDefault: true,
      defaultEffort: "low",
      efforts: ["low", "high"],
      supportsFastMode: true,
    },
    {
      provider: "claude",
      model: "shared",
      displayName: "Claude Shared",
      defaultEffort: "low",
      efforts: ["low", "high"],
      supportsFastMode: true,
    },
  ],
  unavailable: [],
};

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
    permissionFixed: () => false,
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
    ensureRendered() {},
    permissionFixed: () => true,
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

test("locks only the approval picker when the conversation exists and the catalog fixes the mode", async (t) => {
  const { nodes, server } = mount({
    provider: "grok",
    initialSelection: { model: "grok-4.6", permissionMode: "ask" },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  assert.equal(nodes.modelButton.disabled, false);
  assert.equal(nodes.permissionButton.disabled, true);
  assert.equal(nodes.permissionButton.title, GROK_FIXED);
});

test("keeps the approval picker editable on a new Task even when the catalog would fix the mode later", async (t) => {
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  element.selectModel("grok-4.6", "grok");
  await answerModes(server);

  assert.equal(nodes.permissionButton.disabled, false);
  assert.equal(nodes.permissionButton.title, "Ask first");
});

test("prefers the conversation-start lock copy over the active-turn lock on a fixed approval picker", async (t) => {
  const { nodes, server } = mount({
    provider: "grok",
    locked: true,
    initialSelection: { model: "grok-4.6", permissionMode: "ask" },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  assert.equal(nodes.modelButton.disabled, true);
  assert.equal(
    nodes.modelButton.title,
    "Model, reasoning, and speed can be changed after the active turn finishes.",
  );
  assert.equal(nodes.permissionButton.disabled, true);
  assert.equal(nodes.permissionButton.title, GROK_FIXED);
});

test("does not change approval mode after the catalog has fixed it", async (t) => {
  const { element, server } = mount({
    provider: "grok",
    initialSelection: { model: "grok-4.6", permissionMode: "ask" },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  element.selectPermission("yoloMode");
  assert.equal(element.snapshot().permissionMode, "ask");
  assert.equal(element.snapshot().permissionExplicit, false);
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

test("uses provider and model together as the option identity", async (t) => {
  const codex = optionControl({
    action: "select-model",
    provider: "codex",
    model: "shared",
    label: "Codex Shared",
  });
  const claude = optionControl({
    action: "select-model",
    provider: "claude",
    model: "shared",
    label: "Claude Shared",
  });
  const popover = { ...popoverWithOptions([codex, claude]), setAttribute() {} };
  const { element, server } = mount();
  t.after(() => server.restore());
  element.modelPopover = () => popover;
  await answerModels(server, SHARED_NAME_CATALOG);

  const scope = element.popoverActionHintScope({
    contextId: "new:model",
    kind: "model",
    popover,
  });
  assert.equal(new Set(scope.targets.map(({ id }) => id)).size, 2);

  element.selectModel("shared", "claude");
  assert.equal(element.selectedModel().provider, "claude");
});

test("restores a retained dangerous permission option after confirmation is canceled", async (t) => {
  const frames = [];
  const option = optionControl({
    action: "select-permission",
    permissionMode: "fullAccess",
    label: "Full access",
  });
  let focusOptions = null;
  option.focus = (options) => {
    focusOptions = options;
  };
  const popover = { ...popoverWithOptions([option]), setAttribute() {} };
  const { element, server } = mount();
  t.after(() => server.restore());
  element.permissionPopover = () => popover;
  await answerModels(server);
  await answerModes(server);
  Object.assign(globalThis.window, {
    confirm: () => false,
    requestAnimationFrame: (callback) => frames.push(callback),
  });

  element.selectPermission("fullAccess", option);
  assert.equal(element.snapshot().permissionMode, "approveForMe");
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(focusOptions, null);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(focusOptions, { preventScroll: true });
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

test("marks only the selected model and permission options as the popover autofocus", async (t) => {
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  let modelHtml = "";
  let permissionHtml = "";
  element.renderModelPopover = turnOptions.renderModelPopover;
  element.patchPopover = (popover, html) => {
    if (popover === nodes.modelPopover) {
      modelHtml += html;
    } else if (popover === nodes.permissionPopover) {
      permissionHtml = html;
    }
  };
  await answerModels(server, SHARED_NAME_CATALOG);
  await answerModes(server);

  modelHtml = "";
  element.render();

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

test("renders only the exact provider and model identity as selected", async (t) => {
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  let modelHtml = "";
  element.renderModelPopover = turnOptions.renderModelPopover;
  element.patchPopover = (popover, html) => {
    if (popover === nodes.modelPopover) {
      modelHtml += html;
    }
  };
  await answerModels(server, SHARED_NAME_CATALOG);

  modelHtml = "";
  element.render();
  assert.match(
    modelHtml,
    /data-provider="codex"[\s\S]*?data-model="shared"[\s\S]*?aria-pressed="true"/,
  );
  assert.doesNotMatch(modelHtml, /Claude Shared/);

  element.browsedProvider = "claude";
  modelHtml = "";
  element.render();
  assert.match(
    modelHtml,
    /data-provider="claude"[\s\S]*?data-model="shared"[\s\S]*?aria-pressed="false"/,
  );
  assert.doesNotMatch(modelHtml, /Codex Shared/);
});

test("browsing a provider leaves the chosen model and its settings untouched", async (t) => {
  const { element, events, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  const snapshot = element.snapshot();
  const announced = events.length;

  element.browseProvider("claude");
  assert.equal(element.browsedProvider, "claude");
  assert.deepEqual(element.snapshot(), snapshot);
  assert.equal(events.length, announced);
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra"]);

  element.browseProvider("unavailable");
  assert.equal(element.browsedProvider, "claude");
});

test("a new model uses its own default even when effort names and speed overlap", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server, SHARED_NAME_CATALOG);

  element.selectEffort("high");
  element.selectFastMode(true);
  element.selectModel("shared", "claude");
  assert.deepEqual(
    [element.selectedModel().provider, element.selectedEffort(), element.selectedFastMode()],
    ["claude", "low", false],
  );
  assert.equal(element.browsedProvider, "claude");

  element.selectEffort("high");
  element.selectFastMode(true);
  element.selectModel("shared", "claude");
  assert.deepEqual(
    [element.selectedEffort(), element.selectedFastMode()],
    ["high", true],
    "picking the same model again keeps what was set on it",
  );
});

test("a Task's provider boundary rejects browsing and choosing other agents", async (t) => {
  const { element, server } = mount({ provider: "codex" });
  t.after(() => server.restore());
  await answerModels(server, SHARED_NAME_CATALOG);
  const snapshot = element.snapshot();

  element.browseProvider("claude");
  element.selectModel("shared", "claude");
  assert.deepEqual(element.snapshot(), snapshot);
  assert.equal(element.browsedProvider, "");
  assert.deepEqual(server.asked(), ["codex/shared"]);
});

test("an effort must be offered even when an unavailable default is supplied", async (t) => {
  const { element, server } = mount({
    initialSelection: { model: "gpt-test", effort: "missing" },
  });
  t.after(() => server.restore());
  await answerModels(server, {
    models: [
      {
        provider: "codex",
        model: "gpt-test",
        displayName: "GPT Test",
        isDefault: true,
        defaultEffort: "missing",
        efforts: ["low", "high"],
      },
      { provider: "codex", model: "plain", displayName: "Plain", efforts: [] },
    ],
    unavailable: [],
  });

  assert.equal(element.selectedEffort(), "low");
  element.selectModel("plain", "codex");
  assert.equal(element.selectedEffort(), "");
});

test("keeps a closed picker wordless while its list loads", (t) => {
  const { nodes, server } = mount({ provider: "codex" });
  t.after(() => server.restore());

  assert.equal(nodes.modelButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(nodes.modelButton.classList.contains("is-deferred"), true);
  assert.equal(nodes.modelButton.attributes.get("aria-busy"), "true");
  assert.equal(nodes.modelButton.attributes.get("aria-label"), "Choose model");
  assert.equal(nodes.modelButton.title, "Loading models");
  assert.equal(nodes.permissionPicker.hidden, true);
  assert.equal(nodes.permissionButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(nodes.permissionButton.attributes.get("aria-busy"), "true");
  // The modes on offer belong to a model, so none are asked for before one.
  assert.deepEqual(server.asked(), []);
  const assignments = nodes.modelButton.assignments;

  // Showing the ring changes the button's class, not the slot's nodes.
  server.fireTimers();
  assert.equal(nodes.modelButton.classList.contains("is-deferred"), false);
  assert.equal(nodes.modelButton.assignments, assignments);
});

test("shows the permission picker once the model is known and its label once a list describes it", async (t) => {
  const { nodes, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);

  assert.equal(nodes.permissionPicker.hidden, false);
  assert.equal(nodes.permissionButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(nodes.permissionButton.classList.contains("is-deferred"), true);
  assert.equal(nodes.permissionButton.attributes.get("aria-busy"), "true");
  assert.equal(nodes.permissionButton.title, "Loading permission modes");

  server.fireTimers();
  assert.equal(nodes.permissionButton.classList.contains("is-deferred"), false);

  await answerModes(server);
  assert.equal(nodes.permissionButton.innerHTML, "<span>Auto review</span>");
  assert.equal(nodes.permissionButton.attributes.has("aria-busy"), false);
  assert.equal(nodes.permissionButton.title, "Approve for me");
});

test("a closed permission control keeps what it showed until the delay, then shows the spinner", async (t) => {
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  assert.equal(nodes.permissionButton.innerHTML, "<span>Auto review</span>");

  element.selectModel("opus[1m]", "claude");
  assert.equal(nodes.permissionButton.innerHTML, "<span>Auto review</span>");
  assert.equal(nodes.permissionButton.attributes.get("aria-busy"), "true");
  assert.equal(nodes.permissionButton.classList.contains("is-deferred"), false);

  server.fireTimers();
  assert.equal(nodes.permissionButton.innerHTML, LOADING_SLOT_HTML);
  assert.equal(nodes.permissionButton.classList.contains("is-deferred"), false);

  await answerModes(server);
  assert.equal(nodes.permissionButton.innerHTML, "<span>Automatic</span>");
  assert.equal(nodes.permissionButton.attributes.has("aria-busy"), false);
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

test("announces a permission list as it goes out and holds a submission until it has settled", async (t) => {
  const { element, events, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  assert.equal(events.at(-1).ready, false);
  await answerModes(server);
  assert.equal(events.at(-1).ready, true);

  element.selectModel("gpt-5.6-sol", "codex");
  assert.deepEqual(events.at(-1), {
    model: "gpt-5.6-sol",
    effort: "low",
    fastMode: false,
    permissionMode: "",
    modelExplicit: true,
    fastModeExplicit: false,
    permissionExplicit: false,
    ready: false,
  });
  refuse(server.permissions().at(-1), "offline");
  await drain();
  assert.equal(events.at(-1).ready, false);
});

test("a Section's later settings move the picker to the model that agent offers and ask for its modes", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  assert.deepEqual(element.submissionOptions(), {
    model: "gpt-6-astra",
    provider: "codex",
    effort: "medium",
    fastMode: false,
    permissionMode: "approveForMe",
  });

  element.setContext({
    initialSelection: {
      model: "opus[1m]",
      effort: "max",
      fastMode: false,
      permissionMode: "auto",
    },
  });
  assert.equal(server.asked().at(-1), "claude/opus[1m]");
  assert.equal(element.readyForSubmission(), false);
  assert.deepEqual(element.submissionOptions(), {
    model: "opus[1m]",
    provider: "claude",
    effort: "max",
    fastMode: false,
  });

  await answerModes(server);
  assert.equal(element.readyForSubmission(), true);
  assert.deepEqual(element.submissionOptions(), {
    model: "opus[1m]",
    provider: "claude",
    effort: "max",
    fastMode: false,
    permissionMode: "auto",
  });
});

test("a remembered model name that more than one agent offers is taken as neither", async (t) => {
  const { element, server } = mount({
    initialSelection: { model: "shared", effort: "high" },
  });
  t.after(() => server.restore());
  await answerModels(server, {
    models: [CATALOG.models[0], ...SHARED_NAME_CATALOG.models.map((model) => ({
      ...model,
      isDefault: false,
    }))],
    unavailable: [],
  });

  assert.equal(element.snapshot().model, "gpt-6-astra");
  assert.equal(element.snapshot().effort, "medium");
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra"]);
});

test("a person's picks outlast later settings while the settings they left alone follow", async (t) => {
  const { element, server } = mount({
    initialSelection: {
      model: "gpt-6-astra",
      effort: "max",
      permissionMode: "approveForMe",
    },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  element.selectEffort("high");
  element.selectPermission("askForApproval");

  element.setContext({
    initialSelection: {
      model: "gpt-5.6-sol",
      effort: "low",
      permissionMode: "fullAccess",
    },
  });
  assert.deepEqual(element.submissionOptions(), {
    model: "gpt-6-astra",
    provider: "codex",
    effort: "high",
    fastMode: false,
    permissionMode: "askForApproval",
  });
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra"]);

  element.resetOverrides();
  assert.equal(server.asked().at(-1), "codex/gpt-5.6-sol");
  await answerModes(server);
  assert.deepEqual(element.submissionOptions(), {
    model: "gpt-5.6-sol",
    provider: "codex",
    effort: "low",
    fastMode: false,
    permissionMode: "fullAccess",
  });
});

test("reasoning and speed follow only the model they were set on", async (t) => {
  const { element, server } = mount({
    initialSelection: { model: "gpt-5.6-sol", effort: "xhigh", fastMode: true },
  });
  t.after(() => server.restore());
  await answerModels(server);
  assert.deepEqual(
    [element.selectedEffort(), element.selectedFastMode()],
    ["xhigh", true],
  );

  element.selectModel("gpt-6-astra", "codex");
  assert.deepEqual(
    [element.selectedEffort(), element.selectedFastMode()],
    ["medium", false],
  );

  element.selectModel("gpt-5.6-sol", "codex");
  assert.deepEqual(
    [element.selectedEffort(), element.selectedFastMode()],
    ["xhigh", true],
    "the remembered model brings back what was remembered with it",
  );
});

test("picking one setting of the model on show keeps the others shown with it", async (t) => {
  const { element, server } = mount({
    initialSelection: { model: "gpt-5.6-sol", effort: "xhigh", fastMode: false },
  });
  t.after(() => server.restore());
  await answerModels(server);

  element.selectFastMode(true);
  element.setContext({
    initialSelection: { model: "gpt-6-astra", effort: "max", fastMode: false },
  });
  assert.deepEqual(
    [
      element.selectedModel().model,
      element.selectedEffort(),
      element.selectedFastMode(),
    ],
    ["gpt-5.6-sol", "xhigh", true],
  );
});

test("a mode is the person's, then the remembered one, then the list's default, among the modes the list allows", async (t) => {
  const { element, server } = mount({
    provider: "claude",
    initialSelection: { model: "opus[1m]", permissionMode: "auto" },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  assert.equal(element.snapshot().permissionMode, "auto");

  element.selectModel("haiku", "claude");
  await answerModes(server);
  assert.equal(
    element.snapshot().permissionMode,
    "default",
    "this model is not offered the remembered mode, so the list's default stands",
  );

  element.selectPermission("acceptEdits");
  element.selectModel("opus[1m]", "claude");
  await answerModes(server);
  assert.equal(
    element.snapshot().permissionMode,
    "acceptEdits",
    "a person's pick stands wherever the list allows it",
  );
});

test("an unreadable permission list reads as unavailable, holds the submission, and is not asked for again", async (t) => {
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  refuse(server.permissions().at(-1), "Codex app-server is unavailable.");
  await drain();

  assert.equal(element.readyForSubmission(), false);
  assert.equal(Object.hasOwn(element.submissionOptions(), "permissionMode"), false);
  assert.equal(nodes.permissionButton.innerHTML, "<span>Unavailable</span>");
  assert.equal(nodes.permissionButton.classList.contains("is-unavailable"), true);
  assert.equal(
    nodes.permissionButton.title,
    "Permission modes could not be loaded. Codex app-server is unavailable.",
  );

  element.setContext({ locked: true });
  element.setContext({ locked: false });
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra"]);

  element.selectModel("gpt-5.6-sol", "codex");
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra", "codex/gpt-5.6-sol"]);
  await answerModes(server);
  assert.equal(element.readyForSubmission(), true);
  assert.equal(nodes.permissionButton.classList.contains("is-unavailable"), false);
});

test("an unreadable model list holds the submission and leaves no permission control to show", async (t) => {
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  refuse(server.models().at(-1), "No agent offered a model.");
  await drain();

  assert.equal(element.readyForSubmission(), false);
  assert.equal(nodes.permissionPicker.hidden, true);
  assert.equal(
    nodes.modelButton.innerHTML,
    '<span class="task-model-name">Unavailable</span>',
  );
  assert.equal(nodes.modelButton.classList.contains("is-unavailable"), true);
  assert.equal(
    nodes.modelButton.title,
    "Models could not be loaded. No agent offered a model.",
  );
  assert.deepEqual(server.asked(), []);
});

test("a Task whose agent offered no models reads as unavailable for that agent's reason", async (t) => {
  const { element, nodes, server } = mount({ provider: "claude" });
  t.after(() => server.restore());
  await answerModels(server, {
    models: CATALOG.models.filter((model) => model.provider !== "claude"),
    unavailable: [{ provider: "claude", message: "Claude is not installed." }],
  });

  assert.equal(element.readyForSubmission(), false);
  assert.equal(nodes.permissionPicker.hidden, true);
  assert.equal(
    nodes.modelButton.title,
    "Models could not be loaded. Claude is not installed.",
  );
  assert.deepEqual(server.asked(), []);
});

test("a list still on its way when the control is detached is asked for again when it returns", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  element.selectModel("grok-4.6", "grok");
  const abandoned = server.permissions().at(-1);

  element.disconnectedCallback();
  element.isConnected = false;
  answer(abandoned, GROK_MODES);
  await drain();
  element.isConnected = true;
  element.connectedCallback();

  assert.deepEqual(server.asked(), [
    "codex/gpt-6-astra",
    "grok/grok-4.6",
    "grok/grok-4.6",
  ]);
  assert.equal(element.readyForSubmission(), false);
  await answerModes(server);
  assert.deepEqual(element.submissionOptions(), {
    model: "grok-4.6",
    provider: "grok",
    effort: "xhigh",
    fastMode: false,
    permissionMode: "ask",
  });
});

test("going back to a model whose list is in hand lets the list out for another go", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  element.selectModel("grok-4.6", "grok");
  const abandoned = server.permissions().at(-1);

  element.selectModel("gpt-6-astra", "codex");
  assert.equal(element.readyForSubmission(), true);

  answer(abandoned, GROK_MODES);
  await drain();
  assert.equal(element.snapshot().permissionMode, "approveForMe");
  assert.equal(element.readyForSubmission(), true);
});

test("a submission handed over stays as the person's picks until its overrides are released", async (t) => {
  const { element, server } = mount({ provider: "claude" });
  t.after(() => server.restore());
  await answerModels(server);

  element.reset({
    cwd: "src",
    provider: "claude",
    initialSelection: { model: "opus[1m]", effort: "max", permissionMode: "auto" },
  });
  element.holdSubmissionOptions({
    model: "haiku",
    provider: "claude",
    fastMode: false,
    permissionMode: "plan",
  });
  await answerModes(server);
  assert.deepEqual(element.snapshot(), {
    model: "haiku",
    effort: "",
    fastMode: false,
    permissionMode: "plan",
    modelExplicit: true,
    fastModeExplicit: true,
    permissionExplicit: true,
  });

  element.resetOverrides();
  await answerModes(server);
  assert.deepEqual(element.submissionOptions(), {
    model: "opus[1m]",
    provider: "claude",
    effort: "max",
    fastMode: false,
    permissionMode: "auto",
  });
});

// The real component methods, with its own DOM nodes and the agent routes
// standing in. Each request stays open until the test answers it.
function mount(context = {}) {
  const server = installAgentServer();
  const nodes = {
    modelButton: control(),
    permissionButton: control(),
    modelPopover: control(),
    permissionPopover: control(),
    permissionPicker: { hidden: false },
  };
  const events = [];
  const element = Object.create(turnOptions);
  Object.assign(element, {
    isConnected: true,
    dataset: {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) {
      events.push({
        ...event.detail,
        ready: turnOptions.readyForSubmission.call(this),
      });
      return true;
    },
    ensureRendered() {},
    modelButton: () => nodes.modelButton,
    permissionButton: () => nodes.permissionButton,
    permissionPicker: () => nodes.permissionPicker,
    modelPopover: () => nodes.modelPopover,
    permissionPopover: () => nodes.permissionPopover,
    renderModelPopover() {},
    patchPopover() {},
    hidePopover() {},
    hidePopovers() {},
  });
  element.ensureState();
  element.setContext({ cwd: "src", ...context });
  element.connectedCallback();
  return { element, nodes, events, server };
}

function installAgentServer() {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const requests = [];
  const timers = [];
  globalThis.window = Object.assign(new EventTarget(), {
    location: { origin: "http://127.0.0.1" },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout(id) {
      if (id) {
        timers[id - 1] = null;
      }
    },
  });
  globalThis.fetch = (url) => {
    const response = Promise.withResolvers();
    requests.push({ url: new URL(url), response });
    return response.promise;
  };
  const server = {
    models: () =>
      requests.filter((request) => request.url.pathname === "/api/agent/models"),
    permissions: () =>
      requests.filter(
        (request) => request.url.pathname === "/api/agent/permissions",
      ),
    asked: () =>
      server.permissions().map(({ url }) =>
        `${url.searchParams.get("provider")}/${url.searchParams.get("model")}`
      ),
    fireTimers() {
      timers.forEach((callback, index) => {
        timers[index] = null;
        callback?.();
      });
    },
    restore() {
      restoreGlobal("fetch", previous.fetch);
      restoreGlobal("window", previous.window);
    },
  };
  return server;
}

async function answerModels(server, catalog = CATALOG) {
  answer(server.models().at(-1), catalog);
  await drain();
}

async function answerModes(server) {
  const request = server.permissions().at(-1);
  const provider = request.url.searchParams.get("provider");
  answer(
    request,
    provider === "claude"
      ? claudeModes(request.url.searchParams.get("model"))
      : provider === "grok"
        ? GROK_MODES
        : CODEX_MODES,
  );
  await drain();
}

function answer(request, body) {
  request.response.resolve({ ok: true, status: 200, json: async () => body });
}

function refuse(request, message) {
  request.response.resolve({
    ok: false,
    status: 503,
    json: async () => ({ error: { code: "agent_unavailable", message } }),
  });
}

// Every continuation of an answered request is a microtask, so one macrotask
// turn runs them all.
function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
