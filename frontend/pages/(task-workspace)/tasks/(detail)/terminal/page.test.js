import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";
import { TERMINAL_EFFECT, TERMINAL_EVENT, TERMINAL_NODE } from "./page/model.js";

const registry = installCustomElementUnitRegistry();
const { TERMINAL_PAGE_LEAVE_EVENT } = await import("./page.js");
const terminalPage = registry.element("caffold-terminal-page").prototype;
after(() => registry.restore());

test("input reaches the shell only from the live screen", () => {
  const sent = [];
  const owner = pageOwner({ sent });

  terminalPage.sendInput.call(owner, { data: "ls\r", binary: false });
  owner.state = { ...owner.state, node: TERMINAL_NODE.LIVE };
  terminalPage.sendInput.call(owner, { data: "한\r", binary: false });
  terminalPage.sendInput.call(owner, { data: "\x1b[M \xff!", binary: true });

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

  terminalPage.sendInput.call(owner, { data: "c", binary: false });
  terminalPage.sendInput.call(owner, { data: "c", binary: false });

  assert.deepEqual(sent.map((bytes) => [...bytes]), [[0x03], [0x63]]);
});

test("special keys follow the program's cursor mode and wait for a live screen", () => {
  const typed = [];
  const owner = pageOwner({ typed, applicationCursor: true });

  terminalPage.sendSpecialKey.call(owner, { key: "up" });
  owner.state = { ...owner.state, node: TERMINAL_NODE.LIVE };
  terminalPage.sendSpecialKey.call(owner, { key: "up" });
  terminalPage.sendSpecialKey.call(owner, { key: "left", control: true });
  terminalPage.sendSpecialKey.call(owner, { key: "escape" });

  assert.deepEqual(typed, ["\x1bOA", "\x1b[1;5D", "\x1b"]);
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
    sendInput: (text) => typed.push(text),
    applicationCursorKeys: () => applicationCursor,
  };
  const owner = {
    state: { node, generation, mode: null, error: "" },
    encoder: new TextEncoder(),
    resets: 0,
    connection: {
      send: (bytes) => sent.push(bytes),
      resize: (size) => resized.push(size),
    },
    terminalView: () => view,
    specialKeys: () => ({ consumeControl }),
    apply: (event) => {
      applied.push(event);
      return true;
    },
  };
  return owner;
}
