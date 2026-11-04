import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./active-task-list.js");
const List = registry.element("caffold-active-task-list");
after(() => registry.restore());

test("merges its Sections' actions in the order they stand", () => {
  const pulls = [];
  const section = (id) => ({
    actionHintScope(pull) {
      pulls.push([id, pull]);
      return { targets: [{ id: `section:${id}` }] };
    },
  });
  const list = listHost({
    hints: { scope: () => ({ targets: [] }) },
    sectionComponents: () => [section("alpha"), section("beta")],
  });
  const pull = { clipRoots: [{ id: "task-list" }] };

  assert.deepEqual(
    list.actionHintScope(pull).targets.map(({ id }) => id),
    ["section:alpha", "section:beta"],
  );
  assert.deepEqual(pulls, [
    ["alpha", pull],
    ["beta", pull],
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

test("names the Section of a pinned Task and draws the pinned Tasks first", () => {
  const list = listHost({
    pinnedGroup: pinnedGroup([
      ["thread-pinned", "app"],
      ["thread-gone", "removed"],
    ]),
    sections: [
      {
        id: "app",
        name: "Workspace/app",
        repository: true,
        composerSettings: null,
        tasks: [{ threadId: "thread-b" }],
      },
    ],
    unsectioned: [{ threadId: "thread-recovery" }],
  });

  assert.equal(list.isPinned("thread-pinned"), true);
  assert.equal(list.isPinned("thread-b"), false);
  assert.equal(list.sectionForTask("thread-pinned").id, "app");
  assert.equal(list.taskFor("thread-pinned").threadId, "thread-pinned");
  assert.deepEqual(
    list.tasksWithSections().map(({ task, sectionName, pinned }) => [
      task.threadId,
      sectionName,
      pinned,
    ]),
    [
      ["thread-pinned", "app", true],
      ["thread-gone", "", true],
      ["thread-b", "app", false],
      ["thread-recovery", "", false],
    ],
  );

  const [pinned, section, recovery] = list.projectedSections();
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.label, "Pinned");
  assert.deepEqual(pinned.tasks.map(({ threadId }) => threadId), [
    "thread-pinned",
    "thread-gone",
  ]);
  assert.equal(section.id, "app");
  assert.equal(recovery.recovery, true);
  assert.equal(
    listHost({ sections: list.sections }).projectedSections()[0].id,
    "app",
  );
});

test("keeps a Section listed while a pinned Task still names it", () => {
  const list = listHost({
    pinnedGroup: pinnedGroup([["thread-pinned", "app"]]),
  });
  const sections = [
    { id: "app", name: "app", repository: false, tasks: [{ threadId: "a" }] },
    { id: "docs", name: "docs", repository: false, tasks: [{ threadId: "b" }] },
  ];

  assert.deepEqual(
    list.withoutTask(sections, "a").map(({ id, tasks }) => [id, tasks.length]),
    [
      ["app", 0],
      ["docs", 1],
    ],
  );
  assert.deepEqual(
    list.withoutTask(sections, "b").map(({ id }) => id),
    ["app"],
  );
  assert.deepEqual(
    list.withoutTask(sections, "b", "docs").map(({ id }) => id),
    ["app", "docs"],
  );
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
    assert.deepEqual(await current, {
      pinned: [],
      sections: [],
      unsectioned: [],
    });
    assert.equal(list.taskListLoaded, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("asks again when a Task is marked seen during a load, and gives every caller that answer", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const answers = [];
  globalThis.window = Object.assign(new EventTarget(), {
    location: { origin: "http://127.0.0.1" },
    setTimeout,
    clearTimeout,
  });
  globalThis.fetch = () =>
    new Promise((resolve) => {
      answers.push((unseen) =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({
            sections: [appSection([{ threadId: "thread-a", unseen }])],
            unsectioned: [],
          }),
        }),
      );
    });
  const list = listHost({
    sections: [appSection([{ threadId: "thread-a", unseen: true }])],
    taskListLoaded: true,
    taskListLoadPromise: null,
    taskListRefreshPending: false,
    taskListRequestId: 0,
    revisionByThread: new Map(),
    pendingMove: null,
    pendingTopPlacements: new Map(),
    pendingRuntimeSnapshot: null,
    settled: true,
    isConnected: true,
    groups: { value: null },
    draw() {},
    publishState() {},
    dispatchEvent() {},
  });

  try {
    const load = list.loadTasks({ force: true });
    const joined = list.loadTasks({ force: true });
    list.handleStreamEvent("task-updated", {
      data: JSON.stringify({ threadId: "thread-a", unseen: false }),
    });
    // Read before the seen mark was stored.
    answers[0](true);
    await until(() => answers.length === 2);
    assert.equal(list.taskFor("thread-a").unseen, false);

    answers[1](false);
    const held = await load;
    assert.equal(held.sections[0].tasks[0].unseen, false);
    assert.equal(await joined, held);
    assert.equal(list.taskFor("thread-a").unseen, false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("leaves whether the Task open now was seen to the server", () => {
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  const list = listHost({
    sections: [
      appSection([
        { threadId: "thread-a", unseen: false },
        { threadId: "thread-b", unseen: true },
      ]),
    ],
    taskListLoaded: true,
    selectedThreadId: "thread-a",
    selectedSectionId: "",
    pendingTopPlacements: new Map(),
    groups: { value: null },
    draw() {},
    publishState() {},
  });

  try {
    list.upsertCanonicalTask({ threadId: "thread-a", unseen: true });
    assert.equal(list.taskFor("thread-a").unseen, true);

    list.setSelectedSubject({ kind: "task", id: "thread-b" });
    assert.equal(list.taskFor("thread-b").unseen, true);

    list.placeCanonicalTaskAtTop(
      { threadId: "thread-b", unseen: true },
      { section: { id: "app", name: "app" } },
    );
    assert.equal(list.taskFor("thread-b").unseen, true);
  } finally {
    globalThis.requestAnimationFrame = originalFrame;
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
    pinnedGroup: pinnedGroup([]),
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

function appSection(tasks) {
  return {
    id: "app",
    name: "app",
    repository: false,
    directory: null,
    composerSettings: null,
    tasks,
  };
}

async function until(condition) {
  for (let turn = 0; turn < 100 && !condition(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition());
}

function pinnedGroup(entries) {
  return {
    id: "pinned",
    name: "Pinned Tasks",
    label: "Pinned",
    repository: false,
    pinned: true,
    sectionIds: new Map(entries),
    tasks: entries.map(([threadId]) => ({ threadId })),
  };
}

function html(list) {
  return templateHtml(list.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
