import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { WorkspaceLiveUpdates } from "./live-updates.ts";

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

  emitData(type, data) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
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
    onConnectionReport: options.onConnectionReport,
  });
  return { documentTarget, liveUpdates, publications, sources, windowTarget };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The `live-update-part` data the server writes for one message: a header
// line, then that part's piece of the message.
function partsOf(message, count) {
  const text = JSON.stringify(message);
  const size = Math.ceil(text.length / count);
  return Array.from({ length: count }, (_, index) => {
    const header = JSON.stringify({
      channel: message.channel,
      subscriptionId: message.subscriptionId,
      generation: message.generation,
      index,
      count,
    });
    return `${header}\n${text.slice(index * size, (index + 1) * size)}`;
  });
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
      controlRevision: 1,
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

test("passes a channel refusal's code to the subscriber with the error", async () => {
  const browser = harness();
  const errors = [];
  const detail = browser.liveUpdates.subscribeTaskDetail("thread-a", {
    onError: (error, metadata) => errors.push([error.message, error.code, metadata]),
  });
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();

  browser.sources[0].emit("live-update", {
    channel: "task-detail",
    generation: detail.generation,
    type: "channel-error",
    payload: { code: "task_archived", message: "task is archived" },
  });
  browser.sources[0].emit("live-update", {
    channel: "task-detail",
    generation: detail.generation,
    type: "channel-error",
    payload: { message: "Task Detail stream ended." },
  });

  assert.deepEqual(errors, [
    ["task is archived", "task_archived", { closed: true, physical: false }],
    ["Task Detail stream ended.", undefined, { closed: true, physical: false }],
  ]);
  detail.close();
  browser.liveUpdates.disconnect();
});

test("sends the first Task List subscription after the gateway greeting under a new revision", async () => {
  const { binding, published } = await publishedAfterGreeting(
    (liveUpdates) => liveUpdates.subscribeTaskList({}),
  );

  assert.deepEqual(published.map(({ controlRevision }) => controlRevision), [1, 2]);
  assert.equal(published[0].taskList, null);
  assert.deepEqual(published[1].taskList, { generation: binding.generation });
});

test("sends the first Task Detail subscription after the gateway greeting under a new revision", async () => {
  const { binding, published } = await publishedAfterGreeting(
    (liveUpdates) => liveUpdates.subscribeTaskDetail("thread-a", {}),
  );

  assert.deepEqual(published.map(({ controlRevision }) => controlRevision), [1, 2]);
  assert.equal(published[0].taskDetail, null);
  assert.deepEqual(published[1].taskDetail, {
    generation: binding.generation,
    threadId: "thread-a",
  });
});

test("sends the first Watch subscription after the gateway greeting under a new revision", async () => {
  const { binding, published } = await publishedAfterGreeting(
    (liveUpdates) => liveUpdates.subscribeWatch("repo", {}),
  );

  assert.deepEqual(published.map(({ controlRevision }) => controlRevision), [1, 2]);
  assert.deepEqual(published[0].watches, []);
  assert.deepEqual(published[1].watches, [
    {
      subscriptionId: binding.subscriptionId,
      generation: binding.generation,
      path: "repo",
    },
  ]);
});

async function publishedAfterGreeting(subscribe) {
  const browser = harness();
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  const binding = subscribe(browser.liveUpdates);
  await settle();
  const published = browser.publications.map(({ subscriptions }) => subscriptions);
  binding.close();
  browser.liveUpdates.disconnect();
  return { binding, published };
}

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

test("bounds quick replacements, then goes on retrying at longer delays", async () => {
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
  assert.deepEqual(errors.at(-1), {
    closed: true,
    exhausted: true,
    physical: true,
  });

  const extraBinding = browser.liveUpdates.subscribeWatch("repo", {});
  await settle();
  assert.equal(browser.sources.length, 2);

  // Each automatic attempt that fails waits longer before the next.
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    delays.push(runNextTimer(browser.windowTarget).delay);
    assert.equal(browser.liveUpdates.node, "connecting");
    browser.sources.at(-1).emit("error");
    runNextTimer(browser.windowTarget);
    assert.equal(browser.liveUpdates.node, "unavailable");
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 30_000, 30_000]);
  assert.equal(browser.sources.length, 7);

  // An explicit retry starts at once and drops the pending automatic one.
  assert.equal(browser.liveUpdates.retry(), true);
  assert.equal(browser.sources.length, 8);
  assert.equal(browser.windowTarget.timers.size, 1, "only the new connection's limit");
  browser.sources[7].emit("gateway-ready", { connectionId: "connection-h" });
  await settle();
  assert.equal(browser.liveUpdates.node, "connected");
  assert.equal(browser.liveUpdates.automaticRetryAttempt, 0);

  extraBinding.close();
  binding.close();
  browser.liveUpdates.disconnect();
});

