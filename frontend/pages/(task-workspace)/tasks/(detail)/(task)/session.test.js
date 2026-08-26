import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { TaskDetailSession } from "./session.js";
import { TASK_TRANSPORT_STATE } from "../../runtime-state.js";

const originalBrowserGlobals = {
  document: globalThis.document,
  EventSource: globalThis.EventSource,
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

function installBrowserHarness() {
  const sources = [];
  const sourceWaiters = new Map();

  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.readyState = 0;
      this.closed = false;
      const index = sources.push(this) - 1;
      sourceWaiters.get(index)?.(this);
      sourceWaiters.delete(index);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, payload = null) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(payload === null ? {} : { data: JSON.stringify(payload) });
      }
    }

    emitOpen() {
      this.readyState = 1;
      this.emit("open");
    }

    emitError({ closed = false } = {}) {
      this.readyState = closed ? 2 : 0;
      this.emit("error");
    }

    close() {
      this.closed = true;
      this.readyState = 2;
    }
  }

  globalThis.window = {
    EventSource: MockEventSource,
    location: { origin: "http://127.0.0.1" },
    setTimeout,
    clearTimeout,
  };
  globalThis.EventSource = MockEventSource;
  globalThis.document = { visibilityState: "visible" };

  return {
    sources,
    waitForSource(index) {
      if (sources[index]) {
        return Promise.resolve(sources[index]);
      }
      return new Promise((resolve) => sourceWaiters.set(index, resolve));
    },
  };
}

function detail(
  threadId,
  revision,
  { readable = true, eventRevision = 0 } = {},
) {
  return {
    threadId,
    revision,
    eventRevision,
    syncState: readable ? "ready" : "loading",
    task: readable ? { id: threadId, threadId } : null,
    events: [],
    eventsPage: { nextCursor: null },
  };
}

function syncMessage(
  threadId,
  revision,
  {
    readable = true,
    reason = "stream-bootstrap",
    eventRevision = 0,
  } = {},
) {
  return {
    threadId,
    revision,
    reason,
    detail: detail(threadId, revision, { readable, eventRevision }),
  };
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("waits for a readable bootstrap and buffers connection-local events", async () => {
  const browser = installBrowserHarness();
  const syncs = [];
  const events = [];
  const session = new TaskDetailSession({
    onTaskSync: (message) => syncs.push(message),
    onTaskEvent: (message) => events.push(message),
  });

  const acquisition = session.open("thread-a");
  const source = browser.sources[0];
  source.emitOpen();
  await Promise.resolve();
  assert.equal(session.state, TASK_TRANSPORT_STATE.CONNECTING);
  assert.equal(session.phase, "waiting-bootstrap");

  source.emit(
    "task-sync",
    syncMessage("thread-a", 2, { reason: "session-sync" }),
  );
  source.emit("task-event", {
    threadId: "thread-a",
    revision: 2,
    eventRevision: 1,
    event: { id: "before-bootstrap" },
  });
  assert.deepEqual(syncs, []);
  assert.deepEqual(events, []);

  source.emit(
    "task-sync",
    syncMessage("thread-a", 3, { readable: false }),
  );
  source.emit("task-event", {
    threadId: "thread-a",
    revision: 4,
    eventRevision: 2,
    event: { id: "before-readable" },
  });
  assert.equal(syncs.length, 1);
  assert.equal(session.phase, "waiting-readable");
  assert.equal(session.state, TASK_TRANSPORT_STATE.CONNECTING);
  assert.deepEqual(events, []);

  source.emit(
    "task-sync",
    syncMessage("thread-a", 5, { reason: "session-sync" }),
  );
  const outcome = await acquisition;
  await nextTask();
  assert.equal(syncs.length, 2);
  assert.deepEqual(
    events.map((message) => message.event.id),
    ["before-bootstrap", "before-readable"],
  );
  assert.equal(session.phase, "streaming");
  assert.equal(session.state, TASK_TRANSPORT_STATE.READY);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.detail.revision, 5);
  session.deactivate();
});

test("applies one valid bootstrap per connection and rejects duplicates", async () => {
  const browser = installBrowserHarness();
  const syncs = [];
  let rejectNext = true;
  const session = new TaskDetailSession({
    onTaskSync: (message) => {
      if (rejectNext) {
        rejectNext = false;
        return false;
      }
      syncs.push(message);
      return true;
    },
  });

  session.open("thread-a");
  const source = browser.sources[0];
  source.emitOpen();
  const bootstrap = syncMessage("thread-a", 8);
  source.emit("task-sync", bootstrap);
  source.emit("task-sync", bootstrap);
  source.emit("task-sync", bootstrap);
  await nextTask();

  assert.equal(syncs.length, 1);
  assert.equal(session.state, TASK_TRANSPORT_STATE.READY);
  assert.equal(session.phase, "streaming");
  session.deactivate();
});

