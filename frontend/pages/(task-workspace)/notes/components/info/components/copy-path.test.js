import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./copy-path.ts");
const copyPath = registry.element("caffold-notes-info-copy-path").prototype;
after(() => registry.restore());

const STORAGE = {
  id: "storage",
  name: "Storage decision",
  content: "# Storage\n",
  location: [
    { id: "projects", name: "Projects" },
    { id: "decisions", name: "Decisions" },
  ],
};

function control() {
  return {
    attributes: new Map(),
    clicks: 0,
    textContent: "Copy path",
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

const NOTE_CHANGED = new Map([["note", undefined]]);

function copyPathHost(properties = {}) {
  const host = {
    isConnected: true,
    generation: 0,
    copyState: "idle",
    path: "",
    note: null,
    button: null,
    clearFeedback() {},
    ...properties,
  };
  for (const method of [
    "willUpdate",
    "copy",
    "actionHintScope",
    "acceptsCompletion",
    "invalidatePendingCopy",
  ]) {
    host[method] = copyPath[method];
  }
  return host;
}

function setNote(host, note) {
  host.note = note;
  host.willUpdate(NOTE_CHANGED);
}

test("copies the directories that hold the Note, its name, and its id", () => {
  const host = copyPathHost();

  setNote(host, STORAGE);
  assert.equal(host.path, "Projects / Decisions / Storage decision (note id: storage)");

  setNote(host, { id: "inbox", name: "Inbox", content: "", location: [] });
  assert.equal(host.path, "Inbox (note id: inbox)");
});

test("retires a copy in flight when the Note's path changes, and only then", () => {
  const host = copyPathHost();
  setNote(host, STORAGE);
  host.copyState = "copying";
  const inFlight = host.generation;

  setNote(host, { ...STORAGE, content: "# Storage, rewritten\n" });
  assert.equal(host.acceptsCompletion(inFlight), true);

  setNote(host, { ...STORAGE, name: "Storage decision, renamed" });
  assert.equal(host.acceptsCompletion(inFlight), false);
  assert.equal(host.copyState, "idle");

  // Another Note under the same name is a different path to copy.
  host.copyState = "copying";
  const sameName = host.generation;
  setNote(host, { ...STORAGE, id: "storage-copy", name: "Storage decision, renamed" });
  assert.equal(host.acceptsCompletion(sameName), false);
});

test("reports Copied or a failure until the feedback clears, and drops an outdated answer", async (t) => {
  const timers = [];
  globalThis.window = { setTimeout: (callback) => timers.push(callback) };
  const clipboard = {};
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  t.after(() => {
    delete globalThis.window;
    delete globalThis.navigator.clipboard;
  });
  const host = copyPathHost();
  setNote(host, STORAGE);
  const written = [];
  clipboard.writeText = async (text) => {
    written.push(text);
  };

  await host.copy();
  assert.deepEqual(written, ["Projects / Decisions / Storage decision (note id: storage)"]);
  assert.equal(host.copyState, "copied");
  timers.shift()();
  assert.equal(host.copyState, "idle");

  clipboard.writeText = async () => {
    throw new Error("denied");
  };
  await host.copy();
  assert.equal(host.copyState, "failed");

  let release;
  clipboard.writeText = () => new Promise((resolve) => {
    release = resolve;
  });
  const pending = host.copy();
  assert.equal(host.copyState, "copying");
  setNote(host, { id: "inbox", name: "Inbox", content: "", location: [] });
  release();
  await pending;
  assert.equal(host.copyState, "idle");
});

test("offers Copy path to the popover's Action Hints for the path it was offered for", () => {
  const button = control();
  const host = copyPathHost({ button });
  setNote(host, STORAGE);
  const popover = { id: "popover" };
  let current = true;
  const scopeOf = () => host.actionHintScope({
    scopeId: "notes:storage:details",
    clipRoots: [popover],
    isCurrent: () => current,
  });

  const scope = scopeOf();
  assert.deepEqual(scope.mutationRoots, [host]);
  const [target] = scope.targets;
  assert.deepEqual(
    { id: target.id, actionId: target.actionId, label: target.label },
    {
      id: "notes:storage:details:copy-path",
      actionId: "button.activate",
      label: "Copy path",
    },
  );
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(button.clicks, 1);

  button.attributes.set("aria-disabled", "true");
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scopeOf().targets, []);
  button.attributes.delete("aria-disabled");

  current = false;
  assert.equal(target.isActionable(), false);
  current = true;

  host.path = "Inbox (note id: inbox)";
  assert.equal(target.isActionable(), false, "a target belongs to the path it was offered for");
});

test("refuses a completion that outlived its element", () => {
  const host = copyPathHost({ generation: 3 });
  assert.equal(host.acceptsCompletion(3), true);
  host.isConnected = false;
  assert.equal(host.acceptsCompletion(3), false);
});
