import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREGROUND_RECOVERY_BROWSER_SIGNAL,
  ForegroundRecoveryBrowserSignals,
} from "./browser-signals.js";

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

function harness() {
  const documentTarget = Object.assign(eventTarget(), {
    visibilityState: "visible",
    hasFocus: () => true,
  });
  const connectionTarget = Object.assign(eventTarget(), {
    type: "wifi",
    effectiveType: "4g",
  });
  const navigatorTarget = {
    connection: connectionTarget,
    onLine: true,
  };
  return {
    connectionTarget,
    documentTarget,
    navigatorTarget,
    serviceWorkerTarget: eventTarget(),
    windowTarget: eventTarget(),
  };
}

test("owns all browser listeners idempotently and releases them together", () => {
  const browser = harness();
  const signals = new ForegroundRecoveryBrowserSignals({
    ...browser,
    notificationMessageType: "notification",
  });

  signals.connect();
  signals.connect();
  assert.equal(browser.documentTarget.listenerCount("visibilitychange"), 1);
  assert.equal(browser.documentTarget.listenerCount("resume"), 1);
  assert.equal(browser.windowTarget.listenerCount("pageshow"), 1);
  assert.equal(browser.windowTarget.listenerCount("blur"), 1);
  assert.equal(browser.windowTarget.listenerCount("focus"), 1);
  assert.equal(browser.windowTarget.listenerCount("offline"), 1);
  assert.equal(browser.windowTarget.listenerCount("online"), 1);
  assert.equal(browser.connectionTarget.listenerCount("change"), 1);
  assert.equal(browser.serviceWorkerTarget.listenerCount("message"), 1);

  signals.disconnect();
  signals.disconnect();
  assert.equal(browser.documentTarget.listenerCount("visibilitychange"), 0);
  assert.equal(browser.documentTarget.listenerCount("resume"), 0);
  assert.equal(browser.windowTarget.listenerCount("pageshow"), 0);
  assert.equal(browser.connectionTarget.listenerCount("change"), 0);
  assert.equal(browser.serviceWorkerTarget.listenerCount("message"), 0);
});

test("normalizes observations at the browser boundary", () => {
  const browser = harness();
  browser.documentTarget.visibilityState = "hidden";
  browser.navigatorTarget.onLine = false;
  browser.connectionTarget.type = "none";
  browser.connectionTarget.effectiveType = undefined;
  const signals = new ForegroundRecoveryBrowserSignals({
    ...browser,
    notificationMessageType: "notification",
  });

  assert.deepEqual(signals.observe({ focused: false }), {
    focused: false,
    visibility: "hidden",
    network: {
      onlineHint: false,
      connectionType: "none",
      effectiveType: null,
    },
  });
});

test("emits only persisted pageshow and validated notification messages", () => {
  const browser = harness();
  const emitted = [];
  const signals = new ForegroundRecoveryBrowserSignals({
    ...browser,
    notificationMessageType: "notification",
    onSignal: (signal) => emitted.push(signal),
  });
  signals.connect();

  browser.windowTarget.dispatch("pageshow", { persisted: false });
  browser.windowTarget.dispatch("pageshow", { persisted: true });
  browser.serviceWorkerTarget.dispatch("message", {
    data: { type: "unrelated", route: "/tasks/ignored" },
  });
  browser.serviceWorkerTarget.dispatch("message", {
    data: { type: "notification", route: "/tasks/thread-a" },
  });

  assert.deepEqual(
    emitted.map(({ type, activationRoute }) => ({ type, activationRoute })),
    [
      {
        type: FOREGROUND_RECOVERY_BROWSER_SIGNAL.BFCACHE_RESTORED,
        activationRoute: "",
      },
      {
        type: FOREGROUND_RECOVERY_BROWSER_SIGNAL.NOTIFICATION_ACTIVATED,
        activationRoute: "/tasks/thread-a",
      },
    ],
  );
  signals.disconnect();
});

test("maps raw lifecycle and connectivity events to one signal shape", () => {
  const browser = harness();
  const emitted = [];
  const signals = new ForegroundRecoveryBrowserSignals({
    ...browser,
    notificationMessageType: "notification",
    onSignal: (signal) => emitted.push(signal),
  });
  signals.connect();

  browser.documentTarget.dispatch("visibilitychange");
  browser.documentTarget.dispatch("resume");
  browser.windowTarget.dispatch("blur");
  browser.windowTarget.dispatch("focus");
  browser.windowTarget.dispatch("offline");
  browser.windowTarget.dispatch("online");
  browser.connectionTarget.dispatch("change");

  assert.deepEqual(
    emitted.map((signal) => signal.type),
    [
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.VISIBILITY_CHANGED,
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.DOCUMENT_RESUMED,
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_BLURRED,
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_FOCUSED,
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.NETWORK_OFFLINE,
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.NETWORK_ONLINE,
      FOREGROUND_RECOVERY_BROWSER_SIGNAL.CONNECTION_CHANGED,
    ],
  );
  assert.equal(emitted[2].observation.focused, false);
  assert.equal(emitted[3].observation.focused, true);
  assert.ok(emitted.every((signal) => Object.isFrozen(signal.observation)));

  signals.disconnect();
  browser.windowTarget.dispatch("online");
  assert.equal(emitted.length, 7);
});
