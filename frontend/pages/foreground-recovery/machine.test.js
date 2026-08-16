import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREGROUND_RECOVERY_PRESENTATION,
} from "../foreground-recovery.js";
import {
  FOREGROUND_RECOVERY_EVENT,
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRANSITIONS,
  FOREGROUND_RECOVERY_TRIGGER,
  createForegroundRecoveryState,
  selectForegroundRecoveryPresentation,
  transitionForegroundRecovery,
} from "./machine.js";

const VISIBLE = Object.freeze({
  focused: true,
  visibility: "visible",
  network: Object.freeze({
    onlineHint: true,
    connectionType: "wifi",
    effectiveType: "4g",
  }),
});
function connectedState() {
  return transitionForegroundRecovery(
    createForegroundRecoveryState({ observation: VISIBLE }),
    { type: FOREGROUND_RECOVERY_EVENT.CONNECTED, observation: VISIBLE },
  );
}

function startedState(attempt = 0) {
  return transitionForegroundRecovery(connectedState(), {
    type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_STARTED,
    attempt,
    request: {
      activationRoute: "",
      intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
      trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
    },
  });
}

function enterStage(state, nodeType) {
  return transitionForegroundRecovery(state, {
    type: FOREGROUND_RECOVERY_EVENT.STAGE_ENTERED,
    generation: state.generation,
    nodeType,
  });
}

function selectPresentation(state) {
  return selectForegroundRecoveryPresentation(
    state,
    FOREGROUND_RECOVERY_PRESENTATION,
  );
}

test("defines the exact eleven control nodes and their complete graph", () => {
  const nodes = [
    "detached",
    "suspended",
    "ready",
    "validating-status",
    "activating-route",
    "validating-list",
    "validating-detail",
    "validating-list-and-detail",
    "backing-off",
    "offline",
    "exhausted",
  ];
  assert.deepEqual(Object.values(FOREGROUND_RECOVERY_NODE), nodes);
  assert.deepEqual(Object.keys(FOREGROUND_RECOVERY_TRANSITIONS), nodes);
  assert.deepEqual(FOREGROUND_RECOVERY_TRANSITIONS, {
    detached: ["detached", "suspended", "ready", "offline"],
    suspended: ["suspended", "detached", "offline", "validating-status"],
    ready: ["ready", "detached", "suspended", "offline", "validating-status"],
    "validating-status": [
      "validating-status",
      "detached",
      "suspended",
      "offline",
      "ready",
      "activating-route",
      "validating-list",
      "validating-detail",
      "validating-list-and-detail",
      "backing-off",
      "exhausted",
    ],
    "activating-route": [
      "activating-route",
      "detached",
      "suspended",
      "offline",
      "ready",
      "validating-status",
      "validating-list",
      "validating-detail",
      "validating-list-and-detail",
      "backing-off",
      "exhausted",
    ],
    "validating-list": [
      "validating-list",
      "detached",
      "suspended",
      "offline",
      "ready",
      "backing-off",
      "exhausted",
    ],
    "validating-detail": [
      "validating-detail",
      "detached",
      "suspended",
      "offline",
      "ready",
      "backing-off",
      "exhausted",
    ],
    "validating-list-and-detail": [
      "validating-list-and-detail",
      "detached",
      "suspended",
      "offline",
      "ready",
      "validating-list",
      "validating-detail",
      "backing-off",
      "exhausted",
    ],
    "backing-off": [
      "backing-off",
      "detached",
      "suspended",
      "offline",
      "validating-status",
    ],
    offline: ["offline", "detached", "suspended", "validating-status"],
    exhausted: [
      "exhausted",
      "detached",
      "suspended",
      "offline",
      "validating-status",
    ],
  });
});

test("moves through every control node without inventing composite states", () => {
  const seen = new Set();
  let state = createForegroundRecoveryState({ observation: VISIBLE });
  seen.add(state.node.type);

  state = transitionForegroundRecovery(state, {
    type: FOREGROUND_RECOVERY_EVENT.CONNECTED,
    observation: { ...VISIBLE, visibility: "hidden" },
  });
  seen.add(state.node.type);
  state = transitionForegroundRecovery(state, {
    type: FOREGROUND_RECOVERY_EVENT.DISCONNECTED,
  });
  state = transitionForegroundRecovery(state, {
    type: FOREGROUND_RECOVERY_EVENT.CONNECTED,
    observation: VISIBLE,
  });
  seen.add(state.node.type);
  state = transitionForegroundRecovery(state, {
    type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_STARTED,
    attempt: 0,
    request: {
      intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
      trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
    },
  });
  seen.add(state.node.type);
  for (const nodeType of [
    FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
  ]) {
    state = enterStage(state, nodeType);
    seen.add(state.node.type);
  }

  const detail = enterStage(
    startedState(),
    FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
  );
  seen.add(detail.node.type);
  const backoff = transitionForegroundRecovery(detail, {
    type: FOREGROUND_RECOVERY_EVENT.BACKOFF_STARTED,
    attempt: 1,
    generation: detail.generation,
  });
  seen.add(backoff.node.type);
  const exhausted = transitionForegroundRecovery(detail, {
    type: FOREGROUND_RECOVERY_EVENT.RETRY_EXHAUSTED,
    attempt: 1,
    generation: detail.generation,
  });
  seen.add(exhausted.node.type);

  let offline = transitionForegroundRecovery(connectedState(), {
    type: FOREGROUND_RECOVERY_EVENT.OBSERVATION_UPDATED,
    observation: {
      ...VISIBLE,
      network: { ...VISIBLE.network, onlineHint: false },
    },
  });
  offline = transitionForegroundRecovery(offline, {
    type: FOREGROUND_RECOVERY_EVENT.WENT_OFFLINE,
  });
  seen.add(offline.node.type);

  assert.deepEqual(seen, new Set(Object.values(FOREGROUND_RECOVERY_NODE)));
});

