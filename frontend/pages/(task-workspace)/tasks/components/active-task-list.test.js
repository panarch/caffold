import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./active-task-list.js");
const list = registry.element("caffold-active-task-list").prototype;
after(() => registry.restore());

test("aggregates direct Section Action Hint targets in retained list order", () => {
  const calls = [];
  const sections = ["alpha", "beta"].map((id) => ({
    actionHintTargets(options) {
      calls.push([id, options]);
      return [{ id: `section:${id}:reorder` }];
    },
  }));
  const owner = {
    querySelectorAll: () => sections,
  };
  const options = { clipRoots: [{ id: "task-list" }] };

  assert.deepEqual(list.actionHintTargets.call(owner, options), [
    { id: "section:alpha:reorder" },
    { id: "section:beta:reorder" },
  ]);
  assert.deepEqual(calls, [
    ["alpha", options],
    ["beta", options],
  ]);
});

test("gives a caller that joins a Task list load the canonical answer when the first caller no longer wants it", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let answer;
  globalThis.window = Object.assign(new EventTarget(), {
    location: { origin: "http://127.0.0.1" },
    setTimeout,
    clearTimeout,
  });
  globalThis.fetch = () =>
    new Promise((resolve) => {
      answer = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ sections: [], unsectioned: [] }),
        });
    });
  const owner = {
    sections: [],
    unsectioned: [],
    taskListLoaded: false,
    taskListLoadPromise: null,
    taskListRefreshPending: false,
    taskListRequestId: 0,
    revisionByThread: new Map(),
    pendingMove: null,
    pendingTopPlacements: new Map(),
    pendingRuntimeSnapshot: null,
    initialRequestSettled: false,
    isConnected: true,
    allTasks: list.allTasks,
    loadTasks: list.loadTasks,
    performLoadTasks: list.performLoadTasks,
    markInitialRequestSettled: list.markInitialRequestSettled,
    publishState() {},
    render() {},
    dispatchInitialSettled() {},
  };

  try {
    const stale = list.reconcileTaskList.call(owner, () => false);
    const current = list.reconcileTaskList.call(owner, () => true, {
      recovery: true,
    });
    answer();

    assert.equal(await stale, null);
    assert.deepEqual(await current, { sections: [], unsectioned: [] });
    assert.equal(owner.taskListLoaded, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
