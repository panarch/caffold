import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("./service-worker.js", import.meta.url),
  "utf8",
).replace(
  '"caffold-shell-__CAFFOLD_BUILD_ID__"',
  '"caffold-shell-test-build"',
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(options = {}) {
  const listeners = new Map();
  const deletedCaches = [];
  const openedCaches = [];
  const skipWaitingCalls = [];
  const claimCalls = [];
  const notifications = [];
  const openedWindows = [];
  const cache = {
    addAll: options.addAll ?? (async () => {}),
    match: options.match ?? (async () => undefined),
  };
  const controlledClients = options.controlledClients ?? [];
  const allClients = options.allClients ?? controlledClients;
  const context = {
    AbortController,
    Promise,
    Response,
    Set,
    URL,
    caches: {
      delete: async (key) => {
        deletedCaches.push(key);
        return true;
      },
      keys: async () => options.cacheKeys ?? ["caffold-shell-test-build"],
      open: async (key) => {
        openedCaches.push(key);
        return cache;
      },
    },
    clearTimeout: options.clearTimeout ?? clearTimeout,
    fetch: options.fetch ?? (async () => new Response("network")),
    self: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      clients: {
        claim() {
          claimCalls.push(true);
        },
        async matchAll(matchOptions = {}) {
          return matchOptions.includeUncontrolled ? allClients : controlledClients;
        },
        async openWindow(route) {
          openedWindows.push(route);
          return options.openWindowResult;
        },
      },
      location: { origin: "https://caffold.test" },
      registration: {
        async showNotification(title, notificationOptions) {
          notifications.push([title, notificationOptions]);
        },
      },
      async skipWaiting() {
        skipWaitingCalls.push(true);
      },
    },
    setTimeout: options.setTimeout ?? setTimeout,
  };
  vm.runInNewContext(source, context);

  return {
    claimCalls,
    deletedCaches,
    openedCaches,
    openedWindows,
    notifications,
    skipWaitingCalls,
    async dispatchExtendable(type, properties = {}) {
      let completion = Promise.resolve();
      listeners.get(type)({
        ...properties,
        waitUntil(value) {
          completion = Promise.resolve(value);
        },
      });
      await completion;
    },
    dispatchFetch(request) {
      let response;
      listeners.get("fetch")({
        request,
        respondWith(value) {
          response = Promise.resolve(value);
        },
      });
      return response;
    },
  };
}

test("installs the complete shell without replacing the current worker", async () => {
  const gate = deferred();
  let installedAssets;
  const harness = createHarness({
    addAll: async (assets) => {
      installedAssets = [...assets];
      await gate.promise;
    },
  });

  const completion = harness.dispatchExtendable("install");
  await Promise.resolve();
  assert.equal(harness.skipWaitingCalls.length, 0);
  gate.resolve();
  await completion;

  assert.equal(harness.skipWaitingCalls.length, 0);
  assert.ok(installedAssets.includes("/assets/file-status.js"));
  assert.ok(installedAssets.includes("/assets/pages/foreground-recovery.js"));
  assert.ok(
    installedAssets.includes(
      "/assets/pages/foreground-recovery/browser-signals.js",
    ),
  );
  assert.ok(
    installedAssets.includes(
      "/assets/pages/foreground-recovery/lifecycle.js",
    ),
  );
  assert.ok(
    installedAssets.includes(
      "/assets/pages/foreground-recovery/machine.js",
    ),
  );
  assert.ok(installedAssets.includes("/assets/pages/pwa-update-lifecycle.js"));
  assert.ok(
    installedAssets.includes("/assets/pages/pwa-update-lifecycle/machine.js"),
  );
  assert.ok(
    installedAssets.includes("/assets/pages/pwa-update-lifecycle/runtime.js"),
  );
  assert.ok(installedAssets.includes("/assets/pages/components/update-dialog.js"));
  assert.ok(
    installedAssets.includes(
      "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js",
    ),
  );
});
for (const [name, url, cachePath] of [
  ["navigation", "https://caffold.test/tasks/83", "/"],
  ["asset", "https://caffold.test/assets/app.js", "/assets/app.js"],
]) {
  test(`serves cached ${name} without waiting for a stalled network`, async () => {
    let fetchCalls = 0;
    const harness = createHarness({
      fetch: () => {
        fetchCalls += 1;
        return new Promise(() => {});
      },
      match: async (path) =>
        path === cachePath ? new Response(`cached ${name}`) : undefined,
    });

    const response = await harness.dispatchFetch({ method: "GET", url });
    assert.equal(await response.text(), `cached ${name}`);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(harness.openedCaches, ["caffold-shell-test-build"]);
  });
}

