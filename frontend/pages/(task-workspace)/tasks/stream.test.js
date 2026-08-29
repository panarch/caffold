import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { TASK_TRANSPORT_STATE } from "./runtime-state.js";
import { TaskStreamLifecycle } from "./stream.js";

const originalBrowserGlobals = {
  document: globalThis.document,
  window: globalThis.window,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalBrowserGlobals)) {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      globalThis[name] = value;
    }
  }
});

function installBrowserHarness({ manualTimers = false } = {}) {
  const sources = [];
  const documentListeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let timerNow = 0;

  const scheduleTimer = manualTimers
    ? (callback, delay = 0) => {
        timerId += 1;
        timers.set(timerId, {
          callback,
          dueAt: timerNow + Math.max(0, Number(delay) || 0),
        });
        return timerId;
      }
    : setTimeout;
  const cancelTimer = manualTimers
    ? (id) => timers.delete(id)
    : clearTimeout;

  class MockSubscription {
    constructor(contextKey, listener) {
      this.contextKey = contextKey;
      this.listener = listener;
      this.closed = false;
      sources.push(this);
    }

    emit(type, payload = null) {
      this.listener.onEvent?.(type, payload);
    }

    emitOpen() {
      this.listener.onOpen?.();
    }

    emitError({ closed = false } = {}) {
      this.listener.onError?.(new Error("unavailable"), { closed });
    }

    close() {
      this.closed = true;
    }

    retry() {
      return !this.closed;
    }
  }

  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
  });
  globalThis.document = {
    visibilityState: "visible",
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter(
          (candidate) => candidate !== listener,
        ),
      );
    },
  };

  return {
    sources,
    subscribe(contextKey, listener) {
      return new MockSubscription(contextKey, listener);
    },
    runAllTimers() {
      let iterations = 0;
      while (timers.size) {
        iterations += 1;
        assert.ok(iterations <= 100, "manual browser timers must settle");
        const [id, timer] = [...timers.entries()].sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
        timers.delete(id);
        timerNow = timer.dueAt;
        timer.callback();
      }
    },
  };
}

function settleAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("ignores a stale logical subscription after an explicit retry", async () => {
  const browser = installBrowserHarness();
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
  });

  lifecycle.activate("task-list");
  const stale = browser.sources[0];
  lifecycle.retry();
  stale.emitOpen();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);

  browser.sources[1].emitOpen();
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("replaces a terminal source and ignores its stale generation", async () => {
  const browser = installBrowserHarness({ manualTimers: true });
  const events = [];
  const reconciliations = [];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    eventTypes: ["task-updated"],
    onEvent: (_type, event) => events.push(JSON.parse(event.data).value),
    onReconcile: (_contextKey, _isCurrent, metadata) =>
      reconciliations.push(metadata),
    retryDelaysMs: [0],
  });

  lifecycle.activate("task-list");
  const first = browser.sources[0];
  first.emitOpen();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);

  first.emitError({ closed: true });
  first.emitError({ closed: true });
  assert.equal(first.closed, true);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);
  browser.runAllTimers();

  assert.equal(browser.sources.length, 2);
  const replacement = browser.sources[1];
  first.emit("task-updated", { value: "stale" });
  replacement.emitOpen();
  await settleAsyncWork();
  replacement.emit("task-updated", { value: "current" });

  assert.deepEqual(reconciliations, [{ recovery: true }]);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  assert.deepEqual(events, ["current"]);
  lifecycle.deactivate();
});

test("bounds replacement attempts and lets an explicit retry start a new cycle", async () => {
  const browser = installBrowserHarness({ manualTimers: true });
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    retryDelaysMs: [0, 0],
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  browser.sources[0].emitError({ closed: true });
  browser.runAllTimers();
  browser.sources[1].emitError({ closed: true });
  browser.runAllTimers();
  browser.sources[2].emitError({ closed: true });
  browser.runAllTimers();

  assert.equal(browser.sources.length, 3);
  assert.equal(lifecycle.source, null);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.UNAVAILABLE);

  lifecycle.retry();
  assert.equal(browser.sources.length, 4);
  browser.sources[3].emitOpen();
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("bounds a source that never opens or errors", () => {
  const browser = installBrowserHarness({ manualTimers: true });
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    connectionTimeoutMs: 1,
    retryDelaysMs: [0, 0],
  });

  lifecycle.activate("task-list");
  browser.runAllTimers();

  assert.equal(browser.sources.length, 3);
  assert.equal(lifecycle.source, null);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  lifecycle.deactivate();
});

