import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./copy-markdown.ts");
const copyMarkdown = registry.element("caffold-notes-info-copy-markdown").prototype;
after(() => registry.restore());

const STORAGE = {
  id: "storage",
  name: "Storage decision",
  content: "# Storage\n\nKeep **one** current copy.\n",
  location: [{ id: "projects", name: "Projects" }],
};

function control() {
  return {
    attributes: new Map(),
    clicks: 0,
    disabled: false,
    textContent: "Copy Markdown",
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

function copyMarkdownHost(properties = {}) {
  const host = {
    isConnected: true,
    generation: 0,
    copyState: "idle",
    markdown: "",
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
    host[method] = copyMarkdown[method];
  }
  return host;
}

function setNote(host, note) {
  host.note = note;
  host.willUpdate(NOTE_CHANGED);
}

test("retires a copy in flight when the Note's content changes, and only then", () => {
  const host = copyMarkdownHost();
  setNote(host, STORAGE);
  assert.equal(host.markdown, STORAGE.content);
  host.copyState = "copying";
  const inFlight = host.generation;

  setNote(host, { ...STORAGE, name: "Storage decision, renamed" });
  assert.equal(host.acceptsCompletion(inFlight), true);

  setNote(host, { ...STORAGE, content: "# Storage, rewritten\n" });
  assert.equal(host.acceptsCompletion(inFlight), false);
  assert.equal(host.copyState, "idle");
});

test("copies the Note's Markdown, reports the outcome until it clears, and copies nothing for an empty Note", async (t) => {
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
  const host = copyMarkdownHost();
  setNote(host, STORAGE);
  const written = [];
  clipboard.writeText = async (text) => {
    written.push(text);
  };

  await host.copy();
  assert.deepEqual(written, [STORAGE.content]);
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
  setNote(host, { ...STORAGE, content: "# Storage, rewritten\n" });
  release();
  await pending;
  assert.equal(host.copyState, "idle");

  setNote(host, { ...STORAGE, content: "" });
  written.length = 0;
  clipboard.writeText = async (text) => {
    written.push(text);
  };
  await host.copy();
  assert.deepEqual(written, []);
});

test("offers Copy Markdown to the popover's Action Hints while there is Markdown to copy", () => {
  const button = control();
  const host = copyMarkdownHost({ button });
  setNote(host, STORAGE);
  const popover = { id: "popover" };
  let current = true;
  const scopeOf = () => host.actionHintScope({
    scopeId: "notes:storage:details",
    clipRoots: [popover],
    isCurrent: () => current,
  });

  const [target] = scopeOf().targets;
  assert.deepEqual(
    { id: target.id, actionId: target.actionId, label: target.label },
    {
      id: "notes:storage:details:copy-markdown",
      actionId: "button.activate",
      label: "Copy Markdown",
    },
  );
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(button.clicks, 1);

  current = false;
  assert.equal(target.isActionable(), false);
  current = true;

  host.markdown = "# Storage, rewritten\n";
  assert.equal(target.isActionable(), false, "a target belongs to the content it was offered for");
  host.markdown = STORAGE.content;

  button.disabled = true;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scopeOf().targets, [], "an empty Note offers nothing to copy");
});

test("refuses a completion that outlived its element", () => {
  const host = copyMarkdownHost({ generation: 3 });
  assert.equal(host.acceptsCompletion(3), true);
  host.isConnected = false;
  assert.equal(host.acceptsCompletion(3), false);
});