test("rejects late inputs from an invalidated Task generation", async () => {
  const browser = installBrowserHarness();
  const syncs = [];
  const events = [];
  const session = new TaskDetailSession({
    onTaskSync: (message) => syncs.push(message),
    onTaskEvent: (message) => events.push(message),
  });

  session.open("thread-a");
  const sourceA = browser.sources[0];
  sourceA.emitOpen();
  session.open("thread-b");
  const sourceB = browser.sources[1];
  sourceB.emitOpen();

  assert.equal(sourceA.closed, true);
  sourceA.emit("task-sync", syncMessage("thread-a", 1));
  sourceA.emit("task-event", {
    threadId: "thread-a",
    revision: 2,
    eventRevision: 1,
    event: { id: "late-a" },
  });
  sourceB.emit("task-sync", syncMessage("thread-b", 1));
  await nextTask();

  assert.deepEqual(syncs.map((message) => message.threadId), ["thread-b"]);
  assert.deepEqual(events, []);
  assert.equal(session.state, TASK_TRANSPORT_STATE.READY);
  session.deactivate();
});

test("resets or deactivates every incomplete bootstrap phase", () => {
  const browser = installBrowserHarness();
  const session = new TaskDetailSession();

  session.open("thread-a");
  assert.equal(session.phase, "waiting-bootstrap");
  session.deactivate();
  assert.equal(session.phase, "inactive");

  session.open("thread-a");
  browser.sources[1].emitOpen();
  browser.sources[1].emit(
    "task-sync",
    syncMessage("thread-a", 1, { readable: false }),
  );
  assert.equal(session.phase, "waiting-readable");
  session.open("thread-a");
  assert.equal(session.phase, "waiting-bootstrap");

  browser.sources[2].emitOpen();
  browser.sources[2].emit(
    "task-sync",
    syncMessage("thread-a", 2, { readable: false }),
  );
  assert.equal(session.phase, "waiting-readable");
  session.deactivate();
  assert.equal(session.phase, "inactive");
});

test("requires a new bootstrap on reconnect and accepts its lower baseline", async () => {
  const browser = installBrowserHarness();
  const syncs = [];
  const session = new TaskDetailSession({
    onTaskSync: (message) => syncs.push(message),
    reconnectTimeoutMs: 1_000,
  });

  session.open("thread-a");
  const source = browser.sources[0];
  source.emitOpen();
  source.emit("task-sync", syncMessage("thread-a", 40));
  await nextTask();

  source.emitError();
  assert.equal(session.state, TASK_TRANSPORT_STATE.RECONNECTING);
  assert.equal(session.phase, "waiting-bootstrap");
  source.emitOpen();
  await Promise.resolve();
  assert.equal(session.state, TASK_TRANSPORT_STATE.RECONNECTING);
  source.emit("task-sync", syncMessage("thread-a", 1));
  await nextTask();

  assert.deepEqual(syncs.map((message) => message.revision), [40, 1]);
  assert.equal(session.state, TASK_TRANSPORT_STATE.READY);
  assert.equal(session.phase, "streaming");
  session.deactivate();
});

test("bounds invalid bootstrap retries and settles the acquisition once", async () => {
  const browser = installBrowserHarness();
  let fallbackCalls = 0;
  const session = new TaskDetailSession({
    bootstrapTimeoutMs: 1,
    retryDelaysMs: [0, 0],
    loadDetail: async () => {
      fallbackCalls += 1;
      throw new Error("fallback failed");
    },
  });

  const acquisition = session.open("thread-a");
  browser.sources[0].emitOpen();
  (await browser.waitForSource(1)).emitOpen();
  (await browser.waitForSource(2)).emitOpen();
  const outcome = await acquisition;

  assert.equal(browser.sources.length, 3);
  assert.equal(fallbackCalls, 1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /fallback failed/);
  assert.equal(session.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  assert.equal(session.phase, "unavailable");
  session.deactivate();
});

test("uses one readable REST fallback when EventSource is unsupported", async () => {
  installBrowserHarness();
  delete globalThis.window.EventSource;
  delete globalThis.EventSource;
  const fallbacks = [];
  let fallbackCalls = 0;
  const session = new TaskDetailSession({
    loadDetail: async (threadId) => {
      fallbackCalls += 1;
      return detail(threadId, 1);
    },
    onFallbackDetail: (value, context) => {
      fallbacks.push({ value, context });
      return true;
    },
  });

  const outcome = await session.open("thread-a");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.fallback, true);
  assert.equal(fallbackCalls, 1);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].context.recovery, false);
  assert.equal(session.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  assert.equal(session.phase, "unavailable");
  session.deactivate();
});

