import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_EFFECT,
  TERMINAL_EVENT,
  TERMINAL_MODE,
  TERMINAL_NODE,
  initialTerminalState,
  terminalTransition,
} from "./model.js";

const { CONNECT, DISCONNECT, FOCUS, RELEASE_FOCUS, LEAVE } = TERMINAL_EFFECT;

test("activation connects with the mode it was asked in", () => {
  for (const mode of [TERMINAL_MODE.TAKE, TERMINAL_MODE.RESUME]) {
    const result = apply(initialTerminalState(), activate(mode));
    assert.equal(result.state.node, TERMINAL_NODE.CONNECTING);
    assert.equal(result.state.mode, mode);
    assert.equal(result.state.generation, 1);
    assert.deepEqual(result.effects, [CONNECT]);
  }
});

test("an attached taken terminal takes focus and a resumed one does not", () => {
  const taken = apply(connectingState(TERMINAL_MODE.TAKE), backend("ATTACHED", 1));
  assert.equal(taken.state.node, TERMINAL_NODE.LIVE);
  assert.deepEqual(taken.effects, [FOCUS]);
  assert.equal(taken.state.generation, 1);

  const resumed = apply(connectingState(TERMINAL_MODE.RESUME), backend("ATTACHED", 1));
  assert.equal(resumed.state.node, TERMINAL_NODE.LIVE);
  assert.deepEqual(resumed.effects, []);
});

test("the first answer can find the terminal elsewhere, missing, or unstartable", () => {
  const cases = [
    ["ELSEWHERE", TERMINAL_NODE.ELSEWHERE, ""],
    ["ABSENT", TERMINAL_NODE.EMPTY, ""],
    ["START_FAILED", TERMINAL_NODE.EMPTY, "no such directory"],
  ];
  for (const [event, node, error] of cases) {
    const result = apply(
      connectingState(TERMINAL_MODE.TAKE),
      { ...backend(event, 1), message: "no such directory" },
    );
    assert.equal(result.state.node, node, event);
    assert.equal(result.state.error, error, event);
    assert.deepEqual(result.effects, [DISCONNECT], event);
    assert.equal(result.state.generation, 2, event);
  }
});

test("a live terminal that ends leaves the screen; one taken stays to offer it back", () => {
  const ended = apply(liveState(), backend("ENDED", 1));
  assert.equal(ended.state.node, TERMINAL_NODE.EMPTY);
  assert.deepEqual(ended.effects, [DISCONNECT, RELEASE_FOCUS, LEAVE]);

  const taken = apply(liveState(), backend("TAKEN", 1));
  assert.equal(taken.state.node, TERMINAL_NODE.ELSEWHERE);
  assert.deepEqual(taken.effects, [DISCONNECT, RELEASE_FOCUS]);
});

test("a failed socket while connecting or live is disconnected", () => {
  for (const state of [connectingState(TERMINAL_MODE.RESUME), liveState()]) {
    const result = apply(state, backend("SOCKET_FAILED", 1));
    assert.equal(result.state.node, TERMINAL_NODE.DISCONNECTED);
    assert.deepEqual(result.effects, [DISCONNECT]);
  }
});

test("asking here takes the terminal from another screen or opens a missing one", () => {
  for (const node of [TERMINAL_NODE.ELSEWHERE, TERMINAL_NODE.EMPTY]) {
    const result = apply(stateAt(node), activate(TERMINAL_MODE.TAKE));
    assert.equal(result.state.node, TERMINAL_NODE.CONNECTING, node);
    assert.equal(result.state.mode, TERMINAL_MODE.TAKE, node);
    assert.deepEqual(result.effects, [CONNECT], node);
  }
});

test("a hidden screen suspends from every node that holds or awaits a socket", () => {
  for (const node of [
    TERMINAL_NODE.CONNECTING,
    TERMINAL_NODE.LIVE,
    TERMINAL_NODE.ELSEWHERE,
    TERMINAL_NODE.EMPTY,
    TERMINAL_NODE.DISCONNECTED,
  ]) {
    const result = apply(stateAt(node), { type: TERMINAL_EVENT.HIDDEN });
    assert.equal(result.state.node, TERMINAL_NODE.SUSPENDED, node);
    assert.deepEqual(result.effects, [DISCONNECT], node);
  }
});

