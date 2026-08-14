import assert from "node:assert/strict";
import test from "node:test";

const documentListeners = new Map();
globalThis.document = {
  visibilityState: "visible",
  addEventListener(type, listener) {
    documentListeners.set(type, listener);
  },
};

class MockEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, payload = null) {
    this.listeners.get(type)?.({ data: payload === null ? "" : JSON.stringify(payload) });
  }

  close() {
    this.closed = true;
  }
}

globalThis.window = {
  EventSource: MockEventSource,
  location: { origin: "http://localhost" },
};
globalThis.EventSource = MockEventSource;

const {
  createRefreshCoordinator,
  subscribeToWatch,
  watchChangeAffectsPath,
} = await import(
  "./watch.js"
);

test("shares one EventSource until the final scope subscriber leaves", async () => {
  const ready = [];
  const first = subscribeToWatch("repo", { onReady: (event) => ready.push(event) });
  const second = subscribeToWatch("repo", { onReady: (event) => ready.push(event) });

  assert.equal(MockEventSource.instances.length, 1);
  const source = MockEventSource.instances[0];
  assert.equal(source.url, "/api/watch?path=repo");
  source.emit("ready", { revision: 1, scopePath: "repo", repositoryRootPath: "repo" });
  assert.equal(ready.length, 2);

  first();
  assert.equal(source.closed, false);
  second();
  assert.equal(source.closed, true);
});

test("coalesces an event burst into one trailing refresh", async () => {
  let calls = 0;
  let releaseFirst;
  const firstRefresh = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const coordinator = createRefreshCoordinator(async () => {
    calls += 1;
    if (calls === 1) {
      await firstRefresh;
    }
  });

  const active = coordinator.request();
  coordinator.request();
  coordinator.request();
  releaseFirst();
  await active;

  assert.equal(calls, 2);
  assert.equal(coordinator.active, false);
});

test("matches watch changes to the selected path without treating siblings as related", () => {
  assert.equal(
    watchChangeAffectsPath({ paths: ["src/lib.rs"], overflow: false }, "src/lib.rs"),
    true,
  );
  assert.equal(
    watchChangeAffectsPath({ paths: ["src"], overflow: false }, "src/lib.rs"),
    true,
  );
  assert.equal(
    watchChangeAffectsPath(
      { paths: ["src/other.rs"], overflow: false },
      "src/lib.rs",
    ),
    false,
  );
  assert.equal(
    watchChangeAffectsPath({ paths: [], overflow: false }, "src/lib.rs"),
    true,
  );
  assert.equal(
    watchChangeAffectsPath(
      { paths: ["target/output"], overflow: true },
      "src/lib.rs",
    ),
    true,
  );
});

test("requests recovery after reconnect and visibility resume", () => {
  const events = [];
  const unsubscribe = subscribeToWatch("recovery", {
    onReady: (event) => events.push(["ready", event.recovered]),
    onError: () => events.push(["error"]),
    onRecover: () => events.push(["visible"]),
  });
  const source = MockEventSource.instances.at(-1);

  source.emit("ready", { revision: 1, scopePath: "recovery", repositoryRootPath: null });
  source.emit("error");
  source.emit("ready", { revision: 2, scopePath: "recovery", repositoryRootPath: null });
  document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  assert.equal(source.closed, true);

  document.visibilityState = "visible";
  documentListeners.get("visibilitychange")();
  const resumedSource = MockEventSource.instances.at(-1);
  assert.notEqual(resumedSource, source);
  resumedSource.emit("ready", {
    revision: 3,
    scopePath: "recovery",
    repositoryRootPath: null,
  });

  assert.deepEqual(events, [
    ["ready", false],
    ["error"],
    ["ready", true],
    ["visible"],
    ["ready", false],
  ]);
  unsubscribe();
});
