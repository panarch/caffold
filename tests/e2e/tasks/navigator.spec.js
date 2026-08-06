import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
  scrollTop,
  stabilizeDynamicText,
  taskPresentation,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("loads additional task-list pages only after a cursor request", async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);

  const task = (threadId, title, updatedMs, worktree = null) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "tests/fixtures/home",
    worktree,
    createdMs: updatedMs,
    updatedMs,
    recencyMs: updatedMs,
    lastEventSummary: `${title} summary`,
  });
  const cursors = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        cursor
          ? { tasks: [task("thread-page-2", "Older paged task", 10)], nextCursor: null }
          : { tasks: [task("thread-page-1", "Newest paged task", 20)], nextCursor: "page-2" },
      ),
    });
  });

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".task-row")).toHaveCount(1);
  await expect(tasksPage).toContainText("Newest paged task");
  await expect(tasksPage).not.toContainText("Older paged task");

  await tasksPage.getByRole("button", { name: "Load more tasks" }).click();

  await expect(tasksPage.locator(".task-row")).toHaveCount(2);
  await expect(tasksPage).toContainText("Older paged task");
  await expect(tasksPage.getByRole("button", { name: "Load more tasks" })).toHaveCount(0);
  expect(cursors).toEqual([null, "page-2"]);
});

test("archives and restores an idle Caffold task through the grouped Archived section", async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const requestedPaths = [];
  page.on("request", (request) => {
    requestedPaths.push(new URL(request.url()).pathname);
  });
  const task = (threadId, title, updatedMs) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "tests/fixtures/home/project",
    cwdPath: "tests/fixtures/home/project",
    relativeCwd: "",
    worktree: null,
    createdMs: updatedMs,
    updatedMs,
    recencyMs: updatedMs,
    lastEventSummary: `${title} summary`,
    unseen: false,
  });
  const now = Date.now();
  const activeTask = task("thread_archive", "Archive round trip", now, {
    rootPath: "tests/fixtures/home/project",
    repositoryRootPath: "tests/fixtures/home/project",
    branch: "feature/archive-round-trip",
    headSha: "1111111111111111111111111111111111111111",
    relativeCwd: "",
    linked: true,
  });
  const existingArchivedTask = task(
    "thread_archived_existing",
    "Earlier archive",
    now - 1_000,
  );
  let activeTasks = [activeTask];
  let archivedTasks = [existingArchivedTask];
  const mutations = [];

  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: archivedTasks, nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: activeTasks, nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_archive(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId: activeTask.threadId,
        task: activeTask,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_archive\/archive$/, (route) => {
    mutations.push("archive");
    activeTasks = [];
    archivedTasks = [activeTask, existingArchivedTask];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTask),
    });
  });
  await page.route(/\/api\/tasks\/thread_archive\/restore$/, (route) => {
    mutations.push("restore");
    activeTasks = [activeTask];
    archivedTasks = [existingArchivedTask];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTask),
    });
  });

  await page.goto("/tasks/thread_archive");
  const navigator = page.locator("caffold-task-navigator");
  await expect(navigator.locator(".task-list-section")).toHaveCount(2);
  await expect(navigator.locator(".task-list-section-header h2")).toHaveText([
    "Caffold Tasks",
    "Archived",
  ]);
  expect(requestedPaths).not.toContain("/api/task-history");
  await expect(
    navigator.locator('.task-list-section[data-task-section="archived"]'),
  ).toContainText("Earlier archive");
  await page.getByRole("button", { name: /Task details/ }).click();
  await expect(
    page.getByText(
      "Archive removes this task from the active list. Its worktree and files are retained.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archive task" }).click();

  await expect(page).toHaveURL("/");
  await expect(
    navigator.locator('.task-list-section[data-task-section="managed"]'),
  ).not.toContainText("Archive round trip");
  const archivedSection = navigator.locator(
    '.task-list-section[data-task-section="archived"]',
  );
  await expect(archivedSection).toContainText("Archive round trip");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await captureReviewScreenshot(page, testInfo, "tasks-archived-section");
  await archivedSection
    .getByRole("button", { name: "Restore Archive round trip" })
    .click();

  await expect(
    navigator.locator('.task-list-section[data-task-section="managed"]'),
  ).toContainText("Archive round trip");
  await expect(archivedSection).not.toContainText("Archive round trip");
  expect(mutations).toEqual(["archive", "restore"]);
});