test("fails a missing shell request explicitly after the network bound", async () => {
  let timeoutDelay;
  const harness = createHarness({
    fetch: (_request, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    setTimeout(callback, delay) {
      timeoutDelay = delay;
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  });

  const response = await harness.dispatchFetch({
    method: "GET",
    url: "https://caffold.test/assets/app.js",
  });
  assert.equal(response.status, 504);
  assert.equal(await response.text(), "Caffold app shell is unavailable.");
  assert.equal(timeoutDelay, 3000);
});

test("keeps API and unknown asset requests network-only", () => {
  const harness = createHarness();
  assert.equal(
    harness.dispatchFetch({ method: "GET", url: "https://caffold.test/api/health" }),
    undefined,
  );
  assert.equal(
    harness.dispatchFetch({
      method: "GET",
      url: "https://caffold.test/assets/not-in-this-build.js",
    }),
    undefined,
  );
});

test("retains old shell caches while an older client is still open", async () => {
  const messages = [];
  const harness = createHarness({
    allClients: [{
      id: "old-client",
      postMessage(message) {
        messages.push(message);
      },
    }],
    cacheKeys: ["caffold-shell-old-build", "caffold-shell-test-build"],
    controlledClients: [],
  });
  await harness.dispatchExtendable("activate");
  assert.deepEqual(harness.deletedCaches, []);
  assert.deepEqual(harness.claimCalls, []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "caffold:update-ready");
  assert.equal(messages[0].buildId, "test-build");
});

test("reports the active build ID to a requesting client", async () => {
  const messages = [];
  const harness = createHarness();
  await harness.dispatchExtendable("message", {
    data: { type: "caffold:get-build-id" },
    source: {
      postMessage(message) {
        messages.push(message);
      },
    },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "caffold:update-ready");
  assert.equal(messages[0].buildId, "test-build");
});

test("activates a prepared build only after explicit user intent", async () => {
  const harness = createHarness();
  await harness.dispatchExtendable("message", {
    data: { type: "caffold:activate-prepared-build" },
  });
  assert.equal(harness.skipWaitingCalls.length, 1);
  assert.equal(harness.claimCalls.length, 0);
});

test("claims clients only after an explicit prepared-build transition", async () => {
  const messages = [];
  const harness = createHarness();
  await harness.dispatchExtendable("message", {
    data: { type: "caffold:claim-prepared-build" },
    source: {
      postMessage(message) {
        messages.push(message);
      },
    },
  });
  assert.equal(harness.claimCalls.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "caffold:update-controlled");
  assert.equal(messages[0].buildId, "test-build");
});

test("removes only stale shell caches after all clients transition", async () => {
  const client = { id: "current-client" };
  const harness = createHarness({
    allClients: [client],
    cacheKeys: [
      "caffold-shell-old-build",
      "caffold-shell-test-build",
      "unrelated-cache",
    ],
    controlledClients: [client],
  });
  await harness.dispatchExtendable("message", {
    data: {
      type: "caffold:prune-shell-caches",
      cacheNames: [
        "caffold-shell-old-build",
        "caffold-shell-test-build",
        "unrelated-cache",
      ],
    },
  });
  assert.deepEqual(harness.deletedCaches, ["caffold-shell-old-build"]);
  assert.deepEqual(harness.claimCalls, []);
});

test("shows status-only terminal notifications even while clients are open", async () => {
  const harness = createHarness({
    controlledClients: [{ url: "https://caffold.test/tasks/thread-1" }],
  });
  await harness.dispatchExtendable("push", {
    data: {
      json: () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        taskName: "Review Web Push",
        tag: "topic_123",
      }),
    },
  });

  assert.equal(harness.notifications.length, 1);
  const [title, options] = harness.notifications[0];
  assert.equal(title, "Review Web Push");
  assert.equal(options.body, "Completed");
  assert.equal(options.tag, "topic_123");
  assert.deepEqual({ ...options.data }, {
    route: "/tasks/thread-1",
    threadId: "thread-1",
  });
});

test("falls back to Caffold and status-only copy when the task name is unavailable", async () => {
  const harness = createHarness();
  await harness.dispatchExtendable("push", {
    data: {
      json: () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        status: "failed",
        taskName: null,
        tag: "topic_123",
      }),
    },
  });

  assert.equal(harness.notifications.length, 1);
  const [title, options] = harness.notifications[0];
  assert.equal(title, "Caffold");
  assert.equal(options.body, "Task failed");
});

