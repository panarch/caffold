import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./active-task-list.ts");
const List = registry.element("caffold-active-task-list");
after(() => registry.restore());

test("gathers its Sections' Action Hint targets in the order they stand", () => {
  const calls = [];
  const groups = ["alpha", "beta"].map((id) => ({
    querySelector: () => ({
      actionHintTargets(options) {
        calls.push([id, options]);
        return [{ id: `section:${id}:reorder` }];
      },
    }),
  }));
  const list = listHost({
    querySelector: () => ({ querySelectorAll: () => groups }),
  });
  const options = { clipRoots: [{ id: "task-list" }] };

  assert.deepEqual(list.actionHintTargets(options), [
    { id: "section:alpha:reorder" },
    { id: "section:beta:reorder" },
  ]);
  assert.deepEqual(calls, [
    ["alpha", options],
    ["beta", options],
  ]);
});

test("finds the Section a listed Task sits in", () => {
  const list = listHost({
    sections: [
      {
        id: "notes",
        name: "Documents/notes",
        repository: false,
        composerSettings: null,
        tasks: [{ threadId: "thread-a" }],
      },
      {
        id: "app",
        name: "Workspace/app",
        repository: true,
        composerSettings: null,
        tasks: [{ threadId: "thread-b" }],
      },
    ],
  });

  assert.deepEqual(list.sectionForTask("thread-b"), {
    id: "app",
    name: "Workspace/app",
    repository: true,
    composerSettings: null,
  });
  assert.equal(list.sectionForTask("thread-a").repository, false);
  assert.equal(list.sectionForTask("thread-unlisted"), null);
});

test("gives a caller that joins a Task list load the answer when the first caller no longer wants it", async () => {
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
  const list = listHost({
    taskListLoaded: false,
    taskListLoadPromise: null,
    taskListRefreshPending: false,
    taskListRequestId: 0,
    revisionByThread: new Map(),
    pendingMove: null,
    pendingTopPlacements: new Map(),
    pendingRuntimeSnapshot: null,
    settled: false,
    isConnected: true,
    draw() {},
    publishState() {},
    dispatchEvent() {},
  });

  try {
    const stale = list.reconcileTaskList(() => false);
    const current = list.reconcileTaskList(() => true, { recovery: true });
    answer();

    assert.equal(await stale, null);
    assert.deepEqual(await current, { sections: [], unsectioned: [] });
    assert.equal(list.taskListLoaded, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("frames its Sections with the load's state and the outcome of a move", () => {
  const loading = html(listHost({ taskListLoading: true }));
  assert.match(loading, /<div class="task-list-content"><p class="task-section-message task-section-loading"><caffold-loading-text>Loading...<\/caffold-loading-text><\/p><\/div>/);

  const failed = html(listHost({
    settled: true,
    taskListError: new Error("Ledger unavailable."),
  }));
  assert.match(failed, /<div class="task-section-message task-section-load-error" role="alert"><p>Ledger unavailable.<\/p><button type="button" class="task-secondary-button" data-task-action="retry-task-list"/);

  const empty = html(listHost({ settled: true }));
  assert.match(empty, />No Caffold tasks yet.<\/p>/);

  const listed = html(listHost({
    settled: true,
    unsectioned: [{ threadId: "thread-a" }],
    reorderMode: "tasks",
    reorderError: { subjectTitle: "Alpha" },
  }));
  assert.match(listed, /<ol class="task-repository-groups" data-task-section="managed" @caffold:active-task-section-intent=""><\/ol>/);
  assert.match(listed, /<div class="task-reorder-error" role="alert"><span aria-hidden="true">Move wasn't saved. Move it again to retry.<\/span><span class="sr-only">Could not move Alpha. The saved order was restored. Move it again to retry.<\/span><\/div>/);
  assert.match(listed, /<p class="sr-only task-reorder-announcement" aria-live="polite" aria-atomic="true"><\/p>$/);
});

function listHost(properties) {
  return Object.create(List.prototype, Object.getOwnPropertyDescriptors({
    sections: [],
    unsectioned: [],
    taskListLoading: false,
    taskListError: null,
    settled: false,
    reorderMode: "none",
    reorderError: null,
    querySelector: () => null,
    ...properties,
  }));
}

function html(list) {
  return templateHtml(list.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
