import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";
import { LIST_READ_EVENT } from "./active-task-list/list-read.js";

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

test("reads again for a second reconcile and gives it the answer when the first caller no longer wants it", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({ taskListLoaded: false, settled: false });

    const stale = list.reconcileTaskList(() => false);
    const current = list.reconcileTaskList(() => true, { recovery: true });
    reads[0].answer({ sections: [], unsectioned: [] });
    await until(() => reads.length === 2);
    reads[1].answer({ sections: [], unsectioned: [] });

    assert.equal(await stale, null);
    assert.deepEqual(await current, {
      pinned: [],
      sections: [],
      unsectioned: [],
    });
    assert.equal(list.taskListLoaded, true);
  });
});

test("asks again when a Task is marked seen during a load, and gives every caller that answer", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a", unseen: true }])],
    });

    const load = list.loadTasks({ force: true });
    const joined = list.loadTasks({ force: true });
    list.handleStreamEvent("task-updated", {
      data: JSON.stringify({ threadId: "thread-a", unseen: false }),
    });
    // Read before the seen mark was stored.
    reads[0].answer(listed([{ threadId: "thread-a", unseen: true }]));
    await until(() => reads.length === 2);
    assert.equal(list.taskFor("thread-a").unseen, false);

    reads[1].answer(listed([{ threadId: "thread-a", unseen: false }]));
    const held = await load;
    assert.equal(held.sections[0].tasks[0].unseen, false);
    assert.equal(await joined, held);
    assert.equal(list.taskFor("thread-a").unseen, false);
  });
});

test("reads again when the list is refreshed during a read, and gives every caller that answer", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a" }])],
    });

    const load = list.loadTasks({ force: true });
    list.handleStreamEvent("task-list-refresh", { data: "{}" });
    assert.equal(reads.length, 1);
    // Read before the pin was stored.
    reads[0].answer(listed([{ threadId: "thread-a" }]));
    await until(() => reads.length === 2);
    assert.equal(list.isPinned("thread-a"), false);

    reads[1].answer({
      pinned: [{ sectionId: "app", task: { threadId: "thread-a" } }],
      sections: [appSection([])],
      unsectioned: [],
    });
    const held = await load;
    assert.deepEqual(
      held.pinned.map(({ threadId }) => threadId),
      ["thread-a"],
    );
    assert.equal(list.isPinned("thread-a"), true);
  });
});

test("keeps a Task placed during a read when the answer read before it lands", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a" }])],
    });

    const load = list.loadTasks({ force: true });
    list.handleStreamEvent("task-placed-at-top", {
      data: JSON.stringify({
        task: { threadId: "thread-y" },
        placement: { section: { id: "app", name: "app" } },
      }),
    });
    assert.ok(list.taskFor("thread-y"));
    reads[0].answer(listed([{ threadId: "thread-a" }]));
    await until(() => reads.length === 2);
    assert.ok(list.taskFor("thread-y"));

    reads[1].answer(listed([{ threadId: "thread-y" }, { threadId: "thread-a" }]));
    await load;
    assert.ok(list.taskFor("thread-y"));
  });
});

test("keeps a Task out that left the list during a read", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a" }, { threadId: "thread-b" }])],
    });

    const load = list.loadTasks({ force: true });
    list.handleStreamEvent("task-removed", {
      data: JSON.stringify({ threadId: "thread-b", reason: "archived" }),
    });
    assert.equal(list.taskFor("thread-b"), null);
    reads[0].answer(listed([{ threadId: "thread-a" }, { threadId: "thread-b" }]));
    await until(() => reads.length === 2);
    assert.equal(list.taskFor("thread-b"), null);

    reads[1].answer(listed([{ threadId: "thread-a" }]));
    await load;
    assert.equal(list.taskFor("thread-b"), null);
  });
});

test("keeps the Section composer settings that changed during a read", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a" }])],
    });
    const settings = (model) => ({
      model,
      effort: "high",
      fastMode: false,
      permissionMode: null,
    });
    const withSettings = (model) => ({
      sections: [
        {
          ...appSection([{ threadId: "thread-a" }]),
          composerSettings: settings(model),
        },
      ],
      unsectioned: [],
    });

    const load = list.loadTasks({ force: true });
    list.handleStreamEvent("section-composer-settings", {
      data: JSON.stringify({
        sectionId: "app",
        composerSettings: settings("new-model"),
      }),
    });
    assert.equal(list.sectionFor("app").composerSettings.model, "new-model");
    reads[0].answer(withSettings("old-model"));
    await until(() => reads.length === 2);
    assert.equal(list.sectionFor("app").composerSettings.model, "new-model");

    reads[1].answer(withSettings("new-model"));
    await load;
    assert.equal(list.sectionFor("app").composerSettings.model, "new-model");
  });
});

test("reads again at once when a superseded read fails, and gives every caller that answer", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a" }])],
    });

    const load = list.loadTasks({ force: true });
    list.handleStreamEvent("task-list-refresh", { data: "{}" });
    reads[0].fail();
    await until(() => reads.length === 2);

    reads[1].answer(listed([{ threadId: "thread-a" }, { threadId: "thread-b" }]));
    const held = await load;
    assert.deepEqual(
      held.sections[0].tasks.map(({ threadId }) => threadId),
      ["thread-a", "thread-b"],
    );
    assert.equal(list.taskListError, null);
  });
});

test("gives every caller nothing when the list leaves the document during a read", async () => {
  await withListReads(async (reads) => {
    const list = readingHost({
      sections: [appSection([{ threadId: "thread-a" }])],
    });

    const load = list.loadTasks({ force: true });
    list.dispatchListRead(LIST_READ_EVENT.DETACHED);
    assert.equal(await load, null);

    reads[0].answer(listed([{ threadId: "thread-b" }]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(list.taskFor("thread-a"));
    assert.equal(list.taskFor("thread-b"), null);
  });
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
  const loading = html(listHost({ listRead: "reading" }));
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
    listRead: "idle",
    taskListError: null,
    settled: false,
    reorderMode: "none",
    reorderError: null,
    querySelector: () => null,
    ...properties,
  }));
}

// A list that has shown an answer, reading `GET /api/tasks` through the
// test's fetch.
function readingHost(properties) {
  return listHost({
    taskListLoaded: true,
    taskListLoadPromise: null,
    answerTaskListLoad: null,
    taskListRequestId: 0,
    revisionByThread: new Map(),
    pendingMove: null,
    pendingTopPlacements: new Map(),
    pendingRuntimeSnapshot: null,
    settled: true,
    isConnected: true,
    selectedThreadId: "",
    selectedSectionId: "",
    groups: { value: null },
    draw() {},
    publishState() {},
    dispatchEvent() {},
    ...properties,
  });
}

// Each `GET /api/tasks` waits until the test answers it with a body or fails
// it.
async function withListReads(run) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const reads = [];
  globalThis.window = Object.assign(new EventTarget(), {
    location: { origin: "http://127.0.0.1" },
    setTimeout,
    clearTimeout,
  });
  globalThis.fetch = () =>
    new Promise((resolve, reject) => {
      reads.push({
        answer: (body) =>
          resolve({ ok: true, status: 200, json: async () => body }),
        fail: () => reject(new TypeError("Failed to fetch")),
      });
    });
  try {
    await run(reads);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
}

// A list answer with one Section holding these Tasks.
function listed(tasks) {
  return { sections: [appSection(tasks)], unsectioned: [] };
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