test("shows a waiting task under its own name and generic copy", async () => {
  const harness = createHarness({
    controlledClients: [{ url: "https://caffold.test/tasks/thread-1" }],
  });
  await harness.dispatchExtendable("push", {
    data: {
      json: () => ({
        kind: "actionRequired",
        threadId: "thread-1",
        taskName: "Review Web Push",
        tag: "topic_456",
      }),
    },
  });
  await harness.dispatchExtendable("push", {
    data: {
      json: () => ({
        kind: "actionRequired",
        threadId: "thread-2",
        taskName: null,
        tag: "topic_789",
      }),
    },
  });

  assert.deepEqual(harness.notifications.map(([title, options]) => [
    title,
    options.body,
    options.tag,
    { ...options.data },
  ]), [
    [
      "Review Web Push",
      "Approval required",
      "topic_456",
      { route: "/tasks/thread-1", threadId: "thread-1" },
    ],
    [
      "Caffold",
      "Approval required",
      "topic_789",
      { route: "/tasks/thread-2", threadId: "thread-2" },
    ],
  ]);
});

test("drops malformed, content-bearing, and unsafe-route waiting payloads", async () => {
  const harness = createHarness();
  for (const payload of [
    { kind: "actionRequired", threadId: "../settings", tag: "tag" },
    { kind: "actionRequired", threadId: "thread", tag: "not a tag" },
    { kind: "actionRequired", threadId: "thread", taskName: "unsafe\nname", tag: "tag" },
    { kind: "unknownNotice", threadId: "thread", tag: "tag" },
    { kind: "actionRequired", tag: "tag" },
  ]) {
    await harness.dispatchExtendable("push", {
      data: { json: () => payload },
    });
  }
  assert.deepEqual(harness.notifications, []);
});

test("drops malformed, content-bearing, and unsafe-route Push payloads", async () => {
  const harness = createHarness();
  for (const payload of [
    null,
    { threadId: "../settings", turnId: "turn", status: "completed", tag: "tag" },
    { threadId: "thread", turnId: "turn", status: "running", tag: "tag" },
    { threadId: "thread", turnId: "turn", status: "failed", tag: "not a topic" },
    {
      threadId: "thread",
      turnId: "turn",
      status: "failed",
      taskName: "unsafe\nname",
      tag: "tag",
    },
  ]) {
    await harness.dispatchExtendable("push", {
      data: { json: () => payload },
    });
  }
  await harness.dispatchExtendable("push", {
    data: { json: () => { throw new Error("bad data"); } },
  });
  assert.deepEqual(harness.notifications, []);
});

test("notification click focuses a client already showing the matching task", async () => {
  const focused = [];
  const navigated = [];
  const messages = [];
  const matching = {
    url: "https://caffold.test/tasks/thread%201/review",
    async focus() { focused.push("matching"); },
    async navigate(route) { navigated.push(route); return this; },
    postMessage(message) { messages.push(message); },
  };
  const harness = createHarness({ allClients: [matching] });
  let closed = false;
  await harness.dispatchExtendable("notificationclick", {
    notification: {
      data: { route: "/tasks/thread%201" },
      close() { closed = true; },
    },
  });
  assert.equal(closed, true);
  assert.deepEqual(focused, ["matching"]);
  assert.deepEqual(navigated, []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "caffold:notification-activation");
  assert.equal(messages[0].route, "/tasks/thread%201");
  assert.deepEqual(harness.openedWindows, []);
});

test("notification click navigates a same-origin client or opens a safe task route", async () => {
  const navigated = [];
  const focused = [];
  const existing = {
    url: "https://caffold.test/settings",
    async navigate(route) {
      navigated.push(route);
      return { async focus() { focused.push("navigated"); } };
    },
    async focus() { focused.push("existing"); },
  };
  const harness = createHarness({ allClients: [existing] });
  await harness.dispatchExtendable("notificationclick", {
    notification: { data: { route: "/tasks/thread-2" }, close() {} },
  });
  assert.deepEqual(navigated, ["/tasks/thread-2"]);
  assert.deepEqual(focused, ["navigated"]);

  const empty = createHarness();
  await empty.dispatchExtendable("notificationclick", {
    notification: { data: { route: "/tasks/thread-3" }, close() {} },
  });
  assert.deepEqual(empty.openedWindows, ["/tasks/thread-3"]);
});

test("notification click opens a new window if stale clients cannot be focused or navigated", async () => {
  const stale = {
    url: "https://caffold.test/tasks/thread-4",
    async focus() { throw new Error("closed"); },
    async navigate() { throw new Error("closed"); },
  };
  const harness = createHarness({ allClients: [stale] });
  await harness.dispatchExtendable("notificationclick", {
    notification: { data: { route: "/tasks/thread-4" }, close() {} },
  });
  assert.deepEqual(harness.openedWindows, ["/tasks/thread-4"]);
});

test("notification click ignores cross-origin and non-task routes", async () => {
  const harness = createHarness();
  for (const route of [
    "https://evil.test/tasks/thread",
    "/settings",
    "/tasks/thread/../../settings",
    "/tasks/thread?prompt=secret",
  ]) {
    await harness.dispatchExtendable("notificationclick", {
      notification: { data: { route }, close() {} },
    });
  }
  assert.deepEqual(harness.openedWindows, []);
});
