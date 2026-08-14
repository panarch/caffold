import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { TaskDetailStream } from "../frontend/pages/(task-workspace)/tasks/components/detail/stream.js";
import { TASK_TRANSPORT_STATE } from "../frontend/pages/(task-workspace)/tasks/runtime-state.js";

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
  const documentListeners = new Map();

  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.readyState = 0;
      this.closed = false;
      sources.push(this);
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

    emitError() {
      this.readyState = 0;
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
    setVisibility(state) {
      globalThis.document.visibilityState = state;
      this.emitDocumentEvent("visibilitychange");
    },
    emitDocumentEvent(type) {
      for (const listener of documentListeners.get(type) ?? []) {
        listener();
      }
    },
    listenerCount(type) {
      return (documentListeners.get(type) ?? []).length;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("closes the previous thread stream and rejects its late inputs", () => {
  const browser = installBrowserHarness();
  const syncs = [];
  const events = [];
  const stream = new TaskDetailStream({
    onTaskSync: (message) => syncs.push(message),
    onTaskEvent: (message) => events.push(message),
  });

  stream.activate("thread-a");
  const sourceA = browser.sources[0];
  stream.activate("thread-b");
  const sourceB = browser.sources[1];

  assert.equal(sourceA.closed, true);
  assert.equal(browser.listenerCount("visibilitychange"), 0);
  sourceA.emit("task-sync", {
    threadId: "thread-a",
    detail: { threadId: "thread-a" },
  });
  sourceA.emit("task-event", {
    threadId: "thread-a",
    event: { id: "late-a" },
  });
  assert.deepEqual(syncs, []);
  assert.deepEqual(events, []);

  sourceB.emit("task-sync", {
    threadId: "thread-b",
    detail: { threadId: "thread-b" },
  });
  sourceB.emit("task-event", {
    threadId: "thread-b",
    event: { id: "current-b" },
  });
  assert.equal(syncs.length, 1);
  assert.equal(events.length, 1);

  stream.deactivate();
  sourceB.emit("task-event", {
    threadId: "thread-b",
    event: { id: "late-b" },
  });
  assert.equal(sourceB.closed, true);
  assert.equal(events.length, 1);
  assert.equal(browser.listenerCount("visibilitychange"), 0);
  assert.equal(stream.state, TASK_TRANSPORT_STATE.IDLE);
});

test("coalesces refresh requests within one stream generation", async () => {
  const browser = installBrowserHarness();
  const firstRefresh = deferred();
  let refreshCount = 0;
  const stream = new TaskDetailStream({
    onRefresh: () => {
      refreshCount += 1;
      return refreshCount === 1 ? firstRefresh.promise : Promise.resolve();
    },
  });

  stream.activate("thread-a");
  browser.sources[0].emitOpen();
  stream.requestRefresh();
  stream.requestRefresh();
  stream.requestRefresh();

  await Promise.resolve();
  assert.equal(refreshCount, 1);
  firstRefresh.resolve();
  await firstRefresh.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 2);
  assert.equal(stream.refresh, null);
  assert.equal(stream.state, TASK_TRANSPORT_STATE.READY);
});

test("invalidates a pending refresh when the stream generation changes", async () => {
  installBrowserHarness();
  const pendingRefresh = deferred();
  let isCurrentRefresh = null;
  const stream = new TaskDetailStream({
    onRefresh: (_threadId, isCurrent) => {
      isCurrentRefresh = isCurrent;
      return pendingRefresh.promise;
    },
  });

  stream.activate("thread-a");
  stream.requestRefresh();
  await Promise.resolve();
  assert.equal(isCurrentRefresh(), true);

  stream.activate("thread-a", { force: true });
  assert.equal(isCurrentRefresh(), false);
  pendingRefresh.resolve();
  await pendingRefresh.promise;
});

test("releases the stream while hidden and refreshes the replacement", async () => {
  const browser = installBrowserHarness();
  const refresh = deferred();
  let refreshCount = 0;
  const stream = new TaskDetailStream({
    onRefresh: () => {
      refreshCount += 1;
      return refresh.promise;
    },
  });

  stream.activate("thread-a");
  const initialSource = browser.sources[0];
  initialSource.emitOpen();

  browser.setVisibility("hidden");
  stream.suspend();
  assert.equal(initialSource.closed, true);
  assert.equal(stream.stream, null);
  assert.equal(stream.state, TASK_TRANSPORT_STATE.IDLE);

  browser.setVisibility("visible");
  const recovery = stream.recover();
  assert.equal(browser.sources.length, 2);
  const replacement = browser.sources[1];
  assert.equal(replacement.url, "/api/tasks/thread-a/stream");
  replacement.emitOpen();
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  refresh.resolve();
  await refresh.promise;
  await recovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.sources.length, 2);
  assert.equal(stream.state, TASK_TRANSPORT_STATE.READY);
});
