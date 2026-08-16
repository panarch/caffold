import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREGROUND_RECOVERY_PRESENTATION,
  ForegroundRecoveryLifecycle,
} from "./foreground-recovery.js";

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

test("public facade exposes semantic recovery progress without graph internals", async () => {
  const browser = harness();
  const requests = [];
  const snapshots = [];
  const lifecycle = new ForegroundRecoveryLifecycle({
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
  assert.equal(await lifecycle.reportOriginReachable(), null);
  assert.equal(requests.length, 3);
  lifecycle.disconnect();
});