test("rejects an impossible validation edge and stale generation", () => {
  const list = enterStage(
    startedState(),
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
  );
  assert.strictEqual(
    enterStage(list, FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL),
    list,
  );
  assert.strictEqual(
    transitionForegroundRecovery(list, {
      type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_SETTLED,
      generation: list.generation - 1,
    }),
    list,
  );
});

test("keeps no-op publications and stale terminal events referentially stable", () => {
  const state = startedState();
  const staleGeneration = state.generation - 1;

  assert.strictEqual(
    transitionForegroundRecovery(state, {
      type: FOREGROUND_RECOVERY_EVENT.TARGETS_UPDATED,
      targets: state.targets,
    }),
    state,
  );
  assert.strictEqual(
    transitionForegroundRecovery(state, {
      type: FOREGROUND_RECOVERY_EVENT.STAGE_ENTERED,
      generation: state.generation,
      nodeType: FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    }),
    state,
  );
  for (const type of [
    FOREGROUND_RECOVERY_EVENT.ATTEMPT_SUPERSEDED,
    FOREGROUND_RECOVERY_EVENT.BACKOFF_STARTED,
    FOREGROUND_RECOVERY_EVENT.RETRY_EXHAUSTED,
    "unknown-event",
  ]) {
    assert.strictEqual(
      transitionForegroundRecovery(state, {
        type,
        attempt: 1,
        generation: staleGeneration,
      }),
      state,
    );
  }
});

test("suspension invalidates work while preserving its activation route", () => {
  const active = transitionForegroundRecovery(connectedState(), {
    type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_STARTED,
    attempt: 0,
    request: {
      activationRoute: "/tasks/thread-resume",
      intent: FOREGROUND_RECOVERY_INTENT.INITIAL_ACTIVATION,
      trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
    },
  });
  const suspended = transitionForegroundRecovery(active, {
    type: FOREGROUND_RECOVERY_EVENT.SUSPENDED,
  });

  assert.equal(suspended.node.type, FOREGROUND_RECOVERY_NODE.SUSPENDED);
  assert.ok(suspended.generation > active.generation);
  assert.equal(suspended.activeRequest, null);
  assert.deepEqual(suspended.pendingRequest, {
    activationRoute: "/tasks/thread-resume",
    intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });
});

test("keeps retry attempt as data on the seven retry-bearing nodes", () => {
  const retryBearingNodes = [
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
    FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
    FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
  ];
  const configurations = new Set();
  for (const attempt of [0, 1, 2, 3]) {
    for (const nodeType of retryBearingNodes) {
      configurations.add(`${nodeType}:${attempt}`);
    }
  }
  assert.equal(configurations.size, 28);
});

test("keeps diagnostic triggers outside the control graph", () => {
  assert.deepEqual(Object.values(FOREGROUND_RECOVERY_TRIGGER), [
    "bootstrap",
    "discarded",
    "reconnect",
    "visibility",
    "pageshow",
    "resume",
    "focus",
    "online",
    "connection",
    "origin",
    "notification",
    "manual-retry",
  ]);

  const fromFocus = startedState();
  const fromPageShow = transitionForegroundRecovery(connectedState(), {
    type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_STARTED,
    attempt: 0,
    request: {
      intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
      trigger: FOREGROUND_RECOVERY_TRIGGER.BFCACHE_RESTORED,
    },
  });

  assert.deepEqual(fromFocus.node, fromPageShow.node);
  assert.equal(
    selectPresentation(fromFocus),
    selectPresentation(fromPageShow),
  );
  assert.equal(
    fromPageShow.lastTrigger,
    FOREGROUND_RECOVERY_TRIGGER.BFCACHE_RESTORED,
  );
});

test("derives UI presentation without adding UI nodes to the graph", () => {
  const withTarget = (state, transport) => transitionForegroundRecovery(
    state,
    {
      type: FOREGROUND_RECOVERY_EVENT.TARGETS_UPDATED,
      targets: {
        list: { active: true, content: "present", transport },
      },
    },
  );

  assert.equal(
    selectPresentation(startedState()),
    FOREGROUND_RECOVERY_PRESENTATION.NONE,
  );
  assert.equal(
    selectPresentation(startedState(1)),
    FOREGROUND_RECOVERY_PRESENTATION.RECONNECTING,
  );
  assert.equal(
    selectPresentation(withTarget(connectedState(), "validating")),
    FOREGROUND_RECOVERY_PRESENTATION.NONE,
  );
  assert.equal(
    selectPresentation(withTarget(connectedState(), "reconnecting")),
    FOREGROUND_RECOVERY_PRESENTATION.RECONNECTING,
  );
  assert.equal(
    selectPresentation(withTarget(connectedState(), "unavailable")),
    FOREGROUND_RECOVERY_PRESENTATION.UNAVAILABLE,
  );
  assert.equal(
    selectPresentation(withTarget(startedState(1), "unavailable")),
    FOREGROUND_RECOVERY_PRESENTATION.RECONNECTING,
  );

  const offline = transitionForegroundRecovery(
    withTarget(connectedState(), "unavailable"),
    { type: FOREGROUND_RECOVERY_EVENT.WENT_OFFLINE },
  );
  assert.equal(
    selectPresentation(offline),
    FOREGROUND_RECOVERY_PRESENTATION.OFFLINE,
  );
});
