import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
const previousDocument = globalThis.document;
globalThis.Element = globalThis.HTMLElement;
globalThis.document = { ...previousDocument, activeElement: null };
await import("./task-turn-options.ts");
const TurnOptions = registry.element("caffold-task-turn-options");
const turnOptions = TurnOptions.prototype;
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

// A model the agents start offering after the first list, as an account
// switch or an agent update brings one.
const NEW_CODEX_MODEL = {
  provider: "codex",
  model: "gpt-7-nova",
  displayName: "GPT-7-Nova",
  isDefault: false,
  defaultEffort: "medium",
  efforts: ["low", "medium", "high"],
  supportsFastMode: false,
};

const CODEX_SIGN_IN_REQUIRED =
  "Codex is ready to connect, but authentication is required.";

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

test("locks only the approval picker when the conversation exists and the catalog fixes the mode", async (t) => {
  const { element, server } = mount({
    provider: "grok",
    initialSelection: { model: "grok-4.6", permissionMode: "ask" },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  const { model, permission } = drawing(element);
  assert.equal(model.disabled, false);
  assert.equal(permission.disabled, true);
  assert.equal(permission.title, GROK_FIXED);
});

test("keeps the approval picker editable on a new Task even when the catalog would fix the mode later", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  element.selectModel("grok-4.6", "grok");
  await answerModes(server);

  const { permission } = drawing(element);
  assert.equal(permission.disabled, false);
  assert.equal(permission.title, "Ask first");
});

test("prefers the conversation-start lock copy over the active-turn lock on a fixed approval picker", async (t) => {
  const { element, server } = mount({
    provider: "grok",
    locked: true,
    initialSelection: { model: "grok-4.6", permissionMode: "ask" },
  });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  const { model, permission } = drawing(element);
  assert.equal(model.disabled, true);
  assert.equal(
    model.title,
    "Model, reasoning, and speed can be changed after the active turn finishes.",
  );
  assert.equal(permission.disabled, true);
  assert.equal(permission.title, GROK_FIXED);
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

test("asks for the approval list again when Caffold's own reviewer becomes available", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  const askedOnce = server.permissions().length;

  // Nothing about the chosen model changed, so only forgetting the answered
  // list can ask again — the mode is withheld on what is held.
  element.forgetPermissionList();
  await drain();

  assert.equal(server.permissions().length, askedOnce + 1);
});

test("holds one answered approval list while nothing has changed", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  const askedOnce = server.permissions().length;

  element.requestPermissionList();
  await drain();

  assert.equal(server.permissions().length, askedOnce);
});

test("a pick for Caffold's own mode survives the list being asked again", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  const offering = {
    ...CODEX_MODES,
    options: [
      ...CODEX_MODES.options,
      {
        mode: "caffold:ask-jev-first",
        label: "Ask Jev first",
        description: "Asks about everything.",
        allowed: true,
        dangerous: false,
      },
    ],
  };
  answer(server.permissions().at(-1), offering);
  await drain();
  element.selectPermission("caffold:ask-jev-first");
  assert.equal(element.snapshot().permissionMode, "caffold:ask-jev-first");

  // Saving Jev settings asks for the list again; a person's pick is theirs
  // across that, not something the new answer replaces.
  element.forgetPermissionList();
  await drain();
  answer(server.permissions().at(-1), offering);
  await drain();

  assert.equal(element.snapshot().permissionMode, "caffold:ask-jev-first");
  assert.equal(element.snapshot().permissionExplicit, true);
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
  const { element, nodes, server } = mount();
  t.after(() => server.restore());
  nodes.permissionPopover = popoverWithOptions([option]);
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

test("marks only the selected model and permission options as the popover autofocus", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server, SHARED_NAME_CATALOG);
  await answerModes(server);

  const models = menuMarkup(element, "model");
  assert.match(
    models,
    /data-provider="codex"[\s\S]*?aria-pressed="true" \?autofocus="true"/,
  );
  assert.equal(models.match(/\?autofocus="true"/g).length, 1);
  const permissions = menuMarkup(element, "permission");
  assert.match(
    permissions,
    /data-permission-mode="approveForMe"[\s\S]*?aria-pressed="true" \?autofocus="true"/,
  );
  assert.equal(permissions.match(/\?autofocus="true"/g).length, 1);
});

