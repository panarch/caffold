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

function composerButton({ action = "", primaryAction = "", imageId = "", fileId = "" }) {
  return {
    dataset: { composerAction: action, primaryAction, imageId, fileId },
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
  const attach = composerButton({ action: "attach" });
  const browse = composerButton({ action: "browse-cwd" });
  const voice = composerButton({ action: "voice" });
  const cancelVoice = composerButton({ action: "cancel-voice" });
  const cancel = composerButton({ action: "cancel" });
  const primary = composerButton({ primaryAction: "start" });
  const preview = composerButton({ action: "preview-image", imageId: "image-a" });
  const remove = composerButton({ action: "remove-image", imageId: "image-a" });
  const removeFile = composerButton({ action: "remove-file", fileId: "file-b" });
  let controls = [
    attach,
    browse,
    voice,
    cancelVoice,
    cancel,
    primary,
    preview,
    remove,
    removeFile,
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
      (!selector.includes("[data-image-id]") || dataset.imageId) &&
      (!selector.includes("[data-file-id]") || dataset.fileId)
    );
  };
  const owner = {
    isConnected: true,
    context: { mode: "create", threadId: "", cwd: "/repo" },
    state: {
      activeSubmissionId: null,
      attachments: [{ id: "image-a" }, { id: "file-b" }],
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
    "task-composer:new:attach",
    "task-composer:new:browse-cwd",
    "task-composer:new:voice",
    "task-composer:new:cancel-voice",
    "task-composer:new:cancel",
    "task-composer:new:primary:start",
    "task-composer:new:preview-image:image-a",
    "task-composer:new:remove-image:image-a",
    "task-composer:new:remove-file:file-b",
  ]);
  targets.forEach((target) => target.activate());
  assert.deepEqual(
    controls.map(({ clicks }) => clicks),
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
  );

  owner.state.attachments = [{ id: "image-a" }];
  assert.equal(targets[6].isActionable(), true);
  assert.equal(targets[8].isActionable(), false);
  owner.state.attachments = [];
  assert.equal(targets[6].isActionable(), false);
  owner.state.activeSubmissionId = "submission-a";
  assert.equal(targets[1].isActionable(), false);
  controls = controls.filter((control) => control !== voice);
  assert.equal(targets[2].isActionable(), false);
});

test("offers Send once the turn options have settled what the turn runs under", () => {
  let ready = false;
  const owner = {
    context: { mode: "follow-up", submitLabel: "Send prompt" },
    voice: { phase: "idle" },
    state: { prompt: "Keep going", attachments: [] },
    stateFor() {
      return this.state;
    },
    activeSubmissionFor: () => null,
    turnOptions: () => ({ readyForSubmission: () => ready }),
  };
  const action = () => {
    const { kind, disabled } = composer.primaryActionView.call(owner);
    return { kind, disabled };
  };

  assert.deepEqual(action(), { kind: "send", disabled: true });
  ready = true;
  assert.deepEqual(action(), { kind: "send", disabled: false });

  // Finishing a recording sends it, so it waits as well; stopping a turn sends
  // nothing and does not.
  ready = false;
  owner.voice.phase = "recording";
  assert.deepEqual(action(), { kind: "send", disabled: true });
  owner.voice.phase = "idle";
  owner.state.prompt = "";
  // A Task at work can be stopped whether or not its turn is known yet.
  Object.assign(owner.context, { turnActive: true });
  assert.deepEqual(action(), { kind: "stop", disabled: false });
});

test("renders Send after the turn options take the new context", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    let ready = true;
    const node = () => ({ dataset: {}, setAttribute() {}, removeAttribute() {} });
    const nodes = {
      ":scope > form[data-task-form]": node(),
      "textarea[name='prompt']": { ...node(), value: "Keep going" },
      ".task-composer-actions": { innerHTML: "" },
      'button[data-composer-action="attach"]': node(),
    };
    const owner = {
      context: { mode: "follow-up", threadId: "thread-1", submitLabel: "Send prompt" },
      voice: { phase: "idle" },
      state: { prompt: "Keep going", attachments: [] },
      ensureState() {},
      ensureRendered() {},
      stateFor() {
        return this.state;
      },
      activeSubmissionFor: () => null,
      acceptsAttachments: composer.acceptsAttachments,
      primaryActionView: composer.primaryActionView,
      querySelector: (selector) => nodes[selector],
      setRegion() {},
      renderVoiceStatus: () => "",
      renderVoiceControls: () => "",
      turnOptions: () => ({ readyForSubmission: () => ready }),
      // A new working directory asks for its own permission list.
      syncTurnOptionsContext() {
        ready = false;
      },
      syncTurnOptionsFields() {},
      notifyLayoutChange() {},
    };

    composer.render.call(owner);

    assert.match(nodes[".task-composer-actions"].innerHTML, /\sdisabled\s/);
  } finally {
    restoreGlobal("document", previousDocument);
  }
});

