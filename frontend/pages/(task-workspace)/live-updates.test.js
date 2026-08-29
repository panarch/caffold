import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { WorkspaceLiveUpdates } from "./live-updates.js";

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      globalThis[name] = value;
    }
  }
});

class FakeDocument {
  constructor() {
    this.visibilityState = "visible";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (candidate) => candidate !== listener,
      ),
    );
  }

  setVisibility(visibilityState) {
    this.visibilityState = visibilityState;
    for (const listener of this.listeners.get("visibilitychange") ?? []) {
      listener();
    }
  }
}

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.location = { origin: "http://localhost:5178" };
    this.timers = new Map();
    this.nextTimer = 0;
  }

  setTimeout(callback, delay) {
    const id = ++this.nextTimer;
    this.timers.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, payload = null) {
    if (type === "open") {
      this.readyState = 1;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload === null ? {} : { data: JSON.stringify(payload) });
    }
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function harness(options = {}) {
  const documentTarget = new FakeDocument();
  const windowTarget = new FakeWindow();
  const sources = [];
  const publications = [];
  globalThis.document = documentTarget;
  globalThis.window = windowTarget;
  const liveUpdates = new WorkspaceLiveUpdates({
    documentTarget,
    windowTarget,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    publishSubscriptions: options.publishSubscriptions ??
      (async (connectionId, subscriptions) => {
        publications.push({ connectionId, subscriptions });
      }),
  });
  return { documentTarget, liveUpdates, publications, sources, windowTarget };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runNextTimer(windowTarget) {
  const [id, timer] = windowTarget.timers.entries().next().value ?? [];
  assert.ok(timer, "expected a pending timer");
  windowTarget.timers.delete(id);
  timer.callback();
  return timer;
}

test("multiplexes Task List, Task Detail, and independent Watch scopes", async () => {
  const browser = harness();
  const listEvents = [];
  const detailEvents = [];
  const firstWatchEvents = [];
  const secondWatchEvents = [];
  const list = browser.liveUpdates.subscribeTaskList({
    onEvent: (type, payload) => listEvents.push([type, payload]),
  });
  const detail = browser.liveUpdates.subscribeTaskDetail("thread-a", {
    onEvent: (type, payload) => detailEvents.push([type, payload]),
  });
  const firstWatch = browser.liveUpdates.subscribeWatch("repo", {
    onEvent: (type, payload) => firstWatchEvents.push([type, payload]),
  });
  const secondWatch = browser.liveUpdates.subscribeWatch("other", {
    onEvent: (type, payload) => secondWatchEvents.push([type, payload]),
  });

  browser.liveUpdates.connect();
  assert.equal(browser.sources.length, 1);
  assert.equal(browser.sources[0].url, "/api/live");
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();

  assert.equal(browser.publications.length, 1);
  assert.deepEqual(browser.publications[0], {
    connectionId: "connection-a",
    subscriptions: {
      controlRevision: 4,
      taskList: { generation: list.generation },
      taskDetail: { generation: detail.generation, threadId: "thread-a" },
      watches: [
        {
          subscriptionId: firstWatch.subscriptionId,
          generation: firstWatch.generation,
          path: "repo",
        },
        {
          subscriptionId: secondWatch.subscriptionId,
          generation: secondWatch.generation,
          path: "other",
        },
      ],
    },
  });

  browser.sources[0].emit("live-update", {
    channel: "task-list",
    generation: list.generation,
    type: "task-updated",
    payload: { id: "current" },
  });
  browser.sources[0].emit("live-update", {
    channel: "task-detail",
    generation: detail.generation - 1,
    type: "task-event",
    payload: { id: "stale" },
  });
  browser.sources[0].emit("live-update", {
    channel: "watch",
    subscriptionId: secondWatch.subscriptionId,
    generation: secondWatch.generation,
    type: "change",
    payload: { revision: 2 },
  });

  assert.deepEqual(listEvents, [["task-updated", { id: "current" }]]);
  assert.deepEqual(detailEvents, []);
  assert.deepEqual(firstWatchEvents, []);
  assert.deepEqual(secondWatchEvents, [["change", { revision: 2 }]]);

  firstWatch.close();
  secondWatch.close();
  detail.close();
  list.close();
  browser.liveUpdates.disconnect();
});

test("keeps logical subscriptions across visibility replacement", async () => {
  const browser = harness();
  const resumes = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onResume: () => resumes.push("resume"),
  });
  browser.liveUpdates.connect();
  const first = browser.sources[0];
  first.emit("gateway-ready", { connectionId: "connection-a" });
  await settle();

  browser.documentTarget.setVisibility("hidden");
  assert.equal(first.closed, true);
  assert.equal(browser.liveUpdates.bindings.get("task-list"), binding);

  browser.documentTarget.setVisibility("visible");
  assert.equal(browser.sources.length, 2);
  assert.deepEqual(resumes, ["resume"]);
  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();

  assert.equal(browser.publications.at(-1).connectionId, "connection-b");
  assert.deepEqual(browser.publications.at(-1).subscriptions.taskList, {
    generation: binding.generation,
  });
  binding.close();
  browser.liveUpdates.disconnect();
});

