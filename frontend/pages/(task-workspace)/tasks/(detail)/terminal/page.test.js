import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../tests/support/lit-template.js";
import { TERMINAL_EFFECT, TERMINAL_EVENT, TERMINAL_NODE } from "./page/model.js";

const registry = installCustomElementUnitRegistry();
const {
  TERMINAL_PAGE_HEADER_EVENT,
  TERMINAL_PAGE_LEAVE_EVENT,
} = await import("./page.js");
const terminalPage = registry.element("caffold-terminal-page").prototype;
const { ActionHints } = await import("#app/action-hints.js");
after(() => registry.restore());

test("input reaches the shell only from the live screen", () => {
  const sent = [];
  const owner = pageOwner({ sent });

  terminalPage.sendInput.call(owner, { detail: { data: "ls\r", binary: false } });
  owner.state = { ...owner.state, node: TERMINAL_NODE.LIVE };
  terminalPage.sendInput.call(owner, { detail: { data: "한\r", binary: false } });
  terminalPage.sendInput.call(owner, { detail: { data: "\x1b[M \xff!", binary: true } });

  assert.deepEqual(sent.map((bytes) => [...bytes]), [
    [0xed, 0x95, 0x9c, 0x0d],
    [0x1b, 0x5b, 0x4d, 0x20, 0xff, 0x21],
  ]);
});

test("a pending Ctrl turns the next typed key into its control character", () => {
  const sent = [];
  let pending = true;
  const owner = pageOwner({
    sent,
    node: TERMINAL_NODE.LIVE,
    consumeControl: () => {
      const was = pending;
      pending = false;
      return was;
    },
  });

  terminalPage.sendInput.call(owner, { detail: { data: "c", binary: false } });
  terminalPage.sendInput.call(owner, { detail: { data: "c", binary: false } });

  assert.deepEqual(sent.map((bytes) => [...bytes]), [[0x03], [0x63]]);
});

test("special keys follow the program's cursor mode and wait for a live screen", () => {
  const typed = [];
  const owner = pageOwner({ typed, applicationCursor: true });

  terminalPage.sendSpecialKey.call(owner, keyEvent({ key: "up" }));
  owner.state = { ...owner.state, node: TERMINAL_NODE.LIVE };
  terminalPage.sendSpecialKey.call(owner, keyEvent({ key: "up" }));
  terminalPage.sendSpecialKey.call(owner, keyEvent({ key: "left", control: true }));
  terminalPage.sendSpecialKey.call(owner, keyEvent({ key: "escape" }));

  assert.deepEqual(typed, ["\x1bOA", "\x1b[1;5D", "\x1b"]);
});

test("Copy is available exactly while the terminal has text selected", () => {
  const owner = clipboardOwner();

  terminalPage.selectionChanged.call(owner, { detail: { hasSelection: true } });
  assert.equal(owner.keys.copyAvailable, true);
  terminalPage.selectionChanged.call(owner, { detail: { hasSelection: false } });
  assert.equal(owner.keys.copyAvailable, false);
});

test("the row's Copy and Paste reach the screen's clipboard work", () => {
  const owner = clipboardOwner();
  const asked = [];
  owner.copySelection = async () => asked.push("copy");
  owner.pasteClipboard = async () => asked.push("paste");

  for (const action of ["copy", "paste"]) {
    terminalPage.useClipboard.call(owner, keyEvent({ action }));
  }

  assert.deepEqual(asked, ["copy", "paste"]);
});

