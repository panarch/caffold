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

    // The gateway's three error shapes: a channel-error closes only this
    // subscription, physical trouble keeps it, and exhaustion keeps it while
    // nothing more is tried.
    emitChannelError() {
      this.listener.onError?.(new Error("unavailable"), {
        closed: true,
        physical: false,
      });
    }

    emitPhysicalTrouble() {
      this.listener.onError?.(new Error("unavailable"), {
        closed: false,
        physical: true,
      });
    }

    emitPhysicalExhaustion() {
      this.listener.onError?.(new Error("unavailable"), {
        closed: true,
        exhausted: true,
        physical: true,
      });
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

  first.emitChannelError();
  first.emitChannelError();
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
  browser.sources[0].emitChannelError();
  browser.runAllTimers();
  browser.sources[1].emitChannelError();
  browser.runAllTimers();
  browser.sources[2].emitChannelError();
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

test("keeps its subscription through physical trouble and reconciles when the gateway reopens it", async () => {
  const browser = installBrowserHarness();
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
    },
    retryDelaysMs: [0],
  });

  lifecycle.activate("thread-a");
  const source = browser.sources[0];
  source.emitOpen();
  source.emitPhysicalTrouble();
  source.emitPhysicalTrouble();
  assert.equal(source.closed, false);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);

  source.emitOpen();
  await settleAsyncWork();
  assert.equal(browser.sources.length, 1);
  assert.equal(reconciliations, 1);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
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

test("keeps its subscription when the gateway gives up and reconciles once the gateway reopens it", async () => {
  const browser = installBrowserHarness();
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
    },
  });

  lifecycle.activate("task-list");
  const source = browser.sources[0];
  source.emitOpen();
  source.emitPhysicalExhaustion();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  assert.equal(source.closed, false);

  source.emitOpen();
  await settleAsyncWork();
  assert.equal(browser.sources.length, 1);
  assert.equal(reconciliations, 1);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("backs off and subscribes again when reconciling an open channel fails", async () => {
  const browser = installBrowserHarness({ manualTimers: true });
  const outcomes = [false, true];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => outcomes.shift(),
    retryDelaysMs: [0],
  });

  lifecycle.activate("task-list");
  const first = browser.sources[0];
  first.emitOpen();
  first.emitPhysicalTrouble();
  first.emitOpen();
  await settleAsyncWork();
  assert.equal(first.closed, true);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);

  browser.runAllTimers();
  assert.equal(browser.sources.length, 2);
  browser.sources[1].emitOpen();
  await settleAsyncWork();
  assert.equal(outcomes.length, 0);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("reads again once the channel opens when recovery's reading failed first", async () => {
  const browser = installBrowserHarness();
  const outcomes = [false, true];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => outcomes.shift(),
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  const outcome = await lifecycle.recover();
  assert.equal(outcome.ok, false);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);

  browser.sources[1].emitOpen();
  await settleAsyncWork();
  assert.equal(outcomes.length, 0);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("ignores a preparation begun before physical trouble once the channel reopens", async () => {
  const browser = installBrowserHarness();
  const preparations = [];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    waitUntilReady: () => {
      const preparation = deferred();
      preparations.push(preparation);
      return preparation.promise;
    },
  });

  lifecycle.activate("thread-a");
  const source = browser.sources[0];
  source.emitOpen();
  source.emitPhysicalTrouble();
  source.emitOpen();
  preparations[0].resolve(true);
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.RECONNECTING);

  preparations[1].resolve(true);
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("resumes a suspended stream when the gateway reopens its subscription", async () => {
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
  lifecycle.suspend();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.IDLE);

  browser.sources[0].emitOpen();
  await settleAsyncWork();
  assert.equal(browser.sources.length, 1);
  assert.equal(reconciliations, 1);
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});

test("is unavailable at once without a gateway to subscribe through", () => {
  installBrowserHarness();
  const lifecycle = new TaskStreamLifecycle();

  lifecycle.activate("task-list");
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  lifecycle.deactivate();
});

test("tells its owner about transport changes but not about its own suspend or deactivate", () => {
  const browser = installBrowserHarness();
  const changes = [];
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onStateChange: (state, previousState) => changes.push([previousState, state]),
  });

  lifecycle.activate("task-list");
  browser.sources[0].emitOpen();
  lifecycle.suspend();
  lifecycle.deactivate();

  assert.deepEqual(changes, [
    [TASK_TRANSPORT_STATE.IDLE, TASK_TRANSPORT_STATE.CONNECTING],
    [TASK_TRANSPORT_STATE.CONNECTING, TASK_TRANSPORT_STATE.READY],
  ]);
});

test("starts nothing for a recovery asked while hidden", async () => {
  const browser = installBrowserHarness();
  let reconciliations = 0;
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    onReconcile: () => {
      reconciliations += 1;
    },
  });

  lifecycle.activate("task-list");
  globalThis.document.visibilityState = "hidden";
  assert.deepEqual(await lifecycle.recover(), { ok: false, stale: true });
  assert.equal(browser.sources.length, 1);
  assert.equal(reconciliations, 0);
  lifecycle.deactivate();
});

test("replaces nothing when asked again for its context until it is unavailable", () => {
  const browser = installBrowserHarness({ manualTimers: true });
  const lifecycle = new TaskStreamLifecycle({
    subscribe: browser.subscribe,
    retryDelaysMs: [],
  });

  lifecycle.activate("task-list");
  lifecycle.activate("task-list");
  assert.equal(browser.sources.length, 1);

  browser.sources[0].emitChannelError();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  lifecycle.activate("task-list");
  assert.equal(browser.sources.length, 2);
  lifecycle.deactivate();
});

test("subscribes a context chosen while hidden only when recovery asks", async () => {
  const browser = installBrowserHarness();
  globalThis.document.visibilityState = "hidden";
  const lifecycle = new TaskStreamLifecycle({ subscribe: browser.subscribe });

  lifecycle.activate("task-list");
  assert.equal(browser.sources.length, 0);
  globalThis.document.visibilityState = "visible";
  lifecycle.activate("task-list");
  assert.equal(browser.sources.length, 0);

  const recovery = lifecycle.recover();
  assert.equal(browser.sources.length, 1);
  browser.sources[0].emitOpen();
  assert.equal((await recovery).ok, true);
  await settleAsyncWork();
  assert.equal(lifecycle.state, TASK_TRANSPORT_STATE.READY);
  lifecycle.deactivate();
});
