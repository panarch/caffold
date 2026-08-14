import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREGROUND_RECOVERY_PRESENTATION,
  ForegroundRecoveryLifecycle as PublicForegroundRecoveryLifecycle,
} from "../frontend/pages/foreground-recovery.js";
import {
  ForegroundRecoveryRuntime,
  NOTIFICATION_ACTIVATION_MESSAGE,
} from "../frontend/pages/foreground-recovery/lifecycle.js";
import {
  FOREGROUND_RECOVERY_EVENT,
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRANSITIONS,
  FOREGROUND_RECOVERY_TRIGGER,
  createForegroundRecoveryState,
  selectForegroundRecoveryPresentation,
  transitionForegroundRecovery,
} from "../frontend/pages/foreground-recovery/machine.js";

const VISIBLE = Object.freeze({
  focused: true,
  visibility: "visible",
  network: Object.freeze({
    onlineHint: true,
    connectionType: "wifi",
    effectiveType: "4g",
  }),
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
      );
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

function harness({
  connectionType = "wifi",
  effectiveType = "4g",
  focused = true,
  online = true,
  visibilityState = "visible",
} = {}) {
  const documentTarget = Object.assign(eventTarget(), {
    visibilityState,
    hasFocus: () => focused,
  });
  const connectionTarget = Object.assign(eventTarget(), {
    type: connectionType,
    effectiveType,
  });
  const navigatorTarget = { connection: connectionTarget, onLine: online };
  const windowTarget = Object.assign(eventTarget(), {
    clearTimeout,
    setTimeout,
  });
  const serviceWorkerTarget = eventTarget();
  return {
    connectionTarget,
    documentTarget,
    navigatorTarget,
    serviceWorkerTarget,
    windowTarget,
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

test("public facade exposes semantic recovery progress without graph internals", async () => {
  const browser = harness();
  const requests = [];
  const snapshots = [];
  const lifecycle = new PublicForegroundRecoveryLifecycle({
    ...browser,
    onRecover: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        request.progress.validatingStatus();
        request.progress.activatingRoute();
        assert.equal(request.progress.validatingTransports(), false);
        request.progress.validatingTransports({ detail: true, list: true });
      } else if (requests.length === 2) {
        request.progress.validatingTransports({ list: true });
      } else {
        request.progress.validatingTransports({ detail: true });
      }
      return { retry: false };
    },
    onStateChange: (snapshot) => snapshots.push(snapshot),
  });

  lifecycle.connect();
  lifecycle.setTargets({
    list: { active: true, content: "present", transport: "ready" },
  });
  await lifecycle.requestInitialActivation({ discarded: true });

  assert.deepEqual(Object.keys(requests[0]), [
    "activationRoute",
    "initialActivation",
    "isCurrent",
    "progress",
  ]);
  assert.equal(requests[0].initialActivation, true);
  assert.deepEqual(Object.keys(requests[0].progress), [
    "activatingRoute",
    "validatingStatus",
    "validatingTransports",
  ]);
  assert.deepEqual(Object.keys(lifecycle.snapshot()), [
    "generation",
    "lastTrigger",
    "presentation",
  ]);
  assert.equal(lifecycle.snapshot().lastTrigger, "discarded");
  assert.equal(
    lifecycle.snapshot().presentation,
    FOREGROUND_RECOVERY_PRESENTATION.NONE,
  );
  assert.equal(snapshots.some((snapshot) => "node" in snapshot), false);

  await lifecycle.requestManualRetry();
  assert.equal(requests[1].initialActivation, false);
  assert.equal(lifecycle.snapshot().lastTrigger, "manual-retry");
  await lifecycle.requestForegroundRecovery();
  assert.equal(requests[2].initialActivation, false);
  assert.equal(lifecycle.snapshot().lastTrigger, "reconnect");
  lifecycle.disconnect();
});

test("retains a hidden notification route and recovers only when visible", async () => {
  const browser = harness({ visibilityState: "hidden" });
  const recoveries = [];
  let suspensions = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async (request) => recoveries.push(request),
    onSuspend: () => {
      suspensions += 1;
    },
  });
  lifecycle.connect();
  lifecycle.connect();
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.SUSPENDED);
  assert.equal(suspensions, 1);

  browser.serviceWorkerTarget.dispatch("message", {
    data: {
      type: NOTIFICATION_ACTIVATION_MESSAGE,
      route: "/tasks/thread-hidden",
    },
  });
  await settle();
  assert.equal(recoveries.length, 0);

  browser.documentTarget.visibilityState = "visible";
  browser.documentTarget.dispatch("visibilitychange");
  await settle();

  assert.equal(recoveries.length, 1);
  assert.equal(
    recoveries[0].trigger,
    FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  );
  assert.equal(
    recoveries[0].intent,
    FOREGROUND_RECOVERY_INTENT.RECONCILE,
  );
  assert.equal(recoveries[0].activationRoute, "/tasks/thread-hidden");
  assert.equal("activationRoute" in lifecycle.snapshot(), false);
  lifecycle.disconnect();
});