test("an automatic retry that connects revives the channels it kept", async () => {
  const browser = harness();
  browser.liveUpdates.retryDelaysMs = [];
  browser.liveUpdates.reconnectTimeoutMs = 0;
  const opened = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onOpen: () => opened.push("task-list"),
  });
  browser.liveUpdates.connect();

  browser.sources[0].emit("error");
  runNextTimer(browser.windowTarget);
  assert.equal(browser.liveUpdates.node, "unavailable");

  runNextTimer(browser.windowTarget);
  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();
  assert.equal(browser.publications.at(-1).connectionId, "connection-b");
  browser.sources[1].emit("live-update", {
    channel: "task-list",
    generation: binding.generation,
    type: "channel-open",
  });
  assert.deepEqual(opened, ["task-list"]);

  binding.close();
  browser.liveUpdates.disconnect();
});

test("hiding the page drops a pending automatic retry", () => {
  const browser = harness();
  browser.liveUpdates.retryDelaysMs = [];
  browser.liveUpdates.reconnectTimeoutMs = 0;
  browser.liveUpdates.connect();

  browser.sources[0].emit("error");
  runNextTimer(browser.windowTarget);
  assert.equal(browser.liveUpdates.node, "unavailable");
  assert.equal(browser.windowTarget.timers.size, 1);

  browser.documentTarget.setVisibility("hidden");
  assert.equal(browser.liveUpdates.node, "suspended");
  assert.equal(browser.windowTarget.timers.size, 0);
  browser.liveUpdates.disconnect();
});

test("a connection that gives no first answer is reopened at once", async () => {
  const browser = harness();
  const errors = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onError: (_error, metadata) => errors.push(metadata),
  });
  browser.liveUpdates.connect();

  const silent = runNextTimer(browser.windowTarget);
  assert.equal(silent.delay, 8_000);
  assert.equal(browser.sources[0].closed, true);
  assert.equal(browser.sources.length, 2, "nothing waits for a browser retry");
  assert.equal(browser.liveUpdates.node, "reopened");
  assert.deepEqual(errors, [{ closed: false, physical: true }]);

  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();
  assert.equal(browser.liveUpdates.node, "connected");
  assert.equal(browser.publications.at(-1).connectionId, "connection-b");
  assert.deepEqual(errors, [{ closed: false, physical: true }]);

  binding.close();
  browser.liveUpdates.disconnect();
});

test("replaces a connection whose sent channel does not open, within the bounded retry", async () => {
  const reports = [];
  const browser = harness({
    onConnectionReport: (report) => reports.push(report.kind),
  });
  const errors = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onError: (_error, metadata) => errors.push(metadata),
  });
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  assert.equal(browser.publications.length, 1);

  const check = runNextTimer(browser.windowTarget);
  assert.equal(check.delay, 8_000);
  assert.equal(browser.sources[0].closed, true);
  assert.equal(browser.liveUpdates.node, "reconnecting");
  assert.deepEqual(errors, [{ closed: false, physical: true }]);
  assert.deepEqual(reports, ["opened", "answered", "stalled", "closed"]);

  const retry = runNextTimer(browser.windowTarget);
  assert.equal(retry.delay, 250);
  assert.equal(browser.sources.length, 2);
  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();
  browser.sources[1].emit("live-update", {
    channel: "task-list",
    generation: binding.generation,
    type: "channel-open",
  });
  assert.equal(browser.liveUpdates.node, "connected");
  assert.equal(browser.liveUpdates.retryAttempt, 0, "a delivered channel ends the attempt");
  assert.deepEqual(errors, [{ closed: false, physical: true }]);

  binding.close();
  browser.liveUpdates.disconnect();
});

test("runs out of retries when greeted connections never open their channels", async () => {
  const browser = harness();
  const errors = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onError: (_error, metadata) => errors.push(metadata),
  });
  browser.liveUpdates.connect();

  // Every connection answers its greeting, but no channel ever opens.
  for (let attempt = 0; attempt < 10 && browser.liveUpdates.node !== "unavailable"; attempt += 1) {
    const source = browser.sources.at(-1);
    if (!source.closed && browser.liveUpdates.node !== "connected") {
      source.emit("gateway-ready", { connectionId: `connection-${attempt}` });
      await settle();
    }
    runNextTimer(browser.windowTarget);
  }

  assert.equal(browser.liveUpdates.node, "unavailable");
  assert.equal(browser.sources.length, 4, "a first connection and three replacements");
  assert.deepEqual(errors.at(-1), { closed: true, exhausted: true, physical: true });

  binding.close();
  browser.liveUpdates.disconnect();
});