test("keeps an idle task active when the archive request fails", async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_archive_failure",
    threadId: "thread_archive_failure",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Archive failure stays active",
    preview: "Archive failure fixture",
    cwd: "tests/fixtures/home/project",
    cwdPath: "tests/fixtures/home/project",
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: "Archive failure fixture",
    unseen: false,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_archive_failure(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId: task.threadId,
        task,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_archive_failure\/archive$/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "codex_unavailable", message: "Archive failed by fixture." },
      }),
    }),
  );

  await page.goto("/tasks/thread_archive_failure");
  await page.getByRole("button", { name: /Task details/ }).click();
  await page.getByRole("button", { name: "Archive task" }).click();

  await expect(page).toHaveURL(/\/tasks\/thread_archive_failure$/);
  await expect(page.getByRole("alert")).toHaveText("Archive failed by fixture.");
  await expect(
    page.locator(
      'caffold-task-navigator .task-list-section[data-task-section="managed"]',
    ),
  ).toContainText("Archive failure stays active");
  await expect(
    page.locator(
      'caffold-task-navigator .task-list-section[data-task-section="archived"]',
    ),
  ).not.toContainText("Archive failure stays active");
});

test("keeps a task archived when restore fails", async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_restore_failure",
    threadId: "thread_restore_failure",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Restore failure stays archived",
    preview: "Restore failure fixture",
    cwd: "tests/fixtures/home/project",
    cwdPath: "tests/fixtures/home/project",
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: "Restore failure fixture",
    unseen: false,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_restore_failure\/restore$/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "codex_unavailable", message: "Restore failed by fixture." },
      }),
    }),
  );

  await page.goto("/tasks");
  const archivedSection = page.locator(
    'caffold-task-navigator .task-list-section[data-task-section="archived"]',
  );
  await archivedSection
    .getByRole("button", { name: "Restore Restore failure stays archived" })
    .click();

  await expect(archivedSection.getByRole("alert")).toHaveText(
    "Restore failed by fixture.",
  );
  await expect(archivedSection).toContainText("Restore failure stays archived");
  await expect(
    page.locator(
      'caffold-task-navigator .task-list-section[data-task-section="managed"]',
    ),
  ).not.toContainText("Restore failure stays archived");
});

test("does not offer archive while the canonical task is active", async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_active_archive",
    threadId: "thread_active_archive",
    ...canonicalTaskState("active", {
      turnId: "turn_active_archive",
      startedAtMs: 20,
      latestTurnStatus: "inProgress",
    }),
    title: "Active archive guard",
    preview: "Active archive guard",
    cwd: "tests/fixtures/home/project",
    cwdPath: "tests/fixtures/home/project",
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: "Active archive guard",
    unseen: false,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_active_archive(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId: task.threadId,
        task,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.goto("/tasks/thread_active_archive");
  await page.getByRole("button", { name: /Task details/ }).click();

  await expect(page.getByRole("button", { name: "Archive task" })).toBeDisabled();
});