test("a direct request observed while hidden is queued before any work starts", async () => {
  const browser = harness();
  const recoveries = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async ({ activationRoute }) => {
      recoveries.push(activationRoute);
    },
  });
  lifecycle.connect();

  browser.documentTarget.visibilityState = "hidden";
  await lifecycle.requestForegroundRecovery({
    activationRoute: "/tasks/direct-hidden",
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });
  assert.equal(recoveries.length, 0);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.SUSPENDED);

  browser.documentTarget.visibilityState = "visible";
  browser.documentTarget.dispatch("visibilitychange");
  await settle();
  assert.deepEqual(recoveries, ["/tasks/direct-hidden"]);
  lifecycle.disconnect();
});

test("publishes targets once and pauses repeated hidden signals idempotently", () => {
  const browser = harness();
  const snapshots = [];
  let suspensions = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onStateChange: (snapshot) => snapshots.push(snapshot),
    onSuspend: () => {
      suspensions += 1;
    },
  });
  lifecycle.connect();

  const targets = {
    list: { active: true, content: "present", transport: "ready" },
  };
  lifecycle.setTargets(targets);
  lifecycle.setTargets(targets);
  assert.equal(snapshots.length, 2);

  browser.documentTarget.visibilityState = "hidden";
  browser.windowTarget.dispatch("blur");
  browser.windowTarget.dispatch("blur");
  browser.navigatorTarget.onLine = false;
  browser.windowTarget.dispatch("offline");
  browser.windowTarget.dispatch("offline");

  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.SUSPENDED);
  assert.equal(suspensions, 1);
  lifecycle.disconnect();
});

test("coalesces overlapping hints into one in-flight generation", async () => {
  const browser = harness();
  const gate = deferred();
  const recoveries = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async (request) => {
      recoveries.push(request);
      await gate.promise;
      return { retry: false };
    },
  });
  lifecycle.connect();

  const first = lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  const second = lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.BFCACHE_RESTORED,
  });
  browser.windowTarget.dispatch("online");
  await Promise.resolve();

  assert.strictEqual(first, second);
  assert.equal(recoveries.length, 1);
  assert.equal(
    recoveries[0].trigger,
    FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  );
  gate.resolve();
  await first;
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.READY);
  lifecycle.disconnect();
});

test("reruns a coalesced hint instead of accepting a stale network failure", async () => {
  const browser = harness();
  const gate = deferred();
  const recoveries = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async ({ trigger }) => {
      recoveries.push(trigger);
      if (recoveries.length === 1) {
        await gate.promise;
        return { retry: true, error: new TypeError("Failed to fetch") };
      }
      return { retry: false };
    },
  });
  lifecycle.connect();

  const first = lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.NETWORK_ONLINE,
  });
  gate.resolve();
  await first;
  await settle();

  assert.deepEqual(recoveries, [
    FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
    FOREGROUND_RECOVERY_TRIGGER.NETWORK_ONLINE,
  ]);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.READY);
  lifecycle.disconnect();
});

test("queues a different notification route behind an in-flight recovery", async () => {
  const browser = harness();
  const firstGate = deferred();
  const recoveries = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async (request) => {
      recoveries.push(request.activationRoute);
      if (recoveries.length === 1) {
        await firstGate.promise;
      }
      return { retry: false };
    },
  });
  lifecycle.connect();

  const first = lifecycle.requestForegroundRecovery({
    activationRoute: "/tasks/thread-a",
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });
  await Promise.resolve();
  browser.serviceWorkerTarget.dispatch("message", {
    data: {
      type: NOTIFICATION_ACTIVATION_MESSAGE,
      route: "/tasks/thread-b",
    },
  });
  firstGate.resolve();
  await first;
  await settle();

  assert.deepEqual(recoveries, ["/tasks/thread-a", "/tasks/thread-b"]);
  lifecycle.disconnect();
});

