import assert from "node:assert/strict";
import test from "node:test";

import {
  PWA_UPDATE_HANDOFF_EFFECT,
  PWA_UPDATE_HANDOFF_EVENT,
  PWA_UPDATE_HANDOFF_NODE,
  PWA_UPDATE_HANDOFF_TRANSITIONS,
  PWA_UPDATE_TARGET_PHASE,
  createPwaUpdateHandoffState,
  transitionPwaUpdateHandoff,
} from "./machine.js";

function transition(state, type, values = {}) {
  return transitionPwaUpdateHandoff(state, { type, ...values });
}

function connectedState() {
  return transition(
    createPwaUpdateHandoffState(),
    PWA_UPDATE_HANDOFF_EVENT.CONNECTED,
  ).state;
}

function requestedState({
  buildId = "build-b",
  generation = 1,
  phase = PWA_UPDATE_TARGET_PHASE.WAITING,
} = {}) {
  return transition(
    connectedState(),
    PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED,
    { buildId, generation, phase },
  );
}

test("defines the exact handoff nodes and complete allowed-edge graph", () => {
  const nodes = [
    "detached",
    "idle",
    "activating",
    "claiming",
    "applying",
  ];
  assert.deepEqual(Object.values(PWA_UPDATE_HANDOFF_NODE), nodes);
  assert.deepEqual(Object.keys(PWA_UPDATE_HANDOFF_TRANSITIONS), nodes);
  assert.deepEqual(PWA_UPDATE_HANDOFF_TRANSITIONS, {
    detached: [
      "detached",
      "idle",
      "activating",
      "claiming",
      "applying",
    ],
    idle: [
      "idle",
      "detached",
      "activating",
      "claiming",
      "applying",
    ],
    activating: [
      "activating",
      "detached",
      "idle",
      "claiming",
      "applying",
    ],
    claiming: [
      "claiming",
      "detached",
      "idle",
      "activating",
      "applying",
    ],
    applying: ["applying", "detached", "idle", "activating", "claiming"],
  });
});

test("reaches every declared allowed edge through the transition authority", () => {
  for (const [from, destinations] of Object.entries(
    PWA_UPDATE_HANDOFF_TRANSITIONS,
  )) {
    for (const to of destinations) {
      const state = stateForEdge(from, to);
      const event = eventForEdge(from, to);
      const next = transitionPwaUpdateHandoff(state, event).state;
      assert.equal(next.node, to, `${from} -> ${to}`);
    }
  }
});

test("moves waiting through activation and claim into retryable application", () => {
  let result = requestedState();
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.ACTIVATING);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.ACTIVATE_TARGET,
    buildId: "build-b",
  }]);

  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED,
    { buildId: "build-b", phase: PWA_UPDATE_TARGET_PHASE.TRANSITIONING },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.ACTIVATING);
  assert.deepEqual(result.effects, []);

  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED,
    { buildId: "build-b", phase: PWA_UPDATE_TARGET_PHASE.ACTIVE },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.CLAIMING);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET,
    buildId: "build-b",
  }]);

  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
    { buildId: "build-b" },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.APPLYING);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.RELOAD,
    buildId: "build-b",
  }]);

  const duplicateController = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
    { buildId: "build-b" },
  );
  assert.deepEqual(duplicateController.effects, []);
});

test("retains the handoff target while it is temporarily unowned", () => {
  let result = requestedState();
  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED,
    { buildId: "build-b", phase: PWA_UPDATE_TARGET_PHASE.MISSING },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.ACTIVATING);
  assert.equal(result.state.targetBuildId, "build-b");
  assert.equal(result.state.targetGeneration, 1);
  assert.deepEqual(result.effects, []);

  const repeated = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED,
    {
      buildId: "build-b",
      generation: 1,
      phase: PWA_UPDATE_TARGET_PHASE.TRANSITIONING,
    },
  );
  assert.equal(repeated.state.node, PWA_UPDATE_HANDOFF_NODE.ACTIVATING);
  assert.equal(repeated.state.targetBuildId, "build-b");
  assert.deepEqual(repeated.effects, []);
});