test("Copy puts the selection on the clipboard and clears it; a failed copy keeps it", async () => {
  const copied = clipboardOwner({ selection: "copy-word" });
  await withClipboard({ writeText: async (text) => copied.written.push(text) }, () =>
    terminalPage.copySelection.call(copied),
  );
  assert.deepEqual(copied.written, ["copy-word"]);
  assert.equal(copied.selection, "");
  assert.deepEqual(copied.results, [true]);

  const refused = clipboardOwner({ selection: "copy-word" });
  await withClipboard({ writeText: async () => Promise.reject(new Error("denied")) }, () =>
    terminalPage.copySelection.call(refused),
  );
  assert.equal(refused.selection, "copy-word");
  assert.deepEqual(refused.results, [false]);

  const unavailable = clipboardOwner({ selection: "copy-word" });
  await withClipboard(undefined, () => terminalPage.copySelection.call(unavailable));
  assert.equal(unavailable.selection, "copy-word");
  assert.deepEqual(unavailable.results, [false]);
});

test("Copy without a selection does nothing, and a selection made meanwhile stays", async () => {
  const empty = clipboardOwner();
  await withClipboard({ writeText: async () => assert.fail("nothing to copy") }, () =>
    terminalPage.copySelection.call(empty),
  );
  assert.deepEqual(empty.results, []);

  const replaced = clipboardOwner({ selection: "first" });
  await withClipboard({ writeText: async () => { replaced.selection = "second"; } }, () =>
    terminalPage.copySelection.call(replaced),
  );
  assert.equal(replaced.selection, "second");
  assert.deepEqual(replaced.results, [true]);
});

test("Paste sends the clipboard only to the live connection it was read for", async () => {
  const live = clipboardOwner({ node: TERMINAL_NODE.LIVE });
  await withClipboard({ readText: async () => "echo pasted\n" }, () =>
    terminalPage.pasteClipboard.call(live),
  );
  assert.deepEqual(live.pasted, ["echo pasted\n"]);

  const connecting = clipboardOwner({ node: TERMINAL_NODE.CONNECTING });
  await withClipboard({ readText: async () => assert.fail("not read") }, () =>
    terminalPage.pasteClipboard.call(connecting),
  );
  assert.deepEqual(connecting.pasted, []);

  const reconnected = clipboardOwner({ node: TERMINAL_NODE.LIVE });
  await withClipboard({
    readText: async () => {
      reconnected.state = { ...reconnected.state, generation: 2 };
      return "echo stale";
    },
  }, () => terminalPage.pasteClipboard.call(reconnected));
  assert.deepEqual(reconnected.pasted, []);

  const lost = clipboardOwner({ node: TERMINAL_NODE.LIVE });
  await withClipboard({
    readText: async () => {
      lost.state = { ...lost.state, node: TERMINAL_NODE.DISCONNECTED };
      return "echo lost";
    },
  }, () => terminalPage.pasteClipboard.call(lost));
  assert.deepEqual(lost.pasted, []);

  const empty = clipboardOwner({ node: TERMINAL_NODE.LIVE });
  await withClipboard({ readText: async () => "" }, () =>
    terminalPage.pasteClipboard.call(empty),
  );
  assert.deepEqual(empty.pasted, []);
  assert.equal(empty.pasteFailures, 0);
});

test("a clipboard Paste cannot read shows a failure and sends nothing", async () => {
  const refused = clipboardOwner({ node: TERMINAL_NODE.LIVE });
  await withClipboard({ readText: async () => Promise.reject(new Error("denied")) }, () =>
    terminalPage.pasteClipboard.call(refused),
  );
  assert.deepEqual(refused.pasted, []);
  assert.equal(refused.pasteFailures, 1);
});

test("the backend's messages reset the screen and move the control model", () => {
  const applied = [];
  const resized = [];
  const owner = pageOwner({ applied, resized, generation: 4 });

  terminalPage.receiveMessage.call(owner, 4, "attached");
  terminalPage.receiveMessage.call(owner, 4, "resync");
  for (const type of ["elsewhere", "absent", "taken", "ended", "unknown"]) {
    terminalPage.receiveMessage.call(owner, 4, type);
  }
  terminalPage.receiveMessage.call(owner, 3, "ended");

  assert.equal(owner.resets, 2);
  assert.deepEqual(applied, [
    { type: TERMINAL_EVENT.ATTACHED, generation: 4 },
    { type: TERMINAL_EVENT.ELSEWHERE, generation: 4 },
    { type: TERMINAL_EVENT.ABSENT, generation: 4 },
    { type: TERMINAL_EVENT.TAKEN, generation: 4 },
    { type: TERMINAL_EVENT.ENDED, generation: 4 },
  ]);
  // The screen's own size follows the attach, which used the size at connect.
  assert.deepEqual(resized, [{ cols: 90, rows: 30 }]);
});