test("carries a newer notification route into a bounded retry", async () => {
  const browser = harness();
  const firstGate = deferred();
  const recoveries = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async ({ activationRoute, attempt }) => {
      recoveries.push({ activationRoute, attempt });
      if (attempt === 0) {
        await firstGate.promise;
        return { retry: true, error: new Error("HTTP 502") };
      }
      return { retry: false };
    },
    retryDelaysMs: [0],
  });
  lifecycle.connect();

  const first = lifecycle.requestForegroundRecovery({
    activationRoute: "/tasks/thread-a",
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });
  await Promise.resolve();
  lifecycle.requestForegroundRecovery({
    activationRoute: "/tasks/thread-b",
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });
  firstGate.resolve();
  await first;
  for (let spin = 0; spin < 20 && recoveries.length < 2; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.deepEqual(recoveries, [
    { activationRoute: "/tasks/thread-a", attempt: 0 },
    { activationRoute: "/tasks/thread-b", attempt: 1 },
  ]);
  lifecycle.disconnect();
});

test("uses a real blur-to-focus transition and ignores repeated focus", async () => {
  const browser = harness();
  let recoveries = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      recoveries += 1;
    },
  });
  lifecycle.connect();

  browser.windowTarget.dispatch("focus");
  await settle();
  assert.equal(recoveries, 0);
  browser.windowTarget.dispatch("blur");
  browser.windowTarget.dispatch("focus");
  await settle();
  assert.equal(recoveries, 1);
  lifecycle.disconnect();
});

test("ignores connection metric noise but recovers on a type edge", async () => {
  const browser = harness();
  let recoveries = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      recoveries += 1;
    },
  });
  lifecycle.connect();

  browser.connectionTarget.effectiveType = "3g";
  browser.connectionTarget.dispatch("change");
  await settle();
  assert.equal(recoveries, 0);

  browser.connectionTarget.type = "cellular";
  browser.connectionTarget.dispatch("change");
  await settle();
  assert.equal(recoveries, 1);
  lifecycle.disconnect();
});

test("offline invalidates active work and online starts one fresh generation", async () => {
  const browser = harness();
  const gate = deferred();
  const generations = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async (request) => {
      generations.push(request.generation);
      if (generations.length === 1) {
        await gate.promise;
      }
      return { retry: false };
    },
  });
  lifecycle.connect();

  const first = lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  await Promise.resolve();
  browser.navigatorTarget.onLine = false;
  browser.windowTarget.dispatch("offline");
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.OFFLINE);
  gate.resolve();
  await first;

  browser.navigatorTarget.onLine = true;
  browser.windowTarget.dispatch("online");
  await settle();
  assert.equal(generations.length, 2);
  assert.ok(generations[1] > generations[0]);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.READY);
  lifecycle.disconnect();
});

test("a network exception pauses without consuming server retry budget", async () => {
  const browser = harness();
  let attempts = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      attempts += 1;
      throw new TypeError("Failed to fetch");
    },
    retryDelaysMs: [0, 0, 0],
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  assert.equal(attempts, 1);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.OFFLINE);
  lifecycle.disconnect();
});

test("a thrown server failure uses the same bounded retry path", async () => {
  const browser = harness();
  let attempts = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("HTTP 502");
      }
      return { retry: false };
    },
    retryDelaysMs: [0],
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery();
  for (let spin = 0; spin < 20 && attempts < 2; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(attempts, 2);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.READY);
  lifecycle.disconnect();
});