test("repeated update requests and resume safely retry the current effect", () => {
  let result = requestedState({ phase: PWA_UPDATE_TARGET_PHASE.ACTIVE });
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.CLAIMING);
  assert.deepEqual(result.effects.map(({ type }) => type), [
    PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET,
  ]);

  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED,
    {
      buildId: "build-b",
      generation: 1,
      phase: PWA_UPDATE_TARGET_PHASE.ACTIVE,
    },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.CLAIMING);
  assert.deepEqual(result.effects.map(({ type }) => type), [
    PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET,
  ]);

  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.RESUME_REQUESTED,
    { buildId: "build-b", phase: PWA_UPDATE_TARGET_PHASE.ACTIVE },
  );
  assert.deepEqual(result.effects.map(({ type }) => type), [
    PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET,
  ]);
});

test("keeps a controlled target explicitly retryable while the old document survives", () => {
  let result = requestedState({ phase: PWA_UPDATE_TARGET_PHASE.ACTIVE });
  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
    { buildId: "build-b" },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.APPLYING);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.RELOAD,
    buildId: "build-b",
  }]);

  const resumed = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.RESUME_REQUESTED,
    { buildId: "build-b", phase: PWA_UPDATE_TARGET_PHASE.CONTROLLED },
  );
  assert.equal(resumed.state.node, PWA_UPDATE_HANDOFF_NODE.APPLYING);
  assert.deepEqual(resumed.effects, []);

  const repeated = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED,
    {
      buildId: "build-b",
      generation: 1,
      phase: PWA_UPDATE_TARGET_PHASE.CONTROLLED,
    },
  );
  assert.equal(repeated.state.node, PWA_UPDATE_HANDOFF_NODE.APPLYING);
  assert.deepEqual(repeated.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.RELOAD,
    buildId: "build-b",
  }]);
});

test("retargets the pending handoff to the latest prepared generation", () => {
  let result = requestedState({ phase: PWA_UPDATE_TARGET_PHASE.ACTIVE });
  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.PREPARED_REPLACED,
    {
      buildId: "build-c",
      generation: 2,
      phase: PWA_UPDATE_TARGET_PHASE.WAITING,
    },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.ACTIVATING);
  assert.equal(result.state.targetBuildId, "build-c");
  assert.equal(result.state.targetGeneration, 2);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.ACTIVATE_TARGET,
    buildId: "build-c",
  }]);

  const oldController = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
    { buildId: "build-b" },
  );
  assert.strictEqual(oldController.state, result.state);
  assert.deepEqual(oldController.effects, []);

  const stalePrepared = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.PREPARED_REPLACED,
    {
      buildId: "build-b",
      generation: 1,
      phase: PWA_UPDATE_TARGET_PHASE.ACTIVE,
    },
  );
  assert.strictEqual(stalePrepared.state, result.state);
  assert.deepEqual(stalePrepared.effects, []);
});

test("disconnect preserves the handoff target for an in-page reconnect", () => {
  let result = requestedState({ phase: PWA_UPDATE_TARGET_PHASE.ACTIVE });
  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.DISCONNECTED,
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.DETACHED);
  assert.equal(result.state.targetBuildId, "build-b");

  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.CONNECTED,
    { phase: PWA_UPDATE_TARGET_PHASE.ACTIVE },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.CLAIMING);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET,
    buildId: "build-b",
  }]);
});

test("an in-page reconnect reloads when its target already controls it", () => {
  let result = requestedState({ phase: PWA_UPDATE_TARGET_PHASE.ACTIVE });
  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.DISCONNECTED,
  );
  result = transition(
    result.state,
    PWA_UPDATE_HANDOFF_EVENT.CONNECTED,
    { phase: PWA_UPDATE_TARGET_PHASE.CONTROLLED },
  );
  assert.equal(result.state.node, PWA_UPDATE_HANDOFF_NODE.APPLYING);
  assert.deepEqual(result.effects, [{
    type: PWA_UPDATE_HANDOFF_EFFECT.RELOAD,
    buildId: "build-b",
  }]);
});