test("stops an upload in place of the disabled Send, and names what it stops", () => {
  const owner = {
    context: { mode: "follow-up", submitLabel: "Send prompt", uploading: true },
    voice: { phase: "idle" },
    state: { prompt: "", attachments: [] },
    stateFor() {
      return this.state;
    },
    activeSubmissionFor: () => ({ id: "uploading" }),
    turnOptions: () => ({ readyForSubmission: () => true }),
  };
  const action = () => {
    const { kind, label, disabled } = composer.primaryActionView.call(owner);
    return { kind, label, disabled };
  };

  assert.deepEqual(action(), { kind: "stop", label: "Cancel upload", disabled: false });
  owner.context.turnActive = true;
  assert.deepEqual(action(), { kind: "stop", label: "Stop current turn", disabled: false });
  owner.context.interrupting = true;
  assert.deepEqual(action(), { kind: "send", label: "Send prompt", disabled: true });
  owner.context = { mode: "follow-up", submitLabel: "Send prompt" };
  assert.deepEqual(action(), { kind: "send", label: "Send prompt", disabled: true });
});

test("puts messages that never reached the agent ahead of what was written since", () => {
  const owner = {
    state: {
      prompt: "written since",
      attachments: [{ id: "new" }],
      attachmentError: "",
    },
    stateFor() {
      return this.state;
    },
    captureCurrentState() {},
  };

  composer.restoreAheadOfDraft.call(
    owner,
    ["sent first", "", "sent second"],
    Array.from({ length: 10 }, (_, index) => ({ id: `returned-${index}` })),
  );

  assert.equal(owner.state.prompt, "sent first\n\nsent second\n\nwritten since");
  assert.equal(owner.state.selectionStart, owner.state.prompt.length);
  assert.deepEqual(
    owner.state.attachments.map(({ id }) => id),
    Array.from({ length: 10 }, (_, index) => `returned-${index}`),
  );
  assert.equal(owner.state.attachmentError, "Attach up to 10 files.");
});

test("attaches any file, showing only pictures every agent reads as thumbnails", async () => {
  const previousFileReader = globalThis.FileReader;
  globalThis.FileReader = class extends EventTarget {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,AAAA`;
      this.dispatchEvent(new Event("load"));
    }
  };
  try {
    const owner = {
      state: { attachments: [], attachmentError: "" },
      stateFor() {
        return this.state;
      },
      renders: 0,
      render() {
        this.renders += 1;
      },
    };
    const file = (name, type, size = 10) => ({ name, type, size });

    await composer.addAttachments.call(owner, [
      file("shot.png", "image/png"),
      file("photo.heic", "image/heic"),
      file("server.log", "text/plain"),
      file("huge.png", "image/png", 11 * 1024 * 1024),
      file("too-big.zip", "application/zip", 100 * 1024 * 1024 + 1),
    ]);

    assert.deepEqual(
      owner.state.attachments.map(({ name, imageInput, dataUrl }) => ({ name, imageInput, dataUrl })),
      [
        { name: "shot.png", imageInput: true, dataUrl: "data:image/png;base64,AAAA" },
        { name: "photo.heic", imageInput: false, dataUrl: "" },
        { name: "server.log", imageInput: false, dataUrl: "" },
        { name: "huge.png", imageInput: false, dataUrl: "" },
      ],
    );
    assert.equal(owner.state.attachmentError, "too-big.zip is larger than 100 MB.");

    await composer.addAttachments.call(owner, [file("", "image/png")], { pasted: true });
    assert.equal(owner.state.attachments.at(-1).name, "clipboard-image-5.png");

    await composer.addAttachments.call(
      owner,
      Array.from({ length: 6 }, (_, index) => file(`${index}.txt`, "text/plain")),
    );
    assert.equal(owner.state.attachments.length, 10);
    assert.equal(owner.state.attachmentError, "Attach up to 10 files.");
  } finally {
    restoreGlobal("FileReader", previousFileReader);
  }
});

test("takes the files of a drop and refuses the folders in it", async () => {
  const added = [];
  const owner = {
    acceptsAttachments: () => true,
    setDropTarget() {},
    async addAttachments(files, options) {
      added.push({ names: files.map(({ name }) => name), error: options.error });
    },
  };
  const item = (name, directory) => ({
    kind: "file",
    webkitGetAsEntry: () => ({ isDirectory: directory }),
    getAsFile: () => ({ name }),
  });
  let prevented = false;

  await composer.handleDrop.call(owner, {
    preventDefault() {
      prevented = true;
    },
    dataTransfer: {
      types: ["Files"],
      items: [item("server.log", false), item("src", true)],
      files: [],
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(added, [{ names: ["server.log"], error: "Folders cannot be attached." }]);
});

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