test("hides only its own popover when a bound Action Hint session is dismissed", () => {
  const hidden = [];
  const nodes = {
    modelPopover: popoverNode({ open: true, hidden }),
    permissionPopover: popoverNode({ open: true, hidden }),
  };
  const element = turnOptionsHost(nodes);
  element.dismissed({ target: {} });
  element.dismissed({ target: nodes.permissionPopover });
  element.dismissed({ target: nodes.modelPopover });
  assert.deepEqual(hidden, [nodes.permissionPopover, nodes.modelPopover]);
});

test("renders only the exact provider and model identity as selected", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server, SHARED_NAME_CATALOG);

  const codex = menuMarkup(element, "model");
  assert.match(
    codex,
    /data-provider="codex"[\s\S]*?data-model="shared"[\s\S]*?aria-pressed="true"/,
  );
  assert.doesNotMatch(codex, /Claude Shared/);

  element.browseProvider("claude");
  const claude = menuMarkup(element, "model");
  assert.match(
    claude,
    /data-provider="claude"[\s\S]*?data-model="shared"[\s\S]*?aria-pressed="false"/,
  );
  assert.doesNotMatch(claude, /Codex Shared/);
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
  const { element, server } = mount({ provider: "codex" });
  t.after(() => server.restore());

  const { model, permission, permissionHidden } = drawing(element);
  assert.equal(model.content, LOADING_SLOT_HTML);
  assert.equal(model.classes.includes("is-deferred"), true);
  assert.equal(model.busy, true);
  assert.equal(model.label, "Choose model");
  assert.equal(model.title, "Loading models");
  assert.equal(permissionHidden, true);
  assert.equal(permission.content, LOADING_SLOT_HTML);
  assert.equal(permission.busy, true);
  // The modes on offer belong to a model, so none are asked for before one.
  assert.deepEqual(server.asked(), []);

  // Showing the ring changes the button's class, not what its slot draws.
  server.fireTimers();
  const ringed = drawing(element).model;
  assert.equal(ringed.classes.includes("is-deferred"), false);
  assert.equal(ringed.content, model.content);
});

test("shows the permission picker once the model is known and its label once a list describes it", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);

  const { permission, permissionHidden } = drawing(element);
  assert.equal(permissionHidden, false);
  assert.equal(permission.content, LOADING_SLOT_HTML);
  assert.equal(permission.classes.includes("is-deferred"), true);
  assert.equal(permission.busy, true);
  assert.equal(permission.title, "Loading permission modes");

  server.fireTimers();
  const ringed = drawing(element).permission;
  assert.equal(ringed.classes.includes("is-deferred"), false);

  await answerModes(server);
  const answered = drawing(element).permission;
  assert.equal(answered.content, permissionButtonHtml("Auto review"));
  assert.equal(answered.busy, false);
  assert.equal(answered.title, "Approve for me");
});

test("a closed permission control keeps what it showed until the delay, then shows the spinner", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  assert.equal(
    drawing(element).permission.content,
    permissionButtonHtml("Auto review"),
  );

  element.selectModel("opus[1m]", "claude");
  const kept = drawing(element).permission;
  assert.equal(kept.content, permissionButtonHtml("Auto review"));
  assert.equal(kept.busy, true);
  assert.equal(kept.classes.includes("is-deferred"), false);

  server.fireTimers();
  const ringed = drawing(element).permission;
  assert.equal(ringed.content, LOADING_SLOT_HTML);
  assert.equal(ringed.classes.includes("is-deferred"), false);

  await answerModes(server);
  const answered = drawing(element).permission;
  assert.equal(answered.content, permissionButtonHtml("Automatic"));
  assert.equal(answered.busy, false);
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
      draw() {
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
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  refuse(server.permissions().at(-1), "Codex app-server is unavailable.");
  await drain();

  assert.equal(element.readyForSubmission(), false);
  assert.equal(Object.hasOwn(element.submissionOptions(), "permissionMode"), false);
  const { permission } = drawing(element);
  assert.equal(permission.content, permissionButtonHtml("Unavailable"));
  assert.equal(permission.classes.includes("is-unavailable"), true);
  assert.equal(
    permission.title,
    "Permission modes could not be loaded. Codex app-server is unavailable.",
  );

  element.setContext({ locked: true });
  element.setContext({ locked: false });
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra"]);

  element.selectModel("gpt-5.6-sol", "codex");
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra", "codex/gpt-5.6-sol"]);
  await answerModes(server);
  assert.equal(element.readyForSubmission(), true);
  assert.equal(
    drawing(element).permission.classes.includes("is-unavailable"),
    false,
  );
});