test("clears the target only when its generation is explicitly discarded", () => {
  const requested = requestedState({
    phase: PWA_UPDATE_TARGET_PHASE.TRANSITIONING,
  }).state;
  const missing = transition(
    requested,
    PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED,
    { buildId: "build-b", phase: PWA_UPDATE_TARGET_PHASE.MISSING },
  );
  assert.equal(missing.state.targetBuildId, "build-b");

  const discarded = transition(
    missing.state,
    PWA_UPDATE_HANDOFF_EVENT.TARGET_DISCARDED,
    { buildId: "build-b" },
  );
  assert.equal(discarded.state.node, PWA_UPDATE_HANDOFF_NODE.IDLE);
  assert.equal(discarded.state.targetBuildId, null);
  assert.equal(discarded.state.targetGeneration, 0);
});

test("prepared observations do not select a handoff target", () => {
  const idle = connectedState();
  const prepared = transition(
    idle,
    PWA_UPDATE_HANDOFF_EVENT.PREPARED_REPLACED,
    {
      buildId: "build-b",
      generation: 1,
      phase: PWA_UPDATE_TARGET_PHASE.WAITING,
    },
  );
  assert.strictEqual(prepared.state, idle);
  assert.deepEqual(prepared.effects, []);
});

function stateForEdge(from, to) {
  if (from === PWA_UPDATE_HANDOFF_NODE.DETACHED) {
    if (to === PWA_UPDATE_HANDOFF_NODE.ACTIVATING) {
      return disconnect(requestedState().state);
    }
    if (to === PWA_UPDATE_HANDOFF_NODE.CLAIMING) {
      return disconnect(requestedState({
        phase: PWA_UPDATE_TARGET_PHASE.ACTIVE,
      }).state);
    }
    if (to === PWA_UPDATE_HANDOFF_NODE.APPLYING) {
      return disconnect(requestedState({
        phase: PWA_UPDATE_TARGET_PHASE.CONTROLLED,
      }).state);
    }
    return createPwaUpdateHandoffState();
  }
  if (from === PWA_UPDATE_HANDOFF_NODE.IDLE) {
    return connectedState();
  }
  if (from === PWA_UPDATE_HANDOFF_NODE.ACTIVATING) {
    return requestedState().state;
  }
  if (from === PWA_UPDATE_HANDOFF_NODE.CLAIMING) {
    return requestedState({ phase: PWA_UPDATE_TARGET_PHASE.ACTIVE }).state;
  }
  return requestedState({
    phase: PWA_UPDATE_TARGET_PHASE.CONTROLLED,
  }).state;
}

function eventForEdge(from, to) {
  if (to === PWA_UPDATE_HANDOFF_NODE.DETACHED) {
    return { type: PWA_UPDATE_HANDOFF_EVENT.DISCONNECTED };
  }
  if (from === PWA_UPDATE_HANDOFF_NODE.DETACHED) {
    const phase = {
      [PWA_UPDATE_HANDOFF_NODE.ACTIVATING]: PWA_UPDATE_TARGET_PHASE.WAITING,
      [PWA_UPDATE_HANDOFF_NODE.CLAIMING]: PWA_UPDATE_TARGET_PHASE.ACTIVE,
      [PWA_UPDATE_HANDOFF_NODE.APPLYING]:
        PWA_UPDATE_TARGET_PHASE.CONTROLLED,
    }[to];
    return {
      type: PWA_UPDATE_HANDOFF_EVENT.CONNECTED,
      ...(phase ? { phase } : {}),
    };
  }
  if (
    from === PWA_UPDATE_HANDOFF_NODE.APPLYING &&
    to === PWA_UPDATE_HANDOFF_NODE.APPLYING
  ) {
    return {
      type: PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
      buildId: "build-b",
    };
  }
  const phase = {
    [PWA_UPDATE_HANDOFF_NODE.IDLE]: PWA_UPDATE_TARGET_PHASE.REDUNDANT,
    [PWA_UPDATE_HANDOFF_NODE.ACTIVATING]: PWA_UPDATE_TARGET_PHASE.WAITING,
    [PWA_UPDATE_HANDOFF_NODE.CLAIMING]: PWA_UPDATE_TARGET_PHASE.ACTIVE,
    [PWA_UPDATE_HANDOFF_NODE.APPLYING]:
      PWA_UPDATE_TARGET_PHASE.CONTROLLED,
  }[to];
  return {
    type: PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED,
    buildId: "build-b",
    generation: 1,
    phase,
  };
}

function disconnect(state) {
  return transition(
    state,
    PWA_UPDATE_HANDOFF_EVENT.DISCONNECTED,
  ).state;
}