test("expects nothing more of a channel that opened, even before its subscription answered", async () => {
  let source = null;
  const browser = harness({
    publishSubscriptions: async (_connectionId, subscriptions) => {
      if (subscriptions.taskList) {
        source.emit("live-update", {
          channel: "task-list",
          generation: subscriptions.taskList.generation,
          type: "channel-open",
        });
      }
    },
  });
  const list = browser.liveUpdates.subscribeTaskList({});
  browser.liveUpdates.connect();
  source = browser.sources[0];
  source.emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  assert.equal(browser.windowTarget.timers.size, 0);

  const watch = browser.liveUpdates.subscribeWatch("repo", {});
  await settle();
  assert.equal(browser.windowTarget.timers.size, 1, "only the new Watch waits");
  source.emit("live-update", {
    channel: "watch",
    subscriptionId: watch.subscriptionId,
    generation: watch.generation,
    type: "channel-open",
  });
  assert.equal(browser.windowTarget.timers.size, 0);
  assert.equal(browser.liveUpdates.node, "connected");

  watch.close();
  list.close();
  browser.liveUpdates.disconnect();
});

test("joins a message sent in parts into one event for its subscription", async () => {
  const browser = harness();
  const detailEvents = [];
  const watchEvents = [];
  const detail = browser.liveUpdates.subscribeTaskDetail("thread-a", {
    onEvent: (type, payload) => detailEvents.push([type, payload]),
  });
  const watch = browser.liveUpdates.subscribeWatch("repo", {
    onEvent: (type, payload) => watchEvents.push([type, payload]),
  });
  browser.liveUpdates.connect();
  const source = browser.sources[0];
  source.emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  const page = { text: "가나다 conversation ".repeat(40) };
  const parts = partsOf({
    channel: "task-detail",
    generation: detail.generation,
    type: "task-sync",
    payload: page,
  }, 3);
  const staleParts = partsOf({
    channel: "task-detail",
    generation: detail.generation - 1,
    type: "task-sync",
    payload: { text: "stale" },
  }, 2);

  source.emitData("live-update-part", parts[0]);
  // Other channels and an older generation's parts can come between.
  source.emitData("live-update-part", staleParts[0]);
  source.emit("live-update", {
    channel: "watch",
    subscriptionId: watch.subscriptionId,
    generation: watch.generation,
    type: "change",
    payload: { revision: 2 },
  });
  source.emitData("live-update-part", parts[1]);
  source.emitData("live-update-part", staleParts[1]);
  assert.deepEqual(detailEvents, []);
  source.emitData("live-update-part", parts[2]);

  assert.deepEqual(detailEvents, [["task-sync", page]]);
  assert.deepEqual(watchEvents, [["change", { revision: 2 }]]);

  watch.close();
  detail.close();
  browser.liveUpdates.disconnect();
});

test("drops a message whose parts go missing or whose connection is replaced", async () => {
  const browser = harness();
  const events = [];
  const detail = browser.liveUpdates.subscribeTaskDetail("thread-a", {
    onEvent: (type, payload) => events.push([type, payload]),
  });
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  const parts = partsOf({
    channel: "task-detail",
    generation: detail.generation,
    type: "task-sync",
    payload: { text: "conversation ".repeat(30) },
  }, 3);

  browser.sources[0].emitData("live-update-part", parts[0]);
  browser.sources[0].emitData("live-update-part", parts[2]);
  browser.sources[0].emitData("live-update-part", parts[1]);
  browser.sources[0].emitData("live-update-part", parts[2]);
  assert.deepEqual(events, []);

  browser.sources[0].emitData("live-update-part", parts[0]);
  browser.sources[0].emitData("live-update-part", parts[1]);
  browser.liveUpdates.suspend();
  browser.liveUpdates.resume();
  browser.sources[1].emit("gateway-ready", { connectionId: "connection-b" });
  await settle();
  browser.sources[1].emitData("live-update-part", parts[2]);
  assert.deepEqual(events, []);

  for (const part of parts) {
    browser.sources[1].emitData("live-update-part", part);
  }
  assert.equal(events.length, 1);

  detail.close();
  browser.liveUpdates.disconnect();
});