test("coming back resumes a suspended screen and recovers a lost connection", () => {
  const visible = apply(stateAt(TERMINAL_NODE.SUSPENDED), {
    type: TERMINAL_EVENT.VISIBLE,
  });
  assert.equal(visible.state.node, TERMINAL_NODE.CONNECTING);
  assert.equal(visible.state.mode, TERMINAL_MODE.RESUME);
  assert.deepEqual(visible.effects, [CONNECT]);

  const recovered = apply(stateAt(TERMINAL_NODE.DISCONNECTED), {
    type: TERMINAL_EVENT.RECOVER,
  });
  assert.equal(recovered.state.node, TERMINAL_NODE.CONNECTING);
  assert.equal(recovered.state.mode, TERMINAL_MODE.RESUME);
  assert.deepEqual(recovered.effects, [CONNECT]);
});

test("deactivation leaves every active node", () => {
  for (const node of Object.values(TERMINAL_NODE)) {
    const result = terminalTransition(stateAt(node), {
      type: TERMINAL_EVENT.DEACTIVATE,
    });
    if (node === TERMINAL_NODE.INACTIVE) {
      assert.equal(result, null);
      continue;
    }
    assert.equal(result.state.node, TERMINAL_NODE.INACTIVE, node);
    assert.deepEqual(result.effects, [DISCONNECT], node);
  }
});

test("an answer to an earlier connection is refused", () => {
  const state = { ...connectingState(TERMINAL_MODE.TAKE), generation: 3 };
  for (const event of [
    "ATTACHED",
    "ELSEWHERE",
    "ABSENT",
    "START_FAILED",
    "SOCKET_FAILED",
  ]) {
    assert.equal(terminalTransition(state, backend(event, 2)), null, event);
  }
  assert.equal(
    terminalTransition({ ...liveState(), generation: 3 }, backend("ENDED", 2)),
    null,
  );
});

test("nodes refuse events they do not own", () => {
  const refused = [
    [TERMINAL_NODE.INACTIVE, backend("ATTACHED", 0)],
    [TERMINAL_NODE.INACTIVE, { type: TERMINAL_EVENT.HIDDEN }],
    [TERMINAL_NODE.INACTIVE, { type: TERMINAL_EVENT.RECOVER }],
    [TERMINAL_NODE.SUSPENDED, backend("ENDED", 1)],
    [TERMINAL_NODE.SUSPENDED, activate(TERMINAL_MODE.TAKE)],
    [TERMINAL_NODE.CONNECTING, activate(TERMINAL_MODE.TAKE)],
    [TERMINAL_NODE.CONNECTING, backend("ENDED", 1)],
    [TERMINAL_NODE.LIVE, activate(TERMINAL_MODE.TAKE)],
    [TERMINAL_NODE.LIVE, backend("ATTACHED", 1)],
    [TERMINAL_NODE.LIVE, backend("ABSENT", 1)],
    [TERMINAL_NODE.ELSEWHERE, activate(TERMINAL_MODE.RESUME)],
    [TERMINAL_NODE.EMPTY, { type: TERMINAL_EVENT.RECOVER }],
    [TERMINAL_NODE.DISCONNECTED, activate(TERMINAL_MODE.TAKE)],
    [TERMINAL_NODE.DISCONNECTED, { type: TERMINAL_EVENT.VISIBLE }],
    [TERMINAL_NODE.DISCONNECTED, backend("SOCKET_FAILED", 1)],
  ];
  for (const [node, event] of refused) {
    assert.equal(
      terminalTransition(stateAt(node), event),
      null,
      `${node} refuses ${event.type}`,
    );
  }
});

function apply(state, event) {
  const result = terminalTransition(state, event);
  assert.ok(result, `${state.node} accepts ${event.type}`);
  return result;
}

function activate(mode) {
  return { type: TERMINAL_EVENT.ACTIVATE, mode };
}

function backend(name, generation) {
  return { type: TERMINAL_EVENT[name], generation };
}

function connectingState(mode) {
  return { node: TERMINAL_NODE.CONNECTING, mode, generation: 1, error: "" };
}

function liveState() {
  return { node: TERMINAL_NODE.LIVE, mode: null, generation: 1, error: "" };
}

function stateAt(node) {
  return node === TERMINAL_NODE.CONNECTING
    ? connectingState(TERMINAL_MODE.RESUME)
    : { node, mode: null, generation: 1, error: "" };
}