test("an unreadable model list holds the submission and leaves no permission control to show", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  refuse(server.models().at(-1), "No agent offered a model.");
  await drain();

  assert.equal(element.readyForSubmission(), false);
  const { model, permissionHidden } = drawing(element);
  assert.equal(permissionHidden, true);
  assert.equal(
    model.content,
    '<span class="task-model-name">Unavailable</span>',
  );
  assert.equal(model.classes.includes("is-unavailable"), true);
  assert.equal(
    model.title,
    "Models could not be loaded. No agent offered a model.",
  );
  assert.deepEqual(server.asked(), []);
});

test("a Task whose agent offered no models reads as unavailable for that agent's reason", async (t) => {
  const { element, server } = mount({ provider: "claude" });
  t.after(() => server.restore());
  await answerModels(server, {
    models: CATALOG.models.filter((model) => model.provider !== "claude"),
    unavailable: [{ provider: "claude", message: "Claude is not installed." }],
  });

  assert.equal(element.readyForSubmission(), false);
  const { model, permissionHidden } = drawing(element);
  assert.equal(permissionHidden, true);
  assert.equal(
    model.title,
    "Models could not be loaded. Claude is not installed.",
  );
  assert.deepEqual(server.asked(), []);
});

test("opening the model menu asks the agents again and offers what they answer", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  openModelMenu(element);
  assert.equal(server.models().length, 2);
  await answerModels(server, {
    models: [...CATALOG.models, NEW_CODEX_MODEL],
    unavailable: [],
  });
  assert.equal(element.snapshot().model, "gpt-6-astra");

  element.selectModel("gpt-7-nova", "codex");
  assert.equal(element.snapshot().model, "gpt-7-nova");
});

test("a list asked for again leaves the control as it was until the answer arrives", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  const shown = drawing(element).model;

  openModelMenu(element);
  server.fireTimers();

  assert.equal(server.models().length, 2);
  assert.deepEqual(drawing(element).model, shown);
  assert.equal(shown.busy, false);
  assert.equal(element.readyForSubmission(), true);
});

test("the menu asks for no second list while one is on its way", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  openModelMenu(element);
  assert.equal(server.models().length, 1);
  await answerModels(server);
  await answerModes(server);

  openModelMenu(element);
  openModelMenu(element);
  assert.equal(server.models().length, 2);
});

test("a chosen model that leaves the list gives way to the next in line and its modes are asked for", async (t) => {
  const { element, server } = mount({ provider: "codex" });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  assert.equal(element.snapshot().model, "gpt-6-astra");

  openModelMenu(element);
  await answerModels(server, {
    models: [{ ...CATALOG.models[1], isDefault: true }],
    unavailable: [],
  });

  assert.equal(element.snapshot().model, "gpt-5.6-sol");
  assert.deepEqual(server.asked(), ["codex/gpt-6-astra", "codex/gpt-5.6-sol"]);
});

test("a list that cannot be read again reads as unavailable and holds the submission", async (t) => {
  const { element, events, server } = mount();
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  assert.equal(element.readyForSubmission(), true);

  openModelMenu(element);
  refuse(server.models().at(-1), "Codex app-server is unavailable.");
  await drain();

  assert.equal(element.readyForSubmission(), false);
  assert.equal(events.at(-1).ready, false);
  const { model, permissionHidden } = drawing(element);
  assert.equal(permissionHidden, true);
  assert.equal(
    model.content,
    '<span class="task-model-name">Unavailable</span>',
  );
  assert.equal(
    model.title,
    "Models could not be loaded. Codex app-server is unavailable.",
  );
});

test("an agent that cannot be asked at a later opening leaves its Task unavailable for that agent's reason", async (t) => {
  const { element, server } = mount({ provider: "codex" });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);

  openModelMenu(element);
  await answerModels(server, {
    models: CATALOG.models.filter((model) => model.provider !== "codex"),
    unavailable: [{ provider: "codex", message: CODEX_SIGN_IN_REQUIRED }],
  });

  assert.equal(element.readyForSubmission(), false);
  assert.equal(
    drawing(element).model.title,
    `Models could not be loaded. ${CODEX_SIGN_IN_REQUIRED}`,
  );
});