test("bounds server retries and exposes reconnecting only after attempt zero", async () => {
  const browser = harness();
  const snapshots = [];
  let attempts = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      attempts += 1;
      return { retry: true, error: new Error("HTTP 502") };
    },
    onStateChange: (snapshot) => snapshots.push(snapshot),
    retryDelaysMs: [0, 0],
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  for (let spin = 0; spin < 20 && attempts < 3; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(attempts, 3);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.EXHAUSTED);
  assert.equal(lifecycle.snapshot().node.attempt, 2);
  const firstValidation = snapshots.find(
    (snapshot) => snapshot.node.type === FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  );
  assert.equal(
    selectPresentation(firstValidation),
    FOREGROUND_RECOVERY_PRESENTATION.NONE,
  );
  assert.ok(
    snapshots.some(
      (snapshot) =>
        selectPresentation(snapshot) ===
          FOREGROUND_RECOVERY_PRESENTATION.RECONNECTING,
    ),
  );
  lifecycle.disconnect();
});

test("hiding during backoff cancels retry work until visibility returns", async () => {
  const browser = harness();
  let retryCallback = null;
  let clearedTimer = null;
  browser.windowTarget.setTimeout = (callback) => {
    retryCallback = callback;
    return 41;
  };
  browser.windowTarget.clearTimeout = (timer) => {
    clearedTimer = timer;
  };
  let attempts = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      attempts += 1;
      return attempts === 1
        ? { retry: true, error: new Error("HTTP 502") }
        : { retry: false };
    },
    retryDelaysMs: [250],
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery();
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.BACKING_OFF);
  assert.equal(typeof retryCallback, "function");

  browser.documentTarget.visibilityState = "hidden";
  browser.documentTarget.dispatch("visibilitychange");
  assert.equal(clearedTimer, 41);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.SUSPENDED);

  retryCallback();
  await settle();
  assert.equal(attempts, 1);

  browser.documentTarget.visibilityState = "visible";
  browser.documentTarget.dispatch("visibilitychange");
  await settle();
  assert.equal(attempts, 2);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.READY);

  lifecycle.disconnect();
  lifecycle.disconnect();
  assert.equal(await lifecycle.requestForegroundRecovery(), null);
});

test("separates initial activation intent from retry reconciliation", async () => {
  const browser = harness();
  const recoveries = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async ({ attempt, intent, trigger }) => {
      recoveries.push({ attempt, intent, trigger });
      return attempt === 0
        ? { retry: true, error: new Error("HTTP 502") }
        : { retry: false };
    },
    retryDelaysMs: [0],
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery({
    intent: FOREGROUND_RECOVERY_INTENT.INITIAL_ACTIVATION,
    trigger: FOREGROUND_RECOVERY_TRIGGER.BOOTSTRAP,
  });
  for (let spin = 0; spin < 20 && recoveries.length < 2; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.deepEqual(recoveries, [
    {
      attempt: 0,
      intent: FOREGROUND_RECOVERY_INTENT.INITIAL_ACTIVATION,
      trigger: FOREGROUND_RECOVERY_TRIGGER.BOOTSTRAP,
    },
    {
      attempt: 1,
      intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
      trigger: FOREGROUND_RECOVERY_TRIGGER.BOOTSTRAP,
    },
  ]);
  assert.equal(
    lifecycle.snapshot().lastTrigger,
    FOREGROUND_RECOVERY_TRIGGER.BOOTSTRAP,
  );
  lifecycle.disconnect();
});

test("does not start a queued request while an offline attempt is settling", async () => {
  const browser = harness();
  const gate = deferred();
  let attempts = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      attempts += 1;
      await gate.promise;
      throw new TypeError("Failed to fetch");
    },
  });
  lifecycle.connect();

  const first = lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  await Promise.resolve();
  lifecycle.requestForegroundRecovery({
    activationRoute: "/tasks/queued",
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });
  gate.resolve();
  await first;
  await settle();

  assert.equal(attempts, 1);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.OFFLINE);
  lifecycle.disconnect();
});

test("publishes graph snapshots without exposing activation routes", async () => {
  const browser = harness();
  const snapshots = [];
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async ({ reportStage }) => {
      reportStage(FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE);
      reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS);
      reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL);
      return { retry: false };
    },
    onStateChange: (snapshot) => snapshots.push(snapshot),
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery({
    activationRoute: "/tasks/thread-private-route",
    trigger: FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
  });

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.node.type),
    [
      "ready",
      "validating-status",
      "activating-route",
      "validating-status",
      "validating-list-and-detail",
      "ready",
    ],
  );
  assert.equal(
    snapshots.every((snapshot) => !("activationRoute" in snapshot)),
    true,
  );
  lifecycle.disconnect();
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.DETACHED);
});