test("keeps transport connecting until its owner reports readiness", async () => {
  const browser = installBrowserHarness();
  const readiness = deferred();
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    waitUntilReady: () => readiness.promise,
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  await Promise.resolve();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.CONNECTING);

  readiness.resolve(true);
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("lets a stream-bootstrap owner retry without a duplicate reconciliation", async () => {
  const browser = installBrowserHarness();
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
    },
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  lifecycle.retry({ reconcile: false });
  browser.sources[1].emitOpen();
  await settleAsyncWork();

  assert.equal(reconciliations, 0);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("foreground recovery clears an interrupted stream-bootstrap retry", async () => {
  const browser = installBrowserHarness();
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
    },
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  lifecycle.retry({ reconcile: false });
  lifecycle.suspend();
  const recovery = lifecycle.recover();
  browser.sources[2].emitOpen();
  await recovery;
  await settleAsyncWork();

  assert.equal(reconciliations, 1);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("foreground validation is silent until a real transport failure", async () => {
  const browser = installBrowserHarness();
  const reconcileGate = deferred();
  const states = [];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => reconcileGate.promise,
    onStateChange: (state) => states.push(state),
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  const recovery = lifecycle.recover();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.VALIDATING);
  assert.equal(states.at(-1), TASK_TRANSPORT_STATE.VALIDATING);

  reconcileGate.resolve();
  await recovery;
  browser.sources[1].emitOpen();
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  assert.equal(states.includes(TASK_TRANSPORT_STATE.RECONNECTING), false);
  lifecycle.deactivate();
});

test("lets a reconnecting source recover without creating a duplicate", async () => {
  const browser = installBrowserHarness();
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
    },
    reconnectTimeoutMs: 1_000,
    retryDelaysMs: [0],
  });

  lifecycle.activate("thread-a");
  const source = browser.sources[0];
  source.emitOpen();
  source.emitError();
  source.emitError();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);

  source.emitOpen();
  await settleAsyncWork();
  assert.equal(browser.sources.length, 1);
  assert.equal(reconciliations, 1);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("distinguishes requested reconciliation from transport recovery", async () => {
  const browser = installBrowserHarness({ manualTimers: true });
  const reconciliations = [];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: (_contextKey, _isCurrent, metadata) =>
      reconciliations.push(metadata),
    retryDelaysMs: [0],
  });

  lifecycle.activate("thread-a");
  browser.sources[0].emitOpen();
  await lifecycle.requestReconciliation();
  assert.deepEqual(reconciliations, [{ recovery: false }]);

  browser.sources[0].emitError({ closed: true });
  browser.runAllTimers();
  browser.sources[1].emitOpen();
  await settleAsyncWork();

  assert.deepEqual(reconciliations, [
    { recovery: false },
    { recovery: true },
  ]);
  lifecycle.deactivate();
});

test("explicit recovery replaces and reconciles an already-open stream", async () => {
  const browser = installBrowserHarness();
  const reconciliation = new Promise((resolve) => {
    browser.releaseRecoveryReconciliation = resolve;
  });
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
      return reconciliation;
    },
  });

  lifecycle.activate("thread-a");
  browser.sources[0].emitOpen();
  const recovery = lifecycle.recover();
  assert.equal(browser.sources.length, 2);
  assert.equal(reconciliations, 1);
  browser.sources[1].emitOpen();
  await Promise.resolve();
  assert.equal(reconciliations, 1);
  browser.releaseRecoveryReconciliation();
  await recovery;
  await settleAsyncWork();
  assert.equal(reconciliations, 1);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("explicit recovery invalidates an older requested reconciliation", async () => {
  const browser = installBrowserHarness();
  let releaseFirstReconciliation;
  const firstReconciliation = new Promise((resolve) => {
    releaseFirstReconciliation = resolve;
  });
  const reconciliations = [];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: (_contextKey, _isCurrent, metadata) => {
      reconciliations.push(metadata);
      return reconciliations.length === 1
        ? firstReconciliation
        : Promise.resolve();
    },
  });

  lifecycle.activate("thread-a");
  browser.sources[0].emitOpen();
  const requested = lifecycle.requestReconciliation();
  const recovery = lifecycle.recover();
  releaseFirstReconciliation();
  await requested;
  await recovery;

  assert.deepEqual(reconciliations, [
    { recovery: false },
    { recovery: true },
  ]);
  browser.sources[1].emitOpen();
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});
