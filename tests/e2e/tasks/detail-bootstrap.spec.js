import { expect, test } from "@playwright/test";

import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

function taskRecord(threadId, title, now) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: title,
    cwd: "src",
    cwdPath: "src",
    relativeCwd: ".",
    worktree: null,
    createdMs: now,
    updatedMs: now + 1,
    recencyMs: now + 1,
    lastEventSummary: title,
    unseen: false,
  };
}

function taskDetail(task, text, revision, nextCursor = null) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision,
    task,
    events: [assistantEvent(task.threadId, text, revision)],
    eventsPage: { nextCursor },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
    model: "gpt-test",
    reasoningEffort: "xhigh",
    fastMode: true,
  };
}

function loadingDetail(threadId, revision) {
  return {
    threadId,
    syncState: "loading",
    revision,
    task: null,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: true,
  };
}

function assistantEvent(threadId, text, revision) {
  return {
    id: `event_${revision}`,
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: { turnId: `turn_${revision}`, text },
    createdMs: 1_767_400_000_000 + revision,
  };
}

async function activeDetailSource(page, threadId) {
  await expect
    .poll(() =>
      page.evaluate(
        (id) => Boolean(window.__caffoldTaskSse?.source(id)),
        threadId,
      ),
    )
    .toBe(true);
  return threadId;
}

test("uses one SSE snapshot for initial detail, reconnect, and cursor history", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockCodexModels(page);
  const threadId = "thread_single_sse_bootstrap";
  const now = 1_767_400_000_000;
  const task = taskRecord(threadId, "Single SSE bootstrap", now);
  const initialDetail = taskDetail(
    task,
    "Initial detail arrived through SSE.",
    40,
    "older-cursor",
  );
  let initialDetailReads = 0;
  const historyCursors = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (!cursor) {
      initialDetailReads += 1;
      return route.fulfill({ json: initialDetail });
    }
    historyCursors.push(cursor);
    return route.fulfill({
      json: taskDetail(task, "Older history loaded through REST.", 41),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.getByText("Loading task...")).toBeVisible();
  await activeDetailSource(page, threadId);
  await expect.poll(() => initialDetailReads).toBe(0);

  await page.evaluate((id) => {
    window.__detailBootstrapSnapshotCount = 0;
    document
      .querySelector("caffold-tasks-page")
      .addEventListener("caffold:task-snapshot", (event) => {
        if (event.detail?.threadId === id) {
          window.__detailBootstrapSnapshotCount += 1;
        }
      });
  }, threadId);
  await page.evaluate(({ threadId: id, detail }) => {
    const source = window.__caffoldTaskSse.source(id);
    const message = {
      threadId: id,
      revision: detail.revision,
      reason: "stream-bootstrap",
      detail,
    };
    source.emit("task-sync", message);
    source.emit("task-sync", message);
  }, { threadId, detail: initialDetail });

  await expect(tasksPage).toContainText("Initial detail arrived through SSE.");
  await expect.poll(() => initialDetailReads).toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__detailBootstrapSnapshotCount))
    .toBe(1);
  await expect
    .poll(() =>
      tasksPage.locator("caffold-task-detail").evaluate((detail) => ({
        cursor: detail.eventsPage?.nextCursor,
        fastMode: detail.currentDetail()?.fastMode,
        model: detail.currentDetail()?.model,
        permissionMode: detail.currentDetail()?.permissionMode,
        reasoningEffort: detail.currentDetail()?.reasoningEffort,
      })),
    )
    .toEqual({
      cursor: "older-cursor",
      fastMode: true,
      model: "gpt-test",
      permissionMode: "approveForMe",
      reasoningEffort: "xhigh",
    });

  await tasksPage.locator(".task-conversation-scroll").evaluate((scroller) => {
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(tasksPage).toContainText("Older history loaded through REST.");
  expect(historyCursors).toEqual(["older-cursor"]);
  expect(initialDetailReads).toBe(0);

  await page.evaluate((id) => {
    window.__caffoldTaskSse.source(id).emitError();
  }, threadId);
  await expect(
    page.locator(
      '.app-foreground-recovery[data-recovery-state="reconnecting"]',
    ),
  ).toContainText("Reconnecting to Caffold server");
  await page.evaluate((id) => {
    window.__caffoldTaskSse.source(id).emitOpen();
  }, threadId);
  await expect(
    page.locator(
      '.app-foreground-recovery[data-recovery-state="reconnecting"]',
    ),
  ).toContainText("Reconnecting to Caffold server");

  const restartedTask = {
    ...task,
    preview: "Lower revision after restart",
    lastEventSummary: "Lower revision after restart",
    updatedMs: now + 2,
    recencyMs: now + 2,
  };
  const restartedDetail = taskDetail(
    restartedTask,
    "Lower revision stream bootstrap is authoritative.",
    1,
  );
  await page.evaluate(({ threadId: id, detail }) => {
    window.__caffoldTaskSse.source(id).emit("task-sync", {
      threadId: id,
      revision: detail.revision,
      reason: "stream-bootstrap",
      detail,
    });
  }, { threadId, detail: restartedDetail });

  await expect(tasksPage).toContainText(
    "Lower revision stream bootstrap is authoritative.",
  );
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
  expect(initialDetailReads).toBe(0);
});