test("waits on a channel's opening while anything arrives and replaces a connection silent for the limit", async () => {
  const browser = harness();
  const listErrors = [];
  const detailEvents = [];
  const list = browser.liveUpdates.subscribeTaskList({
    onError: (_error, metadata) => listErrors.push(metadata),
  });
  const detail = browser.liveUpdates.subscribeTaskDetail("thread-a", {
    onEvent: (type) => detailEvents.push(type),
  });
  browser.liveUpdates.connect();
  const source = browser.sources[0];
  source.emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  source.emit("live-update", {
    channel: "task-detail",
    generation: detail.generation,
    type: "channel-open",
  });
  // The list's opening is queued behind a large Detail page.
  const [firstCheck] = browser.windowTarget.timers.values();
  for (const part of partsOf({
    channel: "task-detail",
    generation: detail.generation,
    type: "task-sync",
    payload: { text: "conversation ".repeat(30) },
  }, 4)) {
    source.emitData("live-update-part", part);
  }
  assert.deepEqual(detailEvents, ["task-sync"]);
  assert.equal(browser.windowTarget.timers.size, 1);
  assert.ok(![...browser.windowTarget.timers.values()].includes(firstCheck));

  // The deadline each delivery replaced changes nothing when it comes due.
  firstCheck.callback();
  assert.equal(browser.liveUpdates.node, "connected");
  assert.equal(source.closed, false);

  const check = runNextTimer(browser.windowTarget);
  assert.equal(check.delay, 8_000);
  assert.equal(browser.liveUpdates.node, "reconnecting");
  assert.equal(source.closed, true);
  assert.deepEqual(listErrors, [{ closed: false, physical: true }]);

  detail.close();
  list.close();
  browser.liveUpdates.disconnect();
});

test("starts the open check as the snapshot leaves, before the snapshot is answered", async () => {
  const browser = harness({
    publishSubscriptions: () => new Promise(() => {}),
  });
  const list = browser.liveUpdates.subscribeTaskList({});
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();

  const check = runNextTimer(browser.windowTarget);
  assert.equal(check.delay, 8_000);
  assert.equal(browser.liveUpdates.node, "reconnecting");
  assert.equal(browser.sources[0].closed, true);

  list.close();
  browser.liveUpdates.disconnect();
});

test("a second silent connection ends the attempt and retry gives up after as many attempts", () => {
  const browser = harness();
  browser.liveUpdates.retryDelaysMs = [250];
  const errors = [];
  const binding = browser.liveUpdates.subscribeTaskList({
    onError: (_error, metadata) => errors.push(metadata),
  });
  browser.liveUpdates.connect();

  runNextTimer(browser.windowTarget);
  runNextTimer(browser.windowTarget);
  assert.equal(browser.liveUpdates.node, "reconnecting");
  assert.equal(browser.sources[1].closed, true);
  assert.equal(
    [...browser.windowTarget.timers.values()][0].delay,
    250,
    "the next attempt follows the usual retry delay",
  );
  assert.equal(errors.length, 1, "consumers hear of the trouble once");

  runNextTimer(browser.windowTarget);
  assert.equal(browser.liveUpdates.node, "connecting");
  assert.equal(browser.sources.length, 3);
  runNextTimer(browser.windowTarget);
  runNextTimer(browser.windowTarget);
  assert.equal(browser.sources.length, 4);
  assert.equal(browser.liveUpdates.node, "unavailable");
  assert.deepEqual(
    [...browser.windowTarget.timers.values()].map(({ delay }) => delay),
    [5_000],
    "only the first automatic retry waits",
  );
  assert.deepEqual(errors.at(-1), {
    closed: true,
    exhausted: true,
    physical: true,
  });

  binding.close();
  browser.liveUpdates.disconnect();
});

test("a browser error while connecting still waits for the browser's own retry", () => {
  const browser = harness();
  browser.liveUpdates.connect();

  browser.sources[0].emit("error");

  assert.equal(browser.liveUpdates.node, "reconnecting");
  assert.equal(browser.sources.length, 1);
  assert.deepEqual(
    [...browser.windowTarget.timers.values()].map(({ delay }) => delay),
    [8_000],
  );
  browser.liveUpdates.disconnect();
});

test("reports each connection opening, answering, and ending by its number", async () => {
  const reports = [];
  const browser = harness({
    onConnectionReport: (report) => reports.push(report),
  });
  browser.liveUpdates.connect();
  browser.sources[0].emit("gateway-ready", { connectionId: "connection-a" });
  await settle();
  browser.documentTarget.setVisibility("hidden");
  browser.documentTarget.setVisibility("visible");
  runNextTimer(browser.windowTarget);
  browser.sources[2].emit("error");

  assert.deepEqual(reports, [
    { kind: "opened", id: 1 },
    { kind: "answered", id: 1 },
    { kind: "closed", id: 1 },
    { kind: "opened", id: 3 },
    { kind: "stalled", id: 3 },
    { kind: "closed", id: 3 },
    { kind: "opened", id: 5 },
    { kind: "failed", id: 5 },
  ]);
  browser.liveUpdates.disconnect();
});