test("a list read again after a failure takes the failure's place", async (t) => {
  const { element, server } = mount();
  t.after(() => server.restore());
  refuse(server.models().at(-1), "No agent offered a model.");
  await drain();
  assert.equal(drawing(element).model.classes.includes("is-unavailable"), true);

  openModelMenu(element);
  await answerModels(server);
  await answerModes(server);

  assert.equal(drawing(element).model.classes.includes("is-unavailable"), false);
  assert.equal(element.snapshot().model, "gpt-6-astra");
  assert.equal(element.readyForSubmission(), true);
});

test("a list answered after the control is detached is not taken up", async (t) => {
  const { element, server } = mount({ provider: "codex" });
  t.after(() => server.restore());
  await answerModels(server);
  await answerModes(server);
  openModelMenu(element);
  const late = server.models().at(-1);

  element.disconnectedCallback();
  element.isConnected = false;
  answer(late, {
    models: [{ ...CATALOG.models[1], isDefault: true }],
    unavailable: [],
  });
  await drain();
  element.isConnected = true;
  element.connectedCallback();

  assert.equal(element.snapshot().model, "gpt-6-astra");
  assert.equal(server.models().length, 2);
  openModelMenu(element);
  assert.equal(server.models().length, 3);
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

// The real component, given its context and then connected, with its two
// menus and the agent routes standing in. Each request stays open until the
// test answers it, and every change it announces is kept in `events`.
function mount(context = {}) {
  const server = installAgentServer();
  const nodes = { modelPopover: popoverNode(), permissionPopover: popoverNode() };
  const events = [];
  const element = turnOptionsHost(nodes, {
    dispatchEvent(event) {
      events.push({ ...event.detail, ready: this.readyForSubmission() });
      return true;
    },
  });
  element.setContext({ cwd: "src", ...context });
  element.isConnected = true;
  element.connectedCallback();
  return { element, nodes, events, server };
}

// An element whose menus are `nodes`, read when it looks for them, and whose
// drawing runs `willUpdate()`, `render()`, and `updated()` in turn and keeps
// what `render()` drew.
function turnOptionsHost(nodes, properties = {}) {
  return Object.assign(new TurnOptions(), {
    isConnected: false,
    dataset: {},
    drawn: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    modelPopover: {
      get value() {
        return nodes.modelPopover;
      },
    },
    permissionPopover: {
      get value() {
        return nodes.permissionPopover;
      },
    },
    performUpdate() {
      this.willUpdate();
      this.drawn = this.render();
      this.updated();
    },
    ...properties,
  });
}

// What the last drawing showed on the two closed controls.
function drawing(element) {
  const markup = templateHtml(element.drawn)
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">");
  const button = (name) => {
    const [, classes, attributes, content] = new RegExp(
      `<button type="button" class="(${name}[^"]*)"([^>]*)>(.*?)</button>`,
    ).exec(markup);
    const attribute = (key) =>
      new RegExp(` ${key}="([^"]*)"`).exec(attributes)?.[1];
    return {
      classes: classes.split(" "),
      label: attribute("aria-label"),
      title: attribute("title"),
      busy: attribute("aria-busy") === "true",
      disabled: attributes.includes(' ?disabled="true"'),
      content,
    };
  };
  return {
    model: button("task-model-button"),
    permission: button("task-permission-button"),
    permissionHidden: markup.includes(
      '<div class="task-permission-picker" ?hidden="true">',
    ),
  };
}

// What one menu held in the last drawing.
function menuMarkup(element, kind) {
  return new RegExp(
    `class="task-${kind}-popover-content">([\\s\\S]*?)<caffold-keyboard-navigation-presentation`,
  ).exec(templateHtml(element.drawn).replace(/\s+/g, " "))[1];
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

function openModelMenu(element) {
  element.handleBeforeToggle({
    newState: "open",
    target: element.modelPopover.value,
  });
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

// The icon set is not loaded here, so the shield renders as its empty label.
function permissionButtonHtml(label) {
  return `<span class="sr-only"></span><span class="task-permission-label">${label}</span>`;
}

const LOADING_SLOT_HTML =
  '<span class="task-picker-spinner" aria-hidden="true"></span>';

// A menu element, closed unless `open`; each one hidden is added to `hidden`.
function popoverNode({ open = false, hidden = [] } = {}) {
  return Object.assign(new HTMLElement(), {
    open,
    style: {},
    matches(selector) {
      return selector === ":popover-open" && this.open;
    },
    hidePopover() {
      this.open = false;
      hidden.push(this);
    },
  });
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