test("the transport the Detail reports follows the control node", () => {
  const expected = new Map([
    [TERMINAL_NODE.CONNECTING, "connecting"],
    [TERMINAL_NODE.LIVE, "ready"],
    [TERMINAL_NODE.DISCONNECTED, "unavailable"],
    [TERMINAL_NODE.EMPTY, "idle"],
    [TERMINAL_NODE.ELSEWHERE, "idle"],
    [TERMINAL_NODE.SUSPENDED, "idle"],
    [TERMINAL_NODE.INACTIVE, "idle"],
  ]);
  const transport = Object.getOwnPropertyDescriptor(terminalPage, "transportState").get;
  for (const [node, state] of expected) {
    assert.equal(transport.call({ state: { node } }), state, node);
  }
});

test("recovery waits for the new connection to succeed or fail", async () => {
  const owner = { state: { node: TERMINAL_NODE.CONNECTING }, settleWaiters: [] };
  const settle = () => terminalPage.settleWaiting.call(owner);
  const succeeded = terminalPage.settled.call({ ...owner, settleWaiting: settle });
  owner.state = { node: TERMINAL_NODE.LIVE };
  settle();
  assert.deepEqual(await succeeded, { ok: true });

  owner.state = { node: TERMINAL_NODE.CONNECTING };
  const failed = terminalPage.settled.call({ ...owner, settleWaiting: settle });
  owner.state = { node: TERMINAL_NODE.DISCONNECTED };
  settle();
  await assert.rejects(failed, /connection failed/);
});

test("an ended terminal asks the Detail layout to leave the screen", () => {
  const dispatched = [];
  const owner = pageOwner();
  owner.dispatchEvent = (event) => dispatched.push(event);

  terminalPage.runEffect.call(owner, TERMINAL_EFFECT.LEAVE);

  assert.deepEqual(
    dispatched.map((event) => [event.type, event.bubbles]),
    [[TERMINAL_PAGE_LEAVE_EVENT, true]],
  );
});

test("clearing the screen closes the terminal the view drew", () => {
  const owner = pageOwner();

  terminalPage.runEffect.call(owner, TERMINAL_EFFECT.CLEAR);

  assert.equal(owner.closes, 1);
});

test("the header toggle keeps the choice in the browser and tells the Detail layout", () => {
  const stored = [];
  const owner = headerOwner();
  withWindow({ localStorage: { setItem: (key, value) => stored.push([key, value]) } }, () => {
    terminalPage.toggleHeader.call(owner);
    terminalPage.toggleHeader.call(owner);
  });

  assert.deepEqual(owner.shown, [true, false]);
  assert.deepEqual(stored, [
    ["caffold:terminal-header-hidden", "true"],
    ["caffold:terminal-header-hidden", "false"],
  ]);
  assert.deepEqual(
    owner.dispatched.map((event) => [event.type, event.bubbles]),
    [[TERMINAL_PAGE_HEADER_EVENT, true], [TERMINAL_PAGE_HEADER_EVENT, true]],
  );
});

test("the header toggle still works where the browser keeps no storage", () => {
  const owner = headerOwner();
  const storage = {};
  Object.defineProperty(storage, "localStorage", {
    get: () => {
      throw new Error("storage is off");
    },
  });
  withWindow(storage, () => terminalPage.toggleHeader.call(owner));

  assert.deepEqual(owner.shown, [true]);
  assert.equal(owner.dispatched.length, 1);
});

