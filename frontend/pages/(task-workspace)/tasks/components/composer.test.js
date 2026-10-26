import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./composer.ts");
const { ActionHints } = await import("#app/action-hints.ts");
const Composer = registry.element("caffold-task-composer");
after(() => registry.restore());

test("offers Send once the turn options have settled what the turn runs under", () => {
  let ready = false;
  const owner = composerHost({
    turnOptions: () => ({ readyForSubmission: () => ready }),
  });
  owner.context.mode = "follow-up";
  owner.voice.phase = "idle";
  owner.state.prompt = "Keep going";
  const action = () => {
    const { kind, disabled } = owner.primaryActionView();
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
  owner.context.turnActive = true;
  assert.deepEqual(action(), { kind: "stop", disabled: false });
});

test("draws Send again once the turn options take the new context", () => {
  let ready = true;
  let taken = "";
  const drawnSend = [];
  const turnOptions = {
    readyForSubmission: () => ready,
    // A new working directory asks for its own permission list, which the
    // turn options announce as it goes out.
    setContext(context) {
      if (JSON.stringify(context) === taken) {
        return false;
      }
      taken = JSON.stringify(context);
      ready = false;
      owner.turnOptionsChanged({ target: turnOptions });
      return true;
    },
  };
  const owner = composerHost({
    turnOptions: () => turnOptions,
    performUpdate() {
      drawnSend.push(this.primaryActionView().disabled);
    },
  });
  owner.context.mode = "follow-up";
  owner.voice.phase = "idle";
  owner.state.prompt = "Keep going";

  owner.draw();

  assert.deepEqual(drawnSend, [false, true]);
  assert.deepEqual(JSON.parse(taken), {
    cwd: ".",
    provider: "",
    initialSelection: { model: "", effort: "", fastMode: false, permissionMode: "" },
    locked: false,
    placement: "above",
  });
});

test("stops an upload in place of the disabled Send, and names what it stops", () => {
  const owner = composerHost({
    turnOptions: () => ({ readyForSubmission: () => true }),
    activeSubmissionFor: () => ({ id: "uploading" }),
  });
  Object.assign(owner.context, { mode: "follow-up", uploading: true });
  owner.voice.phase = "idle";
  const action = () => {
    const { kind, label, disabled } = owner.primaryActionView();
    return { kind, label, disabled };
  };

  assert.deepEqual(action(), { kind: "stop", label: "Cancel upload", disabled: false });
  owner.context.turnActive = true;
  assert.deepEqual(action(), { kind: "stop", label: "Stop current turn", disabled: false });
  owner.context.interrupting = true;
  assert.deepEqual(action(), { kind: "send", label: "Send prompt", disabled: true });
  owner.context = { ...owner.context, uploading: false, interrupting: false, turnActive: false };
  assert.deepEqual(action(), { kind: "send", label: "Send prompt", disabled: true });
});

test("puts a suggested request after what is being written, ready to read and send", () => {
  const focused = [];
  let locked = false;
  const owner = composerHost({
    promptFieldLocked: () => locked,
    focus() {
      focused.push({ ...this.state });
    },
  });
  const append = (prompt) => owner.appendSuggestedPrompt(prompt);

  assert.equal(append("Compare the two vendors."), true);
  assert.equal(owner.state.prompt, "Compare the two vendors.");

  owner.state.prompt = "Also check this \n\n";
  assert.equal(append("Explain the card approval flow."), true);
  assert.equal(
    owner.state.prompt,
    "Also check this\n\nExplain the card approval flow.",
  );
  assert.equal(owner.state.selectionStart, owner.state.prompt.length);
  assert.equal(owner.state.selectionEnd, owner.state.prompt.length);
  assert.deepEqual(
    focused.map(({ selectionStart }) => selectionStart),
    [24, owner.state.prompt.length],
    "focus lands after each request",
  );

  const before = owner.state.prompt;
  assert.equal(append("  "), false);
  locked = true;
  assert.equal(append("Summarize the failed cases."), false);
  assert.equal(owner.state.prompt, before);
  assert.equal(focused.length, 2);
});

test("takes no text in its prompt field while dictating or creating", () => {
  const owner = (phase, { disabled = false, mode = "follow-up", submitting = false } = {}) => {
    const host = composerHost({
      activeSubmissionFor: () => (submitting ? { id: "submission" } : null),
    });
    Object.assign(host.context, { disabled, mode });
    host.voice.phase = phase;
    return host;
  };
  const locked = (host) => host.promptFieldLocked();

  assert.equal(locked(owner("idle")), false);
  assert.equal(locked(owner("idle", { submitting: true })), false);
  assert.equal(locked(owner("idle", { disabled: true })), false);
  for (const phase of ["requesting", "recording", "transcribing"]) {
    assert.equal(locked(owner(phase)), true, phase);
  }
  assert.equal(locked(owner("idle", { mode: "create", submitting: true })), true);
});

test("puts messages that never reached the agent ahead of what was written since", () => {
  const owner = composerHost();
  Object.assign(owner.state, {
    prompt: "written since",
    attachments: [{ id: "new" }],
  });

  owner.restoreAheadOfDraft(
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
    const owner = composerHost();
    const file = (name, type, size = 10) => ({ name, type, size });

    await owner.addAttachments([
      file("shot.png", "image/png"),
      file("photo.heic", "image/heic"),
      file("server.log", "text/plain", 5 * 1024 * 1024 * 1024),
      file("huge.png", "image/png", 11 * 1024 * 1024),
      file("too-big.zip", "application/zip", 5 * 1024 * 1024 * 1024 + 1),
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
    assert.equal(owner.state.attachmentError, "too-big.zip is larger than 5 GB.");

    await owner.addAttachments([file("", "image/png")], { pasted: true });
    assert.equal(owner.state.attachments.at(-1).name, "clipboard-image-5.png");

    await owner.addAttachments(
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
  const owner = composerHost({
    acceptsAttachments: () => true,
    async addAttachments(files, options) {
      added.push({ names: files.map(({ name }) => name), error: options.error });
    },
  });
  const item = (name, directory) => ({
    kind: "file",
    webkitGetAsEntry: () => ({ isDirectory: directory }),
    getAsFile: () => ({ name }),
  });
  let prevented = false;

  await owner.handleDrop({
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
  assert.equal(owner.dropTarget, false);
  assert.deepEqual(added, [{ names: ["server.log"], error: "Folders cannot be attached." }]);
});

test("hands the agent's count to the context pie without drawing the Composer again", () => {
  const snapshots = [];
  const owner = composerHost({
    contextUsage: { setSnapshot: (context) => snapshots.push(context) },
    draw() {
      throw new Error("a new count is the pie's alone");
    },
  });

  owner.setContextUsage({ usedTokens: 32_147, windowTokens: 200_000 });
  owner.setContextUsage(null);

  assert.deepEqual(snapshots, [{ usedTokens: 32_147, windowTokens: 200_000 }, null]);
});

test("shows the context pie only in a Task's follow-up Composer", () => {
  const owner = composerHost({
    turnOptions: () => ({ readyForSubmission: () => true, snapshot: () => null }),
  });
  Object.assign(owner.context, { mode: "follow-up", threadId: "thread-1" });
  const pieHidden = () =>
    /<caffold-task-context-usage\s+\?hidden="(true|false)"/.exec(
      templateHtml(owner.render()),
    )[1];

  assert.equal(pieHidden(), "false");

  owner.context = { ...owner.context, mode: "create", threadId: "" };
  assert.equal(pieHidden(), "true");
});

// A Composer with its own fields as it starts, and no drawing of its own.
function composerHost(properties = {}) {
  const host = Object.create(Composer.prototype, {
    ...Object.getOwnPropertyDescriptors({
      context: {
        mode: "create",
        threadId: "",
        cwd: ".",
        placeholder: "",
        ariaLabel: "Task prompt",
        submitLabel: "Send prompt",
        cancel: false,
        disabled: false,
        settingsLocked: false,
        requestError: "",
        turnActive: false,
        uploading: false,
        interrupting: false,
        interruptError: "",
        fastMode: false,
      },
      voice: {
        phase: "checking",
        error: "",
        ready: false,
        maxRecordingSeconds: 300,
        elapsedSeconds: 0,
        recordingLimitReached: false,
      },
      state: {
        prompt: "",
        attachments: [],
        attachmentError: "",
        selectionStart: 0,
        selectionEnd: 0,
        activeSubmissionId: "",
      },
      activeSubmissions: new Map(),
      dropTarget: false,
      isConnected: false,
      promptField: { value: undefined },
      attachmentStrip: { value: undefined },
      levelMeter: { value: undefined },
      dispatchEvent: () => true,
      turnOptions: () => null,
      requestUpdate() {},
      performUpdate() {},
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  host.hints = new ActionHints(host);
  return host;
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