test("preserves readable detail and buffers events through a loading reconnect bootstrap", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockCodexModels(page);
  const threadId = "thread_loading_reconnect_bootstrap";
  const now = 1_767_400_050_000;
  const task = taskRecord(threadId, "Loading reconnect bootstrap", now);
  const initialDetail = taskDetail(
    task,
    "Readable detail stays mounted during reconnect.",
    40,
    "preserved-cursor",
  );
  const recoveredDetail = taskDetail(
    { ...task, updatedMs: now + 2, recencyMs: now + 2 },
    "Canonical reconnect snapshot replaced the baseline.",
    2,
  );
  let detailReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: initialDetail });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await activeDetailSource(page, threadId);
  await page.evaluate(({ threadId: id, detail }) => {
    window.__caffoldTaskSse.bootstrap(detail);
  }, { threadId, detail: initialDetail });
  await expect(tasksPage).toContainText(
    "Readable detail stays mounted during reconnect.",
  );

  await page.evaluate((id) => {
    const source = window.__caffoldTaskSse.source(id);
    source.emitError();
    source.emitOpen();
    source.emit("task-sync", {
      threadId: id,
      revision: 1,
      reason: "stream-bootstrap",
      detail: {
        threadId: id,
        syncState: "loading",
        revision: 1,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: true,
      },
    });
    source.emit("task-event", {
      threadId: id,
      revision: 3,
      event: {
        id: "event_buffered_reconnect",
        threadId: id,
        type: "assistant_message",
        summary: "Buffered reconnect event",
        payload: {
          turnId: "turn_buffered_reconnect",
          text: "Buffered reconnect event was retained.",
        },
        createdMs: 1_767_400_050_100,
      },
    });
  }, threadId);

  await expect(tasksPage).toContainText(
    "Readable detail stays mounted during reconnect.",
  );
  await expect(
    page.locator(
      '.app-foreground-recovery[data-recovery-state="reconnecting"]',
    ),
  ).toContainText("Reconnecting to Caffold server");
  await page.evaluate(({ threadId: id, detail }) => {
    window.__caffoldTaskSse.source(id).emit("task-sync", {
      threadId: id,
      revision: detail.revision,
      reason: "session-bootstrap",
      detail,
    });
  }, { threadId, detail: recoveredDetail });

  await expect(tasksPage).toContainText(
    "Canonical reconnect snapshot replaced the baseline.",
  );
  await expect(tasksPage).toContainText("Buffered reconnect event was retained.");
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
  expect(detailReads).toBe(0);
});

test("uses one REST fallback per unsupported-EventSource attempt", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.EventSource;
  });
  await mockCodexModels(page);
  const threadId = "thread_rest_bootstrap_fallback";
  const now = 1_767_400_100_000;
  const task = taskRecord(threadId, "REST bootstrap fallback", now);
  const detail = taskDetail(task, "Readable through one REST fallback.", 3);
  let detailReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: detail });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Readable through one REST fallback.");
  await expect.poll(() => detailReads).toBe(1);
  const unavailable = page.locator(
    '.app-foreground-recovery[data-recovery-state="unavailable"]',
  );
  await expect(unavailable).toContainText("Caffold server unavailable.");

  await unavailable.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => detailReads).toBe(2);
});

test("bounds a detail stream that never opens and falls back once", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const threadId = "thread_never_open_fallback";
  const now = 1_767_400_150_000;
  const task = taskRecord(threadId, "Never-open fallback", now);
  const detail = taskDetail(task, "Readable after a bounded connection wait.", 3);
  let detailReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: detail });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.getByText("Loading task...")).toBeVisible();
  await page.clock.runFor(40_000);

  await expect(tasksPage).toContainText(
    "Readable after a bounded connection wait.",
  );
  expect(detailReads).toBe(1);
});