test("clears stale task rows when canonical list reload fails", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        if (url.includes("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError() {
        this.readyState = 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);

  const task = {
    id: "thread_stale_list",
    threadId: "thread_stale_list",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Must not survive failed reload",
    preview: "Stale projection",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: 1,
    updatedMs: 2,
    recencyMs: 2,
    lastEventSummary: "Stale projection",
  };
  let taskReads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskReads += 1;
    if (taskReads === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [task], nextCursor: null }),
      });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Canonical task list unavailable" }),
    });
  });

  await page.goto("/tasks");
  const navigator = page.locator("caffold-task-navigator");
  await expect(navigator).toContainText("Must not survive failed reload");
  await page.evaluate(() => {
    window.__taskListEventSource.emitOpen();
    window.__taskListEventSource.emitError();
    window.__taskListEventSource.emitOpen();
  });

  await expect(navigator).not.toContainText("Must not survive failed reload");
  await expect(navigator.getByRole("alert")).toContainText(
    "Canonical task list unavailable",
  );
  expect(taskReads).toBe(2);
});
test("uses a global grouped Tasks master-detail list", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
      }

      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  const now = 1_767_300_000_000;
  const taskRecord = (overrides) => ({
    id: overrides.threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: overrides.title,
    preview: `${overrides.title} preview`,
    cwd: overrides.cwd,
    cwdPath: overrides.cwd,
    relativeCwd: overrides.relativeCwd ?? "",
    worktree: overrides.worktree ?? null,
    createdMs: now,
    updatedMs: overrides.updatedMs,
    recencyMs: overrides.updatedMs,
    lastEventSummary: `${overrides.title} summary`,
    ...overrides,
  });
  const mainWorktree = {
    rootPath: "src",
    repositoryRootPath: "src",
    branch: "main",
    headSha: "1111111111111111111111111111111111111111",
    relativeCwd: "",
    linked: false,
  };
  const tasks = [
    taskRecord({
      threadId: "thread_main_root",
      title: "Main root task",
      cwd: "src",
      worktree: mainWorktree,
      updatedMs: now + 300,
    }),
    taskRecord({
      threadId: "thread_main_core",
      title: "Main core task",
      cwd: "src/core",
      relativeCwd: "core",
      worktree: { ...mainWorktree, relativeCwd: "core" },
      updatedMs: now + 200,
    }),
    taskRecord({
      threadId: "thread_feature",
      title: "Feature worktree task",
      cwd: "worktrees/feature",
      ...canonicalTaskState("active", {
        turnId: "turn_feature",
        latestTurnStatus: "inProgress",
      }),
      worktree: {
        rootPath: "worktrees/feature",
        repositoryRootPath: "src",
        branch: "feature/long-worktree-branch-name",
        headSha: "2222222222222222222222222222222222222222",
        relativeCwd: "",
        linked: true,
      },
      updatedMs: now + 400,
    }),
    taskRecord({
      threadId: "thread_docs",
      title: "Documentation directory task with an intentionally long title",
      cwd: "docs",
      ...canonicalTaskState("active", {
        activeFlags: ["waitingOnApproval"],
        latestTurnStatus: "inProgress",
      }),
      updatedMs: now + 100,
    }),
  ];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks }),
    });
  });
  await page.route(/\/api\/tasks\/thread_[^/?]+(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const threadId = url.pathname.split("/").at(-1);
    const task = tasks.find((candidate) => candidate.threadId === threadId);
    expect(task).toBeTruthy();
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task,
        events: [
          {
            id: `event_${threadId}`,
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: { text: `${task.title} detail response` },
            createdMs: task.updatedMs,
          },
        ],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto("/tasks?cwd=src");
  await expect(page).toHaveURL("/");
  const tasksPage = page.locator("caffold-tasks-page");
  const listPane = tasksPage.locator(".tasks-list-pane");
  const detailPane = tasksPage.locator(".tasks-detail-pane");
  const resizer = tasksPage.locator(".tasks-master-resizer");
  const rows = tasksPage.locator(".task-row");

  await expect(tasksPage.locator(".task-repository-group")).toHaveCount(2);
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Feature worktree task");
  await expect(rows.nth(1)).toContainText("Main root task");
  await expect(rows.nth(2)).toContainText("Main core task");
  await expect(rows.nth(3)).toContainText(
    "Documentation directory task with an intentionally long title",
  );
  await expect(tasksPage.locator(".task-row-summary")).toHaveCount(0);
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"] .task-row-worktree'),
  ).toHaveAttribute("title", /feature\/long-worktree-branch-name/);
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_main_root"] .task-row-worktree'),
  ).toHaveCount(0);
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"] .task-status-spinner'),
  ).toBeVisible();
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"]'),
  ).toHaveAttribute("data-task-status", "running");
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"]'),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_main_root"] .task-row-time'),
  ).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-row[data-thread-id="thread_docs"] [data-status="waiting_for_approval"]',
    ),
  ).toBeVisible();
  await expect(tasksPage.locator('.task-row .task-status-label')).toHaveCount(0);
  await test.step("keeps navigator status presentation stable", async () => {
    const rootFontSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const expectedSlotSize = Math.round(rootFontSize * 1.25);
    const expectedIconSize = rootFontSize * 0.875;
    const runningChip = tasksPage.locator(
      '.task-row[data-thread-id="thread_feature"] .task-status-chip',
    );
    const waitingChip = tasksPage.locator(
      '.task-row[data-thread-id="thread_docs"] .task-status-chip',
    );
    expect(await taskPresentation(runningChip)).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(231, 244, 238)",
        borderRadius: "999px",
        borderWidth: "0px",
        color: "rgb(22, 124, 92)",
        display: "grid",
        height: expectedSlotSize,
        padding: "0px",
        width: expectedSlotSize,
      }),
    );
    expect(await taskPresentation(runningChip.locator(".task-status-spinner"))).toEqual(
      expect.objectContaining({
        animationName: "task-status-spin",
        borderRadius: "999px",
      }),
    );
    const spinnerPresentation = await taskPresentation(
      runningChip.locator(".task-status-spinner"),
    );
    expect(Number.parseFloat(spinnerPresentation.cssHeight)).toBeCloseTo(
      expectedIconSize,
      2,
    );
    expect(Number.parseFloat(spinnerPresentation.cssWidth)).toBeCloseTo(
      expectedIconSize,
      2,
    );
    expect(await taskPresentation(waitingChip)).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 244, 217)",
        borderRadius: "999px",
        borderWidth: "0px",
        color: "rgb(127, 86, 0)",
        display: "grid",
        height: expectedSlotSize,
        padding: "0px",
        width: expectedSlotSize,
      }),
    );
  });
  const rowLayout = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const title = element.querySelector(".task-row-title");
      const indicators = element.querySelector(".task-row-indicators");
      return {
        height: Math.round(element.getBoundingClientRect().height),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        indicatorWidth: Math.round(indicators.getBoundingClientRect().width),
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    }),
  );
  const rowHeights = rowLayout.map(({ height }) => height);
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(new Set(rowHeights).size).toBe(1);
  expect(rowHeights[0]).toBeLessThanOrEqual(44);
  expect(new Set(rowLayout.map(({ titleWidth }) => titleWidth)).size).toBe(1);
  expect(new Set(rowLayout.map(({ indicatorWidth }) => indicatorWidth))).toEqual(
    new Set([Math.round(rootFontSize * 3.5)]),
  );
  expect(rowLayout.every(({ hasHorizontalOverflow }) => !hasHorizontalOverflow)).toBe(true);
  const longTitleLayout = await tasksPage
    .locator('.task-row[data-thread-id="thread_docs"] .task-row-title')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        isTruncated: element.scrollWidth > element.clientWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
  expect(longTitleLayout.textOverflow).toBe("ellipsis");
  expect(longTitleLayout.whiteSpace).toBe("nowrap");

  if (testInfo.project.name !== "phone") {
    expect(longTitleLayout.isTruncated).toBe(true);
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeVisible();
    await expect(resizer).toBeVisible();
    await expect(tasksPage.locator('textarea[name="prompt"]')).toBeVisible();
    const initialLayout = await tasksPage.evaluate((element) => {
      const list = element.querySelector(".tasks-list-pane").getBoundingClientRect();
      const separator = element
        .querySelector(".tasks-master-resizer")
        .getBoundingClientRect();
      return {
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        listWidth: list.width,
        separatorWidth: separator.width,
      };
    });
    expect(initialLayout.hasHorizontalOverflow).toBe(false);
    expect(Math.round(initialLayout.listWidth)).toBe(380);
    expect(Math.round(initialLayout.separatorWidth)).toBe(6);
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-master-detail-home-composer");

    const separatorBox = await resizer.boundingBox();
    expect(separatorBox).not.toBeNull();
    await page.mouse.move(
      separatorBox.x + separatorBox.width / 2,
      separatorBox.y + separatorBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + separatorBox.width / 2 + 40, separatorBox.y + 20);
    await page.mouse.up();
    const maximumListWidth = Number(
      await resizer.getAttribute("aria-valuemax"),
    );
    await expect(resizer).toHaveAttribute(
      "aria-valuenow",
      `${Math.min(420, maximumListWidth)}`,
    );

    await resizer.focus();
    await resizer.press("End");
    await expect(resizer).toHaveAttribute(
      "aria-valuenow",
      `${maximumListWidth}`,
    );
    await resizer.press("Home");
    await expect(resizer).toHaveAttribute("aria-valuenow", "280");
    await resizer.press("ArrowRight");
    await expect(resizer).toHaveAttribute("aria-valuenow", "296");

    const listScrollBeforeSelection = await tasksPage.evaluate(() => {
      const scroller = document.querySelector("caffold-tasks-page .task-list-scroll");
      scroller.style.height = "90px";
      scroller.scrollTop = 40;
      scroller.querySelector(
        '.task-list-section[data-task-section="managed"] .task-list',
      ).dataset.domProbe = "preserved";
      const row = document.querySelector(
        'caffold-tasks-page .task-row[data-thread-id="thread_main_core"]',
      );
      row.dataset.domProbe = "preserved";
      row.closest("li").dataset.domProbe = "preserved";
      return scroller.scrollTop;
    });
    expect(listScrollBeforeSelection).toBeGreaterThan(0);
    await tasksPage.evaluate(() =>
      document
        .querySelector('caffold-tasks-page .task-row[data-thread-id="thread_main_root"]')
        .click(),
    );
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(listPane).toBeVisible();
    await expect(detailPane).toContainText("Main root task detail response");
    await expect(
      tasksPage.locator('.task-row[data-thread-id="thread_main_root"]'),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      tasksPage
        .locator('.task-list-section[data-task-section="managed"] .task-list')
        .first(),
    ).toHaveAttribute("data-dom-probe", "preserved");
    await expect(
      tasksPage.locator('li[data-thread-id="thread_main_core"]'),
    ).toHaveAttribute("data-dom-probe", "preserved");
    await expect(
      tasksPage.locator('.task-row[data-thread-id="thread_main_core"]'),
    ).toHaveAttribute("data-dom-probe", "preserved");
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(listScrollBeforeSelection);
    await tasksPage.locator(".task-list-scroll").evaluate((element) => {
      element.style.height = "";
    });
    await captureReviewScreenshot(page, testInfo, "tasks-master-detail-selected");

    await tasksPage.locator('.task-row[data-thread-id="thread_main_core"]').click();
    await expect(page).toHaveURL("/tasks/thread_main_core");
    await expect(detailPane).toContainText("Main core task detail response");
    await expect(detailPane).not.toContainText("Main root task detail response");

    await tasksPage.locator('.task-row[data-thread-id="thread_main_root"]').click();
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(detailPane).toContainText("Main root task detail response");
    await expect(detailPane).not.toContainText("Main core task detail response");

    await tasksPage
      .locator('caffold-task-detail-summary [data-task-action="open-new"]')
      .click();
    await expect(page).toHaveURL("/tasks/new?cwd=src");
    await expect(listPane).toBeVisible();
    await expect(detailPane.locator(".task-new-form")).toBeVisible();
    await expect(resizer).toHaveAttribute("aria-valuenow", "296");
    await captureReviewScreenshot(page, testInfo, "tasks-master-detail-new");
  } else {
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeHidden();
    await expect(resizer).toBeHidden();
    await tasksPage.locator('.task-row[data-thread-id="thread_main_root"]').click();
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(listPane).toBeHidden();
    await expect(detailPane).toBeVisible();
    await expect(detailPane).toContainText("Main root task detail response");
    await captureReviewScreenshot(page, testInfo, "tasks-single-pane-detail");
    await page.locator("caffold-codex-workspace .codex-workspace-close").click();
    await expect(page).toHaveURL("/");
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeHidden();
  }
});