test("foreground suspension closes the physical source and resumes desired channels", async () => {
  const browser = harness();
  const suspensions = [];
  const resumes = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onSuspend: () => suspensions.push("suspend"),
    onResume: () => resumes.push("resume"),
  });
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();

  assert.equal(browser.liveUpdates.suspend(), true);
  assert.equal(browser.sources[0].closed, true);
  assert.equal(browser.liveUpdates.bindings.get("task-list"), binding);
  assert.deepEqual(suspensions, ["suspend"]);

  assert.equal(browser.liveUpdates.resume(), true);
  assert.equal(browser.sources.length, 2);
  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();
  assert.deepEqual(resumes, ["resume"]);
  assert.deepEqual(browser.publications.at(-1).subscriptions.taskList, {
    generation: binding.generation,
  });

  binding.close();
  browser.liveUpdates.disconnect();
});

test("publishes a replacement connection without waiting for stale control", async () => {
  let releaseStalePublication;
  const stalePublication = new Promise((resolve) => {
    releaseStalePublication = resolve;
  });
  const publications = [];
  const browser = harness({
    publishSubscriptions: async (connectionId, subscriptions) => {
      publications.push({ connectionId, subscriptions });
      if (connectionId === "connection-a") {
        await stalePublication;
      }
    },
  });
  const binding = browser.liveUpdates.subscribeTaskList({});
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  assert.deepEqual(
    publications.map(({ connectionId }) => connectionId),
    ["connection-a"],
  );

  browser.documentTarget.setVisibility("hidden");
  browser.documentTarget.setVisibility("visible");
  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();

  assert.deepEqual(
    publications.map(({ connectionId }) => connectionId),
    ["connection-a", "connection-b"],
  );
  releaseStalePublication();
  await settle();
  binding.close();
  browser.liveUpdates.disconnect();
});

test("one workspace creates one physical connection", () => {
  const first = harness();
  const second = harness();
  first.liveUpdates.connect();
  second.liveUpdates.connect();

  assert.equal(first.sources.length, 1);
  assert.equal(second.sources.length, 1);
  assert.notEqual(first.sources[0], second.sources[0]);

  first.liveUpdates.disconnect();
  second.liveUpdates.disconnect();
});

test("bounds physical replacements and waits for an explicit retry", async () => {
  const browser = harness();
  browser.liveUpdates.retryDelaysMs = [0];
  browser.liveUpdates.reconnectTimeoutMs = 0;
  const errors = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onError: (_error, metadata) => errors.push(metadata),
  });
  browser.liveUpdates.connect();

  browser.sources[0].emit("error");
  runNextTimer(browser.windowTarget);
  runNextTimer(browser.windowTarget);
  assert.equal(browser.sources.length, 2);

  browser.sources[1].emit("error");
  runNextTimer(browser.windowTarget);
  assert.equal(browser.liveUpdates.node, "unavailable");
  assert.equal(browser.windowTarget.timers.size, 0);
  assert.deepEqual(errors.at(-1), {
    closed: true,
    exhausted: true,
    physical: true,
  });

  const extraBinding = browser.liveUpdates.subscribeWatch("repo", {});
  await settle();
  assert.equal(browser.sources.length, 2);
  assert.equal(browser.liveUpdates.retry(), true);
  assert.equal(browser.sources.length, 3);

  extraBinding.close();
  binding.close();
  browser.liveUpdates.disconnect();
});