test("uses one REST reconciliation when reconnect bootstrap retries exhaust", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await installEventSourceMock(page, { autoOpen: true });
  await mockCodexModels(page);
  const threadId = "thread_exhausted_reconnect_fallback";
  const now = 1_767_400_175_000;
  const task = taskRecord(threadId, "Exhausted reconnect fallback", now);
  const initialDetail = taskDetail(
    task,
    "Readable before reconnect exhaustion.",
    40,
  );
  const recoveredDetail = taskDetail(
    { ...task, updatedMs: now + 2, recencyMs: now + 2 },
    "REST reconciled missed updates after stream exhaustion.",
    1,
  );
  let detailReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: recoveredDetail });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await emitTaskDetailBootstrap(page, initialDetail);
  await expect(tasksPage).toContainText("Readable before reconnect exhaustion.");

  await page.evaluate((id) => {
    window.__caffoldTaskSse.source(id).emitError({ closed: true });
  }, threadId);
  await page.clock.runFor(40_000);

  await expect(tasksPage).toContainText(
    "REST reconciled missed updates after stream exhaustion.",
  );
  expect(detailReads).toBe(1);
  await expect(
    page.locator(
      '.app-foreground-recovery[data-recovery-state="unavailable"]',
    ),
  ).toContainText("Caffold server unavailable.");
});

test("rejects a late REST fallback after the session switches Tasks", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.EventSource;
  });
  await mockCodexModels(page);
  const now = 1_767_400_200_000;
  const taskA = taskRecord("thread_late_fallback_a", "Late fallback A", now);
  const taskB = taskRecord("thread_late_fallback_b", "Current fallback B", now + 10);
  const detailA = taskDetail(taskA, "Late Task A fallback must stay hidden.", 2);
  const detailB = taskDetail(taskB, "Current Task B fallback remains visible.", 3);
  let releaseTaskA;
  let markTaskAStarted;
  const taskAGate = new Promise((resolve) => {
    releaseTaskA = resolve;
  });
  const taskAStarted = new Promise((resolve) => {
    markTaskAStarted = resolve;
  });
  const detailReads = new Map();

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([taskB, taskA]) }),
  );
  await page.route(/\/api\/tasks\/thread_late_fallback_[ab](?:\?|$)/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    detailReads.set(id, (detailReads.get(id) ?? 0) + 1);
    if (id === taskA.threadId) {
      markTaskAStarted();
      await taskAGate;
    }
    return route.fulfill({ json: id === taskA.threadId ? detailA : detailB });
  });

  await page.goto(`/tasks/${taskA.threadId}?cwd=src`);
  await taskAStarted;
  const tasksPage = page.locator("caffold-tasks-page");
  await tasksPage.evaluate(async (element, threadId) => {
    await element.querySelector("caffold-task-detail").open(threadId);
  }, taskB.threadId);
  await expect(tasksPage).toContainText("Current Task B fallback remains visible.");

  releaseTaskA();
  await expect(tasksPage).not.toContainText("Late Task A fallback must stay hidden.");
  await expect(tasksPage).toContainText("Current Task B fallback remains visible.");
  expect(detailReads.get(taskA.threadId)).toBe(1);
  expect(detailReads.get(taskB.threadId)).toBe(1);
});

test("does not let a pending REST fallback overwrite an explicit stream recovery", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__allowRecoveredDetailStream = false;
  });
  await installEventSourceMock(page, {
    autoOpen: true,
    detailAvailabilityKey: "__allowRecoveredDetailStream",
  });
  await mockCodexModels(page);
  const threadId = "thread_pending_fallback_recovery";
  const now = 1_767_400_300_000;
  const task = taskRecord(threadId, "Pending fallback recovery", now);
  const fallbackDetail = taskDetail(task, "Late REST fallback must stay hidden.", 8);
  const recoveredDetail = taskDetail(task, "Recovered SSE remains authoritative.", 1);
  let releaseFallback;
  let markFallbackStarted;
  const fallbackGate = new Promise((resolve) => {
    releaseFallback = resolve;
  });
  const fallbackStarted = new Promise((resolve) => {
    markFallbackStarted = resolve;
  });
  let detailReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    detailReads += 1;
    markFallbackStarted();
    await fallbackGate;
    return route.fulfill({ json: fallbackDetail });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await fallbackStarted;
  const tasksPage = page.locator("caffold-tasks-page");

  await page.evaluate(() => {
    window.__allowRecoveredDetailStream = true;
  });
  await tasksPage.locator("caffold-task-detail").evaluate((detail) => {
    detail.retryStream();
  });
  await activeDetailSource(page, threadId);
  await page.evaluate(({ threadId: id, detail }) => {
    window.__caffoldTaskSse.source(id).emit("task-sync", {
      threadId: id,
      revision: detail.revision,
      reason: "stream-bootstrap",
      detail,
    });
  }, { threadId, detail: recoveredDetail });
  await expect(tasksPage).toContainText("Recovered SSE remains authoritative.");
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();

  releaseFallback();
  await expect(tasksPage).not.toContainText("Late REST fallback must stay hidden.");
  await expect(tasksPage).toContainText("Recovered SSE remains authoritative.");
  expect(detailReads).toBe(1);
});