test("without the header the toggle offers it back and leaving joins the bar", () => {
  const attributes = new Set();
  const owner = Object.create(terminalPage, Object.getOwnPropertyDescriptors({
    state: { node: TERMINAL_NODE.LIVE, generation: 1, mode: null, error: "" },
    headerChoice: true,
    specialKeysShown: false,
    dataset: {},
    hasAttribute: (name) => attributes.has(name),
    toggleAttribute: (name, on) => (on ? attributes.add(name) : attributes.delete(name)),
  }));
  owner.hints = new ActionHints(owner);
  const bar = () => {
    terminalPage.updated.call(owner);
    return templateHtml(owner.render()).replace(/\s+/g, " ");
  };

  const hidden = bar();
  assert.deepEqual([...attributes], ["data-header-hidden"]);
  assert.match(hidden, /data-terminal-action="header" aria-expanded="false" aria-label="Show header" title="Show header"/);
  assert.match(hidden, /data-terminal-action="leave" aria-label="Leave terminal" title="Leave terminal" \?hidden="false"/);

  owner.headerChoice = false;
  const shown = bar();
  assert.deepEqual([...attributes], []);
  assert.match(shown, /data-terminal-action="header" aria-expanded="true" aria-label="Hide header" title="Hide header"/);
  assert.match(shown, /data-terminal-action="leave" aria-label="Leave terminal" title="Leave terminal" \?hidden="true"/);
});

function headerOwner() {
  const owner = {
    headerChoice: false,
    shown: [],
    dispatched: [],
    get headerHidden() {
      return owner.headerChoice;
    },
    draw: () => owner.shown.push(owner.headerChoice),
    dispatchEvent: (event) => owner.dispatched.push(event),
  };
  return owner;
}

function keyEvent(detail) {
  return { detail, stopPropagation() {} };
}

// A screen whose terminal holds `selection` and whose special key row records
// what it was told.
function clipboardOwner({ node = TERMINAL_NODE.LIVE, selection = "" } = {}) {
  const owner = {
    state: { node, generation: 1, mode: null, error: "" },
    selection,
    written: [],
    pasted: [],
    results: [],
    pasteFailures: 0,
    keys: {
      copyAvailable: false,
      showCopyResult: (copied) => owner.results.push(copied),
      showPasteFailure: () => {
        owner.pasteFailures += 1;
      },
    },
  };
  owner.terminalView = {
    value: {
      selectionText: () => owner.selection,
      clearSelection: () => {
        owner.selection = "";
      },
      paste: (text) => owner.pasted.push(text),
    },
  };
  owner.specialKeys = { value: owner.keys };
  return owner;
}

async function withClipboard(clipboard, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
  });
  try {
    await run();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete globalThis.navigator;
    }
  }
}

function withWindow(window, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  try {
    run();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      delete globalThis.window;
    }
  }
}

function pageOwner({
  sent = [],
  typed = [],
  applied = [],
  resized = [],
  node = TERMINAL_NODE.CONNECTING,
  generation = 1,
  applicationCursor = false,
  consumeControl = () => false,
} = {}) {
  const view = {
    size: { cols: 90, rows: 30 },
    reset: () => {
      owner.resets += 1;
    },
    close: () => {
      owner.closes += 1;
    },
    sendInput: (text) => typed.push(text),
    applicationCursorKeys: () => applicationCursor,
  };
  const owner = {
    state: { node, generation, mode: null, error: "" },
    encoder: new TextEncoder(),
    resets: 0,
    closes: 0,
    connection: {
      send: (bytes) => sent.push(bytes),
      resize: (size) => resized.push(size),
    },
    terminalView: { value: view },
    specialKeys: { value: { consumeControl } },
    apply: (event) => {
      applied.push(event);
      return true;
    },
  };
  return owner;
}