test("falls back after a loading bootstrap and retries from unavailable", async () => {
  const browser = installBrowserHarness();
  const fallbacks = [];
  const session = new TaskDetailSession({
    retryDelaysMs: [],
    loadDetail: async (threadId) => detail(threadId, 2),
    onFallbackDetail: (value, context) => {
      fallbacks.push({ value, context });
      return true;
    },
  });

  const opening = session.open("thread-a");
  browser.sources[0].emitOpen();
  browser.sources[0].emit(
    "task-sync",
    syncMessage("thread-a", 1, { readable: false }),
  );
  assert.equal(session.phase, "waiting-readable");
  browser.sources[0].emitError({ closed: true });

  const fallback = await opening;
  assert.equal(fallback.ok, true);
  assert.equal(fallback.fallback, true);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].context.recovery, false);
  assert.equal(session.phase, "unavailable");

  const retry = session.retry();
  assert.equal(session.phase, "waiting-bootstrap");
  browser.sources[1].emitOpen();
  browser.sources[1].emit("task-sync", syncMessage("thread-a", 3));
  const outcome = await retry;
  await nextTask();

  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, "stream");
  assert.equal(session.phase, "streaming");
  session.deactivate();
});

test("bounds a connection that neither opens nor errors", async () => {
  const browser = installBrowserHarness();
  let fallbackCalls = 0;
  const session = new TaskDetailSession({
    connectionTimeoutMs: 1,
    retryDelaysMs: [0, 0],
    loadDetail: async () => {
      fallbackCalls += 1;
      throw new Error("fallback failed");
    },
  });

  const outcome = await session.open("thread-a");

  assert.equal(browser.sources.length, 3);
  assert.equal(fallbackCalls, 1);
  assert.equal(outcome.ok, false);
  assert.equal(session.state, TASK_TRANSPORT_STATE.UNAVAILABLE);
  assert.equal(session.phase, "unavailable");
  session.deactivate();
});

test("invalidates a pending REST fallback when another Task opens", async () => {
  installBrowserHarness();
  delete globalThis.window.EventSource;
  delete globalThis.EventSource;
  const requests = new Map();
  const applied = [];
  const session = new TaskDetailSession({
    loadDetail: (threadId) => {
      const request = deferred();
      requests.set(threadId, request);
      return request.promise;
    },
    onFallbackDetail: (value) => {
      applied.push(value.threadId);
      return true;
    },
  });

  const openingA = session.open("thread-a");
  assert.equal(session.phase, "rest-fallback");
  const openingB = session.open("thread-b");
  assert.equal(session.phase, "rest-fallback");
  assert.deepEqual(await openingA, { ok: false, stale: true });

  requests.get("thread-a").resolve(detail("thread-a", 1));
  await nextTask();
  assert.deepEqual(applied, []);

  requests.get("thread-b").resolve(detail("thread-b", 1));
  const outcome = await openingB;
  assert.equal(outcome.ok, true);
  assert.deepEqual(applied, ["thread-b"]);
  assert.equal(session.phase, "unavailable");
  session.deactivate();
});

test("deactivation rejects a pending REST fallback", async () => {
  installBrowserHarness();
  delete globalThis.window.EventSource;
  delete globalThis.EventSource;
  const request = deferred();
  let applied = false;
  const session = new TaskDetailSession({
    loadDetail: () => request.promise,
    onFallbackDetail: () => {
      applied = true;
      return true;
    },
  });

  const opening = session.open("thread-a");
  assert.equal(session.phase, "rest-fallback");
  session.deactivate();
  assert.deepEqual(await opening, { ok: false, stale: true });
  request.resolve(detail("thread-a", 1));
  await nextTask();

  assert.equal(applied, false);
  assert.equal(session.phase, "inactive");
});

test("foreground recovery settles only after its readable stream bootstrap", async () => {
  const browser = installBrowserHarness();
  const session = new TaskDetailSession();

  session.open("thread-a");
  browser.sources[0].emitOpen();
  browser.sources[0].emit("task-sync", syncMessage("thread-a", 10));
  await nextTask();
  session.suspend();

  let settled = false;
  const recovery = session.recover().then((outcome) => {
    settled = true;
    return outcome;
  });
  const replacement = browser.sources[1];
  replacement.emitOpen();
  replacement.emit(
    "task-sync",
    syncMessage("thread-a", 1, { readable: false }),
  );
  await nextTask();
  assert.equal(settled, false);
  assert.equal(session.state, TASK_TRANSPORT_STATE.VALIDATING);

  replacement.emit(
    "task-sync",
    syncMessage("thread-a", 2, { reason: "session-sync" }),
  );
  const outcome = await recovery;
  await nextTask();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.detail.revision, 2);
  assert.equal(session.state, TASK_TRANSPORT_STATE.READY);
  assert.equal(session.phase, "streaming");
  session.deactivate();
});