test("switches Tasks to master-detail at the Fold8 landscape boundary", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  const now = 1_767_300_000_000;
  const task = {
    id: "thread-fold8-boundary",
    threadId: "thread-fold8-boundary",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Fold8 landscape task",
    preview: "Fold8 landscape task preview",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Fold8 landscape task summary",
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route("**/api/tasks/thread-fold8-boundary", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 1,
        threadId: task.threadId,
        task,
        model: "gpt-test",
        reasoningEffort: "medium",
        permissionMode: "askForApproval",
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.setViewportSize({ width: 899, height: 704 });
  await page.goto(`/tasks/${task.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const listPane = tasksPage.locator(".tasks-list-pane");
  const detailPane = tasksPage.locator(".tasks-detail-pane");
  const resizer = tasksPage.locator(".tasks-master-resizer");
  await expect(listPane).toBeHidden();
  await expect(detailPane).toBeVisible();
  await expect(resizer).toBeHidden();

  await page.setViewportSize({ width: 900, height: 704 });
  await expect(listPane).toBeVisible();
  await expect(detailPane).toBeVisible();
  await expect(resizer).toBeVisible();
  const layout = await tasksPage.evaluate((element) => {
    const list = element.querySelector(".tasks-list-pane").getBoundingClientRect();
    const detail = element.querySelector(".tasks-detail-pane").getBoundingClientRect();
    return {
      detailWidth: detail.width,
      listWidth: list.width,
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
  expect(layout.overflow).toBe(false);
  expect(layout.listWidth).toBeGreaterThanOrEqual(280);
  expect(layout.detailWidth).toBeGreaterThanOrEqual(520);
});
test("keeps the Tasks list DOM stable while opening a managed task", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        if (url.includes("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const now = 1_767_300_000_000;
  const tasks = [
    {
      id: "thread_dom_stability",
      threadId: "thread_dom_stability",
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      title: "DOM stability task",
      preview: "DOM stability task preview",
      cwd: "src",
      cwdPath: "src",
      relativeCwd: "",
      worktree: null,
      createdMs: now,
      updatedMs: now + 200,
      recencyMs: now + 200,
      lastEventSummary: "DOM stability task summary",
      unseen: true,
    },
    {
      id: "thread_dom_sibling",
      threadId: "thread_dom_sibling",
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      title: "DOM sibling task",
      preview: "DOM sibling task preview",
      cwd: "src",
      cwdPath: "src",
      relativeCwd: "",
      worktree: null,
      createdMs: now,
      updatedMs: now + 100,
      recencyMs: now + 100,
      lastEventSummary: "DOM sibling task summary",
      unseen: false,
    },
  ];
  let seenRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks, nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_dom_stability\/seen$/, (route) => {
    seenRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...tasks[0], unseen: false }),
    });
  });
  await page.route(/\/api\/tasks\/thread_dom_stability(?:\?|$)/, async (route) => {
    const task = { ...tasks[0], unseen: false };
    await page.evaluate((updatedTask) => {
      window.__taskListEventSource.emit("task-updated", updatedTask);
    }, task);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 1,
        task,
        events: [
          {
            id: "event_dom_stability",
            threadId: task.threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: { text: "DOM stability detail response" },
            createdMs: task.updatedMs,
          },
        ],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  const target = tasksPage.locator(
    '.task-row[data-thread-id="thread_dom_stability"]',
  );
  await expect(target.locator(".task-unseen-complete")).toBeVisible();
  await tasksPage.evaluate((element) => {
    const row = element.querySelector(
      '.task-row[data-thread-id="thread_dom_stability"]',
    );
    row.dataset.domProbe = "preserved";
    row.closest("li").dataset.domProbe = "preserved";
    window.__taskListDomProbe = {
      scroller: element.querySelector(".task-list-scroll"),
      list: row.closest(".task-list"),
      item: row.closest("li"),
      row,
    };
  });

  await target.click();
  await expect(page).toHaveURL("/tasks/thread_dom_stability");
  await expect(tasksPage.locator(".tasks-detail-pane")).toContainText(
    "DOM stability detail response",
  );

  const result = await tasksPage.evaluate((element) => {
    const row = element.querySelector(
      '.task-row[data-thread-id="thread_dom_stability"]',
    );
    const probe = window.__taskListDomProbe;
    return {
      scrollerPreserved: probe.scroller === element.querySelector(".task-list-scroll"),
      listPreserved: probe.list === row.closest(".task-list"),
      itemPreserved: probe.item === row.closest("li"),
      rowPreserved: probe.row === row,
      itemStatePreserved: row.closest("li").dataset.domProbe,
      rowStatePreserved: row.dataset.domProbe,
      selected: row.getAttribute("aria-current"),
      unseenIndicatorCount: row.querySelectorAll(".task-unseen-complete").length,
    };
  });
  expect({ ...result, seenRequests }).toEqual({
    scrollerPreserved: true,
    listPreserved: true,
    itemPreserved: true,
    rowPreserved: true,
    itemStatePreserved: "preserved",
    rowStatePreserved: "preserved",
    selected: "true",
    unseenIndicatorCount: 0,
    seenRequests: 0,
  });
});
test("groups Tasks by repository without worktree accordions", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        if (url.includes("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);
  const now = 1_767_300_000_000;
  const task = (threadId, title, worktree, updatedMs) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: worktree?.rootPath ?? "notes",
    cwdPath: worktree?.rootPath ?? "notes",
    relativeCwd: "",
    worktree,
    createdMs: now,
    updatedMs,
    recencyMs: updatedMs,
    lastEventSummary: `${title} summary`,
  });
  const tasks = [
    task(
      "thread_gluesql_feature",
      "Feature review",
      {
        rootPath: "worktrees/feature/gluesql",
        repositoryRootPath: "Workspace/rust/gluesql",
        branch: "feature/review",
        headSha: "2222222222222222222222222222222222222222",
        relativeCwd: "",
        linked: true,
      },
      now + 400,
    ),
    task(
      "thread_gluesql_main",
      "Main review",
      {
        rootPath: "Workspace/rust/gluesql",
        repositoryRootPath: "Workspace/rust/gluesql",
        branch: "main",
        headSha: "1111111111111111111111111111111111111111",
        relativeCwd: "",
        linked: false,
      },
      now + 300,
    ),
    task(
      "thread_caffold",
      "Caffold review",
      {
        rootPath: "Workspace/rust/codger",
        repositoryRootPath: "Workspace/rust/codger",
        branch: "main",
        headSha: "3333333333333333333333333333333333333333",
        relativeCwd: "",
        linked: false,
      },
      now + 200,
    ),
    task("thread_notes", "Notes task", null, now + 100),
  ];
  const detailEvents = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_gluesql_feature(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task: tasks[0],
        events: detailEvents,
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  const groups = tasksPage.locator(".task-repository-group");
  await expect(tasksPage.locator(".tasks-brand h1")).toHaveText("Caffold");
  await expect(tasksPage.locator(".tasks-brand-mark")).toHaveAttribute(
    "src",
    "/assets/icons/caffold-mark.svg",
  );
  await expect(
    tasksPage.locator('.tasks-header [data-task-action="open-settings"] svg'),
  ).toBeVisible();
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).locator(".task-repository-header")).toContainText("gluesql");
  await expect(groups.nth(0).locator(".task-repository-count")).toHaveText("2");
  await expect(groups.nth(0).locator(".task-row")).toHaveCount(2);
  await expect(groups.nth(1).locator(".task-repository-header")).toContainText("codger");
  await expect(groups.nth(2).locator(".task-repository-header")).toContainText("notes");
  await expect(tasksPage.locator('[data-task-action="toggle-task-group"]')).toHaveCount(0);
  await expect(
    groups.nth(0).locator('.task-row[data-thread-id="thread_gluesql_feature"] .task-row-worktree'),
  ).toHaveAttribute("title", /feature\/review/);
  const featureTask = groups.nth(0).locator(
    '.task-row[data-thread-id="thread_gluesql_feature"]',
  );
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-event", {
      threadId: "thread_gluesql_feature",
      revision: 2,
      event: {
        id: "live-running",
        threadId: "thread_gluesql_feature",
        type: "thread_status_changed",
        payload: { status: "running" },
        createdMs: Date.now(),
      },
    });
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  tasks[0] = {
    ...tasks[0],
    ...canonicalTaskState("active", {
      turnId: "turn_elsewhere",
      startedAtMs: now + 500,
      latestTurnStatus: "inProgress",
    }),
  };
  await page.evaluate((detail) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: 3,
      detail,
      reason: "canonical-running",
    });
  }, {
    threadId: "thread_gluesql_feature",
    syncState: "ready",
    task: tasks[0],
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "running");
  await expect(featureTask.locator(".task-status-spinner")).toBeVisible();
  detailEvents.push(
    {
      id: "external-user",
      threadId: "thread_gluesql_feature",
      type: "user_message",
      summary: "User prompt",
      payload: { text: "Continue this task from Codex desktop" },
      createdMs: now + 500,
    },
    {
      id: "external-reasoning",
      threadId: "thread_gluesql_feature",
      type: "reasoning",
      summary: "Reasoning",
      payload: { lifecycle: "started", summary: [], content: [] },
      createdMs: now + 750,
    },
  );
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-event", {
      threadId: "thread_gluesql_feature",
      revision: 4,
      event: {
        id: "live-idle",
        threadId: "thread_gluesql_feature",
        type: "thread_status_changed",
        payload: { status: "idle" },
        createdMs: Date.now(),
      },
    });
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "running");
  const idleTask = {
    ...tasks[0],
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    unseen: true,
  };
  await page.evaluate((detail) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: 5,
      detail,
      reason: "canonical-idle",
    });
  }, {
    threadId: "thread_gluesql_feature",
    syncState: "ready",
    task: idleTask,
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  await expect(featureTask.locator(".task-unseen-complete")).toBeVisible();
  await expect(featureTask.locator(".task-row-time")).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "tasks-completed-unseen");
  await featureTask.click();
  await expect(page).toHaveURL(/\/tasks\/thread_gluesql_feature$/);
  const externalActiveTurn = tasksPage.locator(
    '.task-turn-active[data-turn-id="implicit-0"]',
  );
  await expect(externalActiveTurn).toBeVisible();
  await expect(tasksPage.locator(".task-turn-active")).toHaveCount(1);
  await expect(externalActiveTurn.locator(".task-turn-active-state")).toHaveText(
    "Thinking",
  );
  await expect(featureTask.locator(".task-unseen-complete")).toHaveCount(0);
  await page.goto("/tasks");
  await expect(
    tasksPage.locator(
      '.task-row[data-thread-id="thread_gluesql_feature"] .task-unseen-complete',
    ),
  ).toHaveCount(0);
  await expect(tasksPage.locator('.task-row .task-status-label')).toHaveCount(0);
  await expect(tasksPage.locator(".task-row-summary")).toHaveCount(0);
  const treeLayout = await groups.nth(0).evaluate((group) => {
    const scroller = group.closest(".task-list-scroll");
    const header = group.querySelector(".task-repository-header");
    const headerIcon = header.querySelector(".task-repository-icon");
    const headerLabel = header.querySelector(".task-repository-label");
    const row = group.querySelector(".task-row");
    const rowTitle = row.querySelector(".task-row-title");
    return {
      bottomPadding: Number.parseFloat(getComputedStyle(scroller).paddingBottom),
      headerBackground: getComputedStyle(header).backgroundColor,
      rowBorderBottom: getComputedStyle(row).borderBottomWidth,
      rowTitleOffset: Math.round(
        rowTitle.getBoundingClientRect().left - headerLabel.getBoundingClientRect().left,
      ),
      titleIsIndentedPastIcon:
        rowTitle.getBoundingClientRect().left > headerIcon.getBoundingClientRect().left,
    };
  });
  expect(treeLayout.bottomPadding).toBeGreaterThanOrEqual(20);
  expect(treeLayout.headerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(treeLayout.rowBorderBottom).toBe("0px");
  expect(Math.abs(treeLayout.rowTitleOffset)).toBeLessThanOrEqual(4);
  expect(treeLayout.titleIsIndentedPastIcon).toBe(true);
  const secondGroupGap = await groups.nth(1).evaluate((group) =>
    Number.parseFloat(getComputedStyle(group).marginTop),
  );
  expect(secondGroupGap).toBeGreaterThanOrEqual(6);
  if (testInfo.project.name === "phone") {
    const newTaskButton = tasksPage.locator(
      '.tasks-header [data-task-action="open-new"]',
    );
    await expect(newTaskButton).toContainText("New Task");
    await expect
      .poll(() =>
        newTaskButton.evaluate((element) => element.getBoundingClientRect().width > 32),
      )
      .toBe(true);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-all-repository-groups");
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-removed", {
      threadId: "thread_notes",
      reason: "archived",
    });
  });
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_notes"]'),
  ).toHaveCount(0);
  await expect(groups).toHaveCount(2);
  await expect(
    tasksPage.locator('.task-repository-group[data-task-repository-key="directory:notes"]'),
  ).toHaveCount(0);
});
