import assert from "node:assert/strict";
import test from "node:test";

class MockWatchBinding {
  constructor(path, listener) {
    this.path = path;
    this.listener = listener;
    this.closed = false;
    this.retries = 0;
  }

  emit(type, payload) {
    this.listener.onEvent?.(type, payload);
  }

  emitError({ closed = false, physical = false } = {}) {
    this.listener.onError?.(new Error("unavailable"), { closed, physical });
  }

  emitResume() {
    this.listener.onResume?.();
  }

  close() {
    this.closed = true;
  }

  retry() {
    this.retries += 1;
    return true;
  }
}

class MockLiveUpdates {
  constructor() {
    this.bindings = [];
  }

  subscribeWatch(path, listener) {
    const binding = new MockWatchBinding(path, listener);
    this.bindings.push(binding);
    return binding;
  }
}

globalThis.window = { setTimeout, clearTimeout };

const {
  createRefreshCoordinator,
  subscribeToWatch,
  watchChangeAffectsPath,
} = await import(
  "./watch.js"
);

test("shares one gateway Watch binding until the final scope subscriber leaves", async () => {
  const liveUpdates = new MockLiveUpdates();
  const ready = [];
  const first = subscribeToWatch(liveUpdates, "repo", {
    onReady: (event) => ready.push(event),
  });
  const second = subscribeToWatch(liveUpdates, "repo", {
    onReady: (event) => ready.push(event),
  });

  assert.equal(liveUpdates.bindings.length, 1);
  const source = liveUpdates.bindings[0];
  assert.equal(source.path, "repo");
  source.emit("ready", { revision: 1, scopePath: "repo", repositoryRootPath: "repo" });
  assert.equal(ready.length, 2);

  first();
  assert.equal(source.closed, false);
  second();
  assert.equal(source.closed, true);
});

test("keeps distinct Watch scopes independent on the same gateway", () => {
  const liveUpdates = new MockLiveUpdates();
  const first = subscribeToWatch(liveUpdates, "first", {});
  const second = subscribeToWatch(liveUpdates, "second", {});

  assert.deepEqual(
    liveUpdates.bindings.map((binding) => binding.path),
    ["first", "second"],
  );
  first();
  second();
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
  const liveUpdates = new MockLiveUpdates();
  const events = [];
  const unsubscribe = subscribeToWatch(liveUpdates, "recovery", {
    onReady: (event) => events.push(["ready", event.recovered]),
    onError: () => events.push(["error"]),
    onRecover: () => events.push(["visible"]),
  });
  const source = liveUpdates.bindings.at(-1);

  source.emit("ready", { revision: 1, scopePath: "recovery", repositoryRootPath: null });
  source.emitError();
  source.emit("ready", { revision: 2, scopePath: "recovery", repositoryRootPath: null });
  source.emitResume();
  source.emit("ready", {
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

test("leaves exhausted physical recovery with the workspace gateway owner", () => {
  const liveUpdates = new MockLiveUpdates();
  const errors = [];
  const unsubscribe = subscribeToWatch(liveUpdates, "physical", {
    onError: (error) => errors.push(error.message),
  });
  const binding = liveUpdates.bindings.at(-1);

  binding.emitError({ closed: true, physical: true });

  assert.deepEqual(errors, ["unavailable"]);
  assert.equal(binding.retries, 0);
  unsubscribe();
});
