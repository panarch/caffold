import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREGROUND_RECOVERY_PRESENTATION,
} from "../foreground-recovery.js";
import {
  ForegroundRecoveryRuntime,
  NOTIFICATION_ACTIVATION_MESSAGE,
} from "./lifecycle.js";
import {
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRIGGER,
  selectForegroundRecoveryPresentation,
} from "./machine.js";

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

function selectPresentation(state) {
  return selectForegroundRecoveryPresentation(
    state,
    FOREGROUND_RECOVERY_PRESENTATION,
  );
}

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

test("fresh origin reachability recovers without a browser online edge", async () => {
  const browser = harness({ online: false });
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
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.OFFLINE);

  const recovery = lifecycle.reportOriginReachable();
  const duplicate = lifecycle.reportOriginReachable();
  await Promise.resolve();

  assert.equal(recoveries.length, 1);
  assert.equal(await duplicate, null);
  assert.equal(
    recoveries[0].trigger,
    FOREGROUND_RECOVERY_TRIGGER.ORIGIN_REACHABLE,
  );
  assert.equal(lifecycle.snapshot().lastTrigger, "origin");
  assert.equal(
    lifecycle.snapshot().node.type,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  );
  gate.resolve();
  await recovery;
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.READY);
  await lifecycle.reportOriginReachable();
  assert.equal(recoveries.length, 1);
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

test("uses default delays, bounds server retries, and exposes reconnecting", async () => {
  const browser = harness();
  const retryTimers = [];
  browser.windowTarget.setTimeout = (callback, delayMs) => {
    retryTimers.push({ callback, delayMs });
    return retryTimers.length;
  };
  const snapshots = [];
  let attempts = 0;
  const lifecycle = new ForegroundRecoveryRuntime({
    ...browser,
    onRecover: async () => {
      attempts += 1;
      return { retry: true, error: new Error("HTTP 502") };
    },
    onStateChange: (snapshot) => snapshots.push(snapshot),
  });
  lifecycle.connect();

  await lifecycle.requestForegroundRecovery({
    trigger: FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  });
  const expectedRetryDelays = [250, 1_000, 3_000];
  for (const [index, expectedDelay] of expectedRetryDelays.entries()) {
    assert.equal(retryTimers.length, index + 1);
    assert.equal(retryTimers[index].delayMs, expectedDelay);
    retryTimers[index].callback();
    await settle();
  }

  assert.deepEqual(
    retryTimers.map(({ delayMs }) => delayMs),
    expectedRetryDelays,
  );
  assert.equal(attempts, 4);
  assert.equal(lifecycle.snapshot().node.type, FOREGROUND_RECOVERY_NODE.EXHAUSTED);
  assert.equal(lifecycle.snapshot().node.attempt, 3);
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
