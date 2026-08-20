import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockCodexModels,
  scrollTop,
  stabilizeDynamicText,
  taskPresentation,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

function expectedTaskRowHeight(projectName, rootFontSize) {
  return projectName === "desktop" ? rootFontSize * 2 : 36;
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function initialNavigatorTask(threadId, title, state = null) {
  const now = Date.now();
  return {
    id: threadId,
    threadId,
    ...(state ?? canonicalTaskState("idle", { latestTurnStatus: "completed" })),
    title,
    preview: `${title} preview`,
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: `${title} summary`,
  };
}

async function installInitialTaskListGates(page) {
  const activeStarted = deferred();
  const archivedStarted = deferred();
  const activeRelease = deferred();
  const archivedRelease = deferred();

  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    activeStarted.resolve();
    await route.fulfill(await activeRelease.promise);
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, async (route) => {
    archivedStarted.resolve();
    await route.fulfill(await archivedRelease.promise);
  });

  const response = (body, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  return {
    started: Promise.all([activeStarted.promise, archivedStarted.promise]),
    settleActive: (body, status) =>
      activeRelease.resolve(
        response(body?.tasks ? activeTaskProjection(body.tasks) : body, status),
      ),
    settleArchived: (body, status) =>
      archivedRelease.resolve(response(body, status)),
  };
}

test("mounts initial loading once and preserves settled Task DOM across refresh", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const initialTasks = deferred();
  const tasks = [
    initialNavigatorTask("thread_initial_dom_a", "Initial DOM Alpha"),
    initialNavigatorTask("thread_initial_dom_b", "Initial DOM Bravo"),
  ];
  let requestCount = 0;
  await page.addInitScript(() => {
    window.__taskLoadingMounts = 0;
    const countedLoadingMessages = new WeakSet();
    const countLoadingMessage = (message) => {
      if (countedLoadingMessages.has(message)) {
        return;
      }
      countedLoadingMessages.add(message);
      window.__taskLoadingMounts += 1;
    };
    const countLoadingMessages = (node) => {
      if (!(node instanceof Element)) {
        return;
      }
      if (node.matches(".task-section-message.task-section-loading")) {
        countLoadingMessage(node);
      }
      for (const message of node.querySelectorAll(
        ".task-section-message.task-section-loading",
      )) {
        countLoadingMessage(message);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          countLoadingMessages(node);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await initialTasks.promise;
    }
    await route.fulfill({ json: activeTaskProjection(tasks) });
  });

  await page.goto("/tasks");
  await expect(page.locator(".task-section-loading")).toHaveText("Loading...");
  await expect.poll(() => page.evaluate(() => window.__taskLoadingMounts)).toBe(1);
  initialTasks.resolve();

  const list = page.locator("caffold-active-task-list");
  await expect(
    list.locator('.task-row[data-thread-id="thread_initial_dom_a"]'),
  ).toBeVisible();
  await list.evaluate((element) => {
    const group = element.querySelector(
      '.task-repository-group[data-task-repository-key="fixture-section-1"]',
    );
    element.__settledDom = {
      group,
      section: group.querySelector(":scope > caffold-active-task-section"),
      header: group.querySelector(":scope > caffold-active-task-section > .task-repository-header"),
      label: group.querySelector(
        ":scope > caffold-active-task-section > .task-repository-header > .task-repository-select > .task-repository-label",
      ),
      count: group.querySelector(
        ":scope > caffold-active-task-section > .task-repository-header > .task-repository-count",
      ),
      rows: [...group.querySelectorAll(":scope > caffold-active-task-section > .task-list > li")],
      components: [
        ...group.querySelectorAll(
          ":scope > caffold-active-task-section > .task-list > li > caffold-active-task-row",
        ),
      ],
    };
  });
  await list.evaluate((element) => element.loadTasks({ force: true }));
  await expect.poll(() => requestCount).toBe(2);
  await expect(list.evaluate((element) => {
    const group = element.querySelector(
      '.task-repository-group[data-task-repository-key="fixture-section-1"]',
    );
    const settled = element.__settledDom;
    const rows = [...group.querySelectorAll(":scope > caffold-active-task-section > .task-list > li")];
    const components = [
      ...group.querySelectorAll(
        ":scope > caffold-active-task-section > .task-list > li > caffold-active-task-row",
      ),
    ];
    return {
      group: group === settled.group,
      section: group.querySelector(":scope > caffold-active-task-section") ===
        settled.section,
      header: group.querySelector(":scope > caffold-active-task-section > .task-repository-header") ===
        settled.header,
      label: group.querySelector(
        ":scope > caffold-active-task-section > .task-repository-header > .task-repository-select > .task-repository-label",
      ) === settled.label,
      count: group.querySelector(
        ":scope > caffold-active-task-section > .task-repository-header > .task-repository-count",
      ) === settled.count,
      rows: rows.every((row, index) => row === settled.rows[index]),
      components: components.every(
        (component, index) => component === settled.components[index],
      ),
    };
  })).resolves.toEqual({
    group: true,
    section: true,
    header: true,
    label: true,
    count: true,
    rows: true,
    components: true,
  });
});

test("retains an initial Archived result without revealing it before active Tasks settle", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const activeTask = initialNavigatorTask("thread_initial_active", "Initial active Task");
  const archivedTask = initialNavigatorTask(
    "thread_initial_archived",
    "Initial archived Task",
  );
  const gates = await installInitialTaskListGates(page);

  await page.goto("/tasks");
  await gates.started;
  const navigator = page.locator("caffold-task-navigator");
  const archivedList = navigator.locator("caffold-archived-task-list");
  await expect(navigator.locator(".task-list-section")).toHaveCount(1);
  await expect(navigator.getByText("Loading...", { exact: true })).toHaveCount(1);
  await expect(navigator.getByRole("button", { name: "New Task" })).toBeVisible();

  gates.settleArchived({ tasks: [archivedTask], nextCursor: null });
  await expect.poll(() =>
    archivedList.evaluate((element) => element.initialRequestSettled),
  ).toBe(true);
  await expect(
    navigator.locator('.task-list-section[data-task-section="archived"]'),
  ).toHaveCount(0);
  await expect(navigator.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(navigator.getByText("Loading...", { exact: true })).toHaveCount(1);

  gates.settleActive({ tasks: [activeTask], nextCursor: null });
  await expect(navigator).toContainText("Initial active Task");
  await expect(navigator).toContainText("Initial archived Task");
  await expect(navigator.locator(".task-list-section")).toHaveCount(2);
  await expect(navigator.getByText("Loading...", { exact: true })).toHaveCount(0);
});

test("shows active Tasks first and appends a settled Archived section without replacing active DOM", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const activeTask = initialNavigatorTask(
    "thread_active_first",
    "Active result first",
    canonicalTaskState("active", {
      turnId: "turn_active_first",
      startedAtMs: Date.now(),
      latestTurnStatus: "inProgress",
    }),
  );
  const gates = await installInitialTaskListGates(page);

  await page.goto("/tasks");
  await gates.started;
  const navigator = page.locator("caffold-task-navigator");
  gates.settleActive({ tasks: [activeTask], nextCursor: null });
  const activeRow = navigator.locator(
    '.task-row[data-thread-id="thread_active_first"]',
  );
  await expect(activeRow).toBeVisible();
  await expect(activeRow.locator(".task-status-spinner")).toBeVisible();
  await expect(
    navigator.locator('.task-list-section[data-task-section="archived"]'),
  ).toHaveCount(0);
  await activeRow.evaluate((row) => {
    window.__initialActiveRow = row;
    window.__initialActiveSpinner = row.querySelector(".task-status-spinner");
  });

  gates.settleArchived({ tasks: [], nextCursor: null });
  const archivedSection = navigator.locator(
    '.task-list-section[data-task-section="archived"]',
  );
  await expect(archivedSection).toBeVisible();
  await expect(archivedSection.locator(".task-list-section-count")).toHaveText("0");
  await expect(archivedSection).toContainText("No archived Caffold tasks.");
  expect(await activeRow.evaluate((row) =>
    row === window.__initialActiveRow &&
    row.querySelector(".task-status-spinner") === window.__initialActiveSpinner,
  )).toBe(true);
});

test("reveals confirmed empty active and Archived states only after both initial requests settle", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const gates = await installInitialTaskListGates(page);

  await page.goto("/tasks");
  await gates.started;
  const navigator = page.locator("caffold-task-navigator");
  gates.settleArchived({ tasks: [], nextCursor: null });
  await expect.poll(() =>
    navigator.locator("caffold-archived-task-list").evaluate(
      (element) => element.initialRequestSettled,
    ),
  ).toBe(true);
  await expect(navigator.getByText("Archived", { exact: true })).toHaveCount(0);

  gates.settleActive({ tasks: [], nextCursor: null });
  await expect(navigator).toContainText("No Caffold tasks yet.");
  const archivedSection = navigator.locator(
    '.task-list-section[data-task-section="archived"]',
  );
  await expect(archivedSection).toContainText("No archived Caffold tasks.");
  await expect(archivedSection.locator(".task-list-section-count")).toHaveText("0");
});

test("holds an initial Archived failure until active Tasks settle", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const activeTask = initialNavigatorTask(
    "thread_active_after_archive_failure",
    "Active after Archived failure",
  );
  const gates = await installInitialTaskListGates(page);

  await page.goto("/tasks");
  await gates.started;
  const navigator = page.locator("caffold-task-navigator");
  gates.settleArchived({ error: "Archived list unavailable" }, 503);
  await expect.poll(() =>
    navigator.locator("caffold-archived-task-list").evaluate(
      (element) => element.initialRequestSettled,
    ),
  ).toBe(true);
  await expect(navigator.getByRole("alert")).toHaveCount(0);
  await expect(navigator.getByText("Archived", { exact: true })).toHaveCount(0);

  gates.settleActive({ tasks: [activeTask], nextCursor: null });
  await expect(navigator).toContainText("Active after Archived failure");
  const archivedSection = navigator.locator(
    '.task-list-section[data-task-section="archived"]',
  );
  await expect(archivedSection.getByRole("alert")).toContainText(
    "Archived list unavailable",
  );
  await expect(
    archivedSection.getByRole("button", { name: "Retry" }),
  ).toBeVisible();
});

test("shows an initial active failure immediately and reveals Archived after it settles", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const archivedTask = initialNavigatorTask(
    "thread_archived_after_active_failure",
    "Archived after active failure",
  );
  const gates = await installInitialTaskListGates(page);

  await page.goto("/tasks");
  await gates.started;
  const navigator = page.locator("caffold-task-navigator");
  gates.settleActive({ error: "Active list unavailable" }, 503);
  const activeSection = navigator.locator(
    '.task-list-section[data-task-section="managed"]',
  );
  await expect(activeSection.getByRole("alert")).toContainText(
    "Active list unavailable",
  );
  await expect(
    activeSection.getByRole("button", { name: "Retry" }),
  ).toBeVisible();
  await expect(navigator.getByText("Archived", { exact: true })).toHaveCount(0);

  gates.settleArchived({ tasks: [archivedTask], nextCursor: null });
  const archivedSection = navigator.locator(
    '.task-list-section[data-task-section="archived"]',
  );
  await expect(archivedSection).toContainText("Archived after active failure");
  await expect(activeSection.getByRole("alert")).toContainText(
    "Active list unavailable",
  );
});

test("keeps settled list sections visible during later parallel refreshes", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const activeTask = initialNavigatorTask(
    "thread_refresh_active",
    "Retained active refresh row",
  );
  const archivedTask = initialNavigatorTask(
    "thread_refresh_archived",
    "Retained Archived refresh row",
  );
  const activeRefreshStarted = deferred();
  const archivedRefreshStarted = deferred();
  const activeRefreshRelease = deferred();
  const archivedRefreshRelease = deferred();
  let activeReads = 0;
  let archivedReads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    activeReads += 1;
    if (activeReads === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeTaskProjection([activeTask])),
      });
    }
    activeRefreshStarted.resolve();
    await activeRefreshRelease.promise;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([activeTask])),
    });
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, async (route) => {
    archivedReads += 1;
    if (archivedReads === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [archivedTask], nextCursor: null }),
      });
    }
    archivedRefreshStarted.resolve();
    await archivedRefreshRelease.promise;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [archivedTask], nextCursor: null }),
    });
  });

  await page.goto("/tasks");
  const navigator = page.locator("caffold-task-navigator");
  await expect(navigator).toContainText("Retained active refresh row");
  await expect(navigator).toContainText("Retained Archived refresh row");
  await navigator.evaluate((element) => {
    void element.activate({ force: true });
  });
  await Promise.all([
    activeRefreshStarted.promise,
    archivedRefreshStarted.promise,
  ]);

  await expect(navigator.locator(".task-list-section")).toHaveCount(2);
  await expect(navigator).toContainText("Retained active refresh row");
  await expect(navigator).toContainText("Retained Archived refresh row");
  await expect(navigator.getByText("Loading...", { exact: true })).toHaveCount(0);

  activeRefreshRelease.resolve();
  archivedRefreshRelease.resolve();
  await expect.poll(() => activeReads).toBe(2);
  await expect.poll(() => archivedReads).toBe(2);
});

test("renders the backend-exhausted Active projection without cursor paging", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);

  const task = (threadId, title, updatedMs, worktree = null) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "frontend/tests/e2e/fixtures/home",
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
        activeTaskProjection([
          task("thread-page-1", "Newest paged task", 20),
          task("thread-page-2", "Older paged task", 10),
        ]),
      ),
    });
  });

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-task-workspace");
  await expect(tasksPage.locator(".task-row")).toHaveCount(2);
  await expect(tasksPage).toContainText("Newest paged task");
  await expect(tasksPage).toContainText("Older paged task");
  await expect(tasksPage.getByRole("button", { name: "Load more tasks" })).toHaveCount(0);
  expect(cursors).toEqual([null]);
});

test("refreshes persisted identity and order without replacing runtime status", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, {
    sourceKey: "__taskListRefreshSource",
    autoOpen: true,
  });
  await mockCodexModels(page);
  const first = initialNavigatorTask(
    "thread_order_first",
    "First ordered Task",
    canonicalTaskState("active", {
      turnId: "turn_order_first",
      latestTurnStatus: "inProgress",
    }),
  );
  const second = initialNavigatorTask(
    "thread_order_second",
    "Second ordered Task",
  );
  const refreshedFirst = {
    ...first,
    ...canonicalTaskState("notLoaded"),
    title: "Renamed first Task",
    conversationAvailable: false,
  };
  const refreshedSecond = {
    ...second,
    ...canonicalTaskState("notLoaded"),
    conversationAvailable: false,
  };
  let reads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    reads += 1;
    return route.fulfill({
      json: activeTaskProjection(
        reads === 1
          ? [first, second]
          : [refreshedSecond, refreshedFirst],
      ),
    });
  });

  await page.goto("/tasks");
  const rows = page.locator(
    'caffold-task-navigator .task-row[data-thread-id]',
  );
  await expect(rows.nth(0)).toHaveAttribute("data-thread-id", first.threadId);

  await page.evaluate(() => {
    window.__taskListRefreshSource.emit("task-list-refresh", {});
  });

  await expect.poll(() => reads).toBe(2);
  await expect(rows.nth(0)).toHaveAttribute("data-thread-id", second.threadId);
  const firstRow = page.locator(
    `caffold-task-navigator .task-row[data-thread-id="${first.threadId}"]`,
  );
  await expect(firstRow.locator(".task-row-title")).toHaveText(
    "Renamed first Task",
  );
  await expect(firstRow).toHaveAttribute("data-task-status", "running");
  await expect(firstRow.locator(".task-status-spinner")).toBeVisible();
  await expect(
    page.locator(
      `caffold-task-navigator .task-row[data-thread-id="${second.threadId}"]`,
    ),
  ).toHaveAttribute("data-task-status", "idle");
});

test("hydrates a cached Task with the task-list stream bootstrap snapshot", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, {
    sourceKey: "__taskListBootstrapSource",
    autoOpen: true,
  });
  await mockCodexModels(page);
  const cached = initialNavigatorTask(
    "thread_list_bootstrap",
    "Persisted navigator name",
    canonicalTaskState("notLoaded"),
  );
  const cachedSecond = initialNavigatorTask(
    "thread_list_bootstrap_second",
    "Second persisted name",
    canonicalTaskState("notLoaded"),
  );
  cached.conversationAvailable = false;
  cachedSecond.conversationAvailable = false;
  let reads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    reads += 1;
    return route.fulfill({
      json: activeTaskProjection([cached, cachedSecond]),
    });
  });

  await page.goto("/tasks");
  const row = page.locator(
    'caffold-task-navigator .task-row[data-thread-id="thread_list_bootstrap"]',
  );
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute("data-task-status", "running");
  await expect(row.locator(".task-status-spinner")).toHaveCount(0);

  const running = {
    ...cached,
    ...canonicalTaskState("active", {
      turnId: "turn_list_bootstrap",
      startedAtMs: Date.now(),
      latestTurnStatus: "inProgress",
    }),
    conversationAvailable: true,
  };
  const idleSecond = {
    ...cachedSecond,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    conversationAvailable: true,
  };
  await page.evaluate(({ task, idleSecond }) => {
    window.__taskListBootstrapSource.emit("task-list-snapshot", {
      tasks: [
        task,
        idleSecond,
        { ...task, threadId: "unmanaged-thread", id: "unmanaged-thread" },
      ],
    });
  }, { task: running, idleSecond });

  await expect(row).toHaveAttribute("data-task-status", "running");
  await expect(row.locator(".task-status-spinner")).toBeVisible();
  await expect(row.locator(".task-row-title")).toHaveText(
    "Persisted navigator name",
  );
  const secondRow = page.locator(
    'caffold-task-navigator .task-row[data-thread-id="thread_list_bootstrap_second"]',
  );
  await expect(secondRow).toHaveAttribute("data-task-status", "idle");
  await expect(secondRow.locator(".task-row-title")).toHaveText(
    "Second persisted name",
  );
  await expect(
    page.locator(
      'caffold-task-navigator .task-row[data-thread-id="unmanaged-thread"]',
    ),
  ).toHaveCount(0);

  await page.evaluate(() => {
    const previous = window.__taskListBootstrapSource;
    document.querySelector("caffold-active-task-list").retryStream();
    window.__previousTaskListBootstrapSource = previous;
  });
  await expect.poll(() =>
    page.evaluate(() =>
      window.__taskListBootstrapSource !==
      window.__previousTaskListBootstrapSource
    ),
  ).toBe(true);
  await page.evaluate((task) => {
    window.__taskListBootstrapSource.emit("task-list-snapshot", {
      tasks: [task],
    });
  }, idleSecond);

  await expect(secondRow).toHaveAttribute("data-task-status", "idle");
  expect(reads).toBe(1);
});

test("applies canonical top placements without list refetches or duplicate reordering", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, {
    sourceKey: "__activePlacementSource",
    autoOpen: true,
  });
  await mockCodexModels(page);
  const existing = initialNavigatorTask(
    "thread_placement_existing",
    "Existing placed Task",
  );
  const existingOther = {
    ...initialNavigatorTask(
      "thread_placement_existing_other",
      "Existing Task in another Section",
    ),
    cwd: "frontend/tests/e2e/fixtures/other",
    cwdPath: "frontend/tests/e2e/fixtures/other",
  };
  const first = initialNavigatorTask(
    "thread_placement_first",
    "First placed Task",
    canonicalTaskState("active", {
      turnId: "turn_placement_first",
      latestTurnStatus: "inProgress",
    }),
  );
  const second = initialNavigatorTask(
    "thread_placement_second",
    "Second placed Task",
  );
  const newSectionTask = {
    ...initialNavigatorTask(
      "thread_placement_new_section",
      "Task in newly placed Section",
    ),
    cwd: "frontend/tests/e2e/fixtures/new-section",
    cwdPath: "frontend/tests/e2e/fixtures/new-section",
  };
  let reads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    reads += 1;
    return route.fulfill({ json: activeTaskProjection([existing, existingOther]) });
  });

  await page.goto("/tasks");
  const rows = page.locator(
    'caffold-task-navigator .task-row[data-thread-id]',
  );
  await expect(rows).toHaveCount(2);

  await page.evaluate((unknown) => {
    window.__activePlacementSource.emit("task-sync", {
      threadId: unknown.threadId,
      revision: 1,
      task: unknown,
    });
  }, initialNavigatorTask("thread_unknown_sync", "Unknown sync Task"));
  await page.waitForTimeout(100);
  expect(reads).toBe(1);

  const firstPlacement = {
    section: {
      id: "fixture-section-1",
      name: "frontend/tests/e2e/fixtures/home",
      repository: false,
    },
    beforeThreadId: existing.threadId,
    beforeSectionId: "fixture-section-2",
  };
  await page.evaluate(({ first, firstPlacement }) => {
    window.__activePlacementSource.emit("task-placed-at-top", {
      task: first,
      placement: firstPlacement,
    });
  }, { first, firstPlacement });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-thread-id", first.threadId);

  await page.evaluate(({ first, second, firstPlacement }) => {
    window.__activePlacementSource.emit("task-sync", {
      threadId: first.threadId,
      revision: 2,
      task: { ...first, title: "First placed Task updated" },
    });
    window.__activePlacementSource.emit("task-placed-at-top", {
      task: second,
      placement: {
        ...firstPlacement,
        beforeThreadId: first.threadId,
      },
    });
    window.__activePlacementSource.emit("task-placed-at-top", {
      task: first,
      placement: firstPlacement,
    });
  }, { first, second, firstPlacement });

  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute("data-thread-id", second.threadId);
  await expect(rows.nth(1)).toHaveAttribute("data-thread-id", first.threadId);
  await expect(rows.nth(1)).toContainText("First placed Task");
  await page.evaluate((task) => {
    window.__activePlacementSource.emit("task-placed-at-top", {
      task,
      placement: {
        section: {
          id: "fixture-section-new",
          name: "frontend/tests/e2e/fixtures/new-section",
          repository: false,
        },
        beforeThreadId: null,
        beforeSectionId: "fixture-section-2",
      },
    });
  }, newSectionTask);
  await expect(rows).toHaveCount(5);
  await expect.poll(() =>
    page.locator(
      "caffold-active-task-list .task-repository-group:not([data-task-recovery])",
    ).evaluateAll((groups) =>
      groups.map((group) => group.dataset.taskRepositoryKey)
    )
  ).toEqual([
    "fixture-section-1",
    "fixture-section-new",
    "fixture-section-2",
  ]);
  await page.evaluate((task) => {
    const item = document.querySelector(
      `li[data-thread-id="${CSS.escape(task.threadId)}"]`,
    );
    window.__transferredTaskItem = item;
    window.__activePlacementSource.emit("task-placed-at-top", {
      task,
      placement: {
        section: {
          id: "fixture-section-1",
          name: "frontend/tests/e2e/fixtures/home",
          repository: false,
        },
        beforeThreadId: null,
        beforeSectionId: "fixture-section-new",
      },
    });
  }, existingOther);
  await expect(rows).toHaveCount(5);
  await expect.poll(() => page.evaluate((threadId) => {
    const item = document.querySelector(
      `li[data-thread-id="${CSS.escape(threadId)}"]`,
    );
    return {
      itemPreserved: item === window.__transferredTaskItem,
      sectionId: item?.closest(".task-repository-group")
        ?.dataset.taskRepositoryKey,
    };
  }, existingOther.threadId)).toEqual({
    itemPreserved: true,
    sectionId: "fixture-section-1",
  });
  await page.waitForTimeout(100);
  expect(reads).toBe(1);
});

test("shows relative age from the latest completion instead of thread recency", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const now = Date.now();
  const lastCompletedMs = now - 5 * 60 * 1_000;
  const task = {
    id: "thread-completion-age",
    threadId: "thread-completion-age",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Completion age",
    preview: "Completion age",
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: now - 3 * 60 * 60 * 1_000,
    updatedMs: now - 2 * 60 * 60 * 1_000,
    recencyMs: now - 2 * 60 * 60 * 1_000,
    lastCompletedMs,
    lastEventSummary: "Completed recently",
    unseen: false,
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );

  await page.goto("/tasks");

  const time = page.locator(
    '.task-row[data-thread-id="thread-completion-age"] .task-row-time',
  );
  await expect(time).toHaveText("5m");
  await expect(time).toHaveAttribute("datetime", new Date(lastCompletedMs).toISOString());
});

test("keeps Task row indicator columns aligned across worktree and meta states", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__indicatorEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);
  const minute = 60_000;
  const hour = 60 * minute;
  const month = 30 * 24 * hour;
  const now = Date.now();
  const worktree = {
    rootPath: "frontend/tests/e2e/fixtures/home/.caffold-worktrees/indicator-columns",
    repositoryRootPath: "frontend/tests/e2e/fixtures/home",
    branch: "fix/task-navigator-indicator-columns",
    headSha: "1111111111111111111111111111111111111111",
    relativeCwd: "",
    linked: true,
  };
  const task = ({
    threadId,
    title,
    elapsed,
    state = canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    linked = true,
    unseen = false,
  }) => ({
    id: threadId,
    threadId,
    ...state,
    title,
    preview: `${title} preview`,
    cwd: worktree.rootPath,
    cwdPath: worktree.rootPath,
    relativeCwd: "",
    worktree: { ...worktree, linked },
    createdMs: now - elapsed,
    updatedMs: now - elapsed,
    recencyMs: now - elapsed,
    lastCompletedMs: now - elapsed,
    lastEventSummary: `${title} summary`,
    unseen,
  });
  const tasks = [
    task({
      threadId: "thread_indicator_11_months",
      title: "Three-character month age",
      elapsed: 11 * month,
    }),
    task({
      threadId: "thread_indicator_1_hour",
      title: "Short hour age",
      elapsed: hour,
    }),
    task({
      threadId: "thread_indicator_running",
      title: "Running status",
      elapsed: minute,
      state: canonicalTaskState("active", {
        turnId: "turn_indicator_running",
        startedAtMs: now - minute,
        latestTurnStatus: "inProgress",
      }),
    }),
    task({
      threadId: "thread_indicator_unseen",
      title: "Unseen completion",
      elapsed: 2 * hour,
      unseen: true,
    }),
    task({
      threadId: "thread_indicator_approval",
      title: "Approval status",
      elapsed: 3 * hour,
      state: canonicalTaskState("active", {
        activeFlags: ["waitingOnApproval"],
        latestTurnStatus: "inProgress",
      }),
    }),
    task({
      threadId: "thread_indicator_failed",
      title: "Failed status",
      elapsed: 4 * hour,
      state: canonicalTaskState("systemError", { latestTurnStatus: "failed" }),
    }),
    task({
      threadId: "thread_indicator_unlinked",
      title: "Unlinked worktree",
      elapsed: 23 * hour,
      linked: false,
    }),
  ];
  const recoveryTask = {
    ...task({
      threadId: "thread_indicator_recovery",
      title: "Recovery status",
      elapsed: 5 * hour,
    }),
    conversationAvailable: false,
    recovery: { reason: "threadMissing" },
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks, [recoveryTask])),
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );

  await page.goto("/tasks");
  const rows = page.locator("caffold-active-task-list .task-row");
  await expect(rows).toHaveCount(8);
  await expect(
    page.locator(
      '[data-thread-id="thread_indicator_11_months"] .task-row-time',
    ),
  ).toHaveText("11M");
  await expect(
    page.locator(
      '[data-thread-id="thread_indicator_11_months"] .task-row-time',
    ),
  ).toHaveAttribute("aria-label", "11 months ago");
  await expect(
    page.locator(
      '[data-thread-id="thread_indicator_unlinked"] .task-row-worktree',
    ),
  ).toHaveCount(0);

  const layout = await rows.evaluateAll((elements) =>
    elements.map((row) => {
      const indicators = row.querySelector(":scope > .task-row-indicators");
      const worktreeIndicator = indicators.querySelector(
        ":scope > .task-row-worktree",
      );
      const meta = indicators.querySelector(
        ":scope > .task-row-meta, :scope > .task-row-recovery-status",
      );
      const rowBounds = row.getBoundingClientRect();
      const indicatorBounds = indicators.getBoundingClientRect();
      const worktreeBounds = worktreeIndicator?.getBoundingClientRect();
      const metaBounds = meta.getBoundingClientRect();
      const countBounds = row
        .closest(".task-repository-group")
        .querySelector(
          ":scope > caffold-active-task-section > .task-repository-header > .task-repository-count",
        )
        .getBoundingClientRect();
      return {
        countCenter: countBounds.left + countBounds.width / 2,
        display: getComputedStyle(indicators).display,
        hasHorizontalOverflow: row.scrollWidth > row.clientWidth,
        indicatorWidth: indicatorBounds.width,
        metaCenter: metaBounds.left + metaBounds.width / 2,
        threadId: row.dataset.threadId,
        titleWidth: row.querySelector(".task-row-title").getBoundingClientRect().width,
        worktreeLeft: worktreeBounds?.left ?? null,
        worktreeOutsideRow:
          worktreeBounds != null &&
          (worktreeBounds.left < rowBounds.left || worktreeBounds.right > rowBounds.right),
      };
    }),
  );
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const baseline = layout.find(
    ({ threadId }) => threadId === "thread_indicator_11_months",
  );
  expect(baseline.worktreeLeft).not.toBeNull();
  for (const metrics of layout) {
    expect(metrics.display).toBe("grid");
    expect(metrics.indicatorWidth).toBeCloseTo(rootFontSize * 3, 1);
    expect(metrics.metaCenter).toBeCloseTo(baseline.metaCenter, 1);
    expect(Math.abs(metrics.countCenter - baseline.metaCenter)).toBeLessThanOrEqual(1);
    expect(metrics.hasHorizontalOverflow).toBe(false);
    expect(metrics.worktreeOutsideRow).toBe(false);
    if (metrics.worktreeLeft != null) {
      expect(metrics.worktreeLeft).toBeCloseTo(baseline.worktreeLeft, 1);
    }
  }
  expect(new Set(layout.map(({ titleWidth }) => Math.round(titleWidth))).size).toBe(1);
  await captureReviewScreenshot(page, testInfo, "tasks-indicator-columns");

  const updatedAgeTask = {
    ...tasks[0],
    updatedMs: now - month,
    recencyMs: now - month,
    lastCompletedMs: now - month,
  };
  await page.evaluate(() => {
    window.__indicatorAgeNode = document.querySelector(
      '[data-thread-id="thread_indicator_11_months"] .task-row-time',
    );
  });
  await page.evaluate((updatedTask) => {
    const source = window.__indicatorEventSources.find(({ url }) =>
      url.includes("/api/tasks/stream"),
    );
    source.emit("task-updated", updatedTask);
  }, updatedAgeTask);
  const updatedTime = page.locator(
    '[data-thread-id="thread_indicator_11_months"] .task-row-time',
  );
  await expect(updatedTime).toHaveText("1M");
  await expect(updatedTime).toHaveAttribute("aria-label", "1 month ago");
  expect(
    await updatedTime.evaluate((element) => window.__indicatorAgeNode === element),
  ).toBe(true);
});

test("keeps Archived Task indicator columns aligned with unavailable warning actions", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const hour = 60 * 60_000;
  const month = 30 * 24 * hour;
  const now = Date.now();
  const worktree = {
    rootPath: "frontend/tests/e2e/fixtures/home/.caffold-worktrees/archived-indicator-columns",
    repositoryRootPath: "frontend/tests/e2e/fixtures/home",
    branch: "archive/task-navigator-indicator-columns",
    headSha: "2222222222222222222222222222222222222222",
    relativeCwd: "",
    linked: true,
  };
  const archivedTask = (threadId, title, elapsed, overrides = {}) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: worktree.rootPath,
    cwdPath: worktree.rootPath,
    relativeCwd: "",
    worktree: { ...worktree, linked: overrides.linked ?? true },
    createdMs: now - elapsed,
    updatedMs: now - elapsed,
    recencyMs: now - elapsed,
    lastCompletedMs: now - elapsed,
    lastEventSummary: `${title} summary`,
    unseen: false,
    ...overrides,
  });
  const archivedTasks = [
    archivedTask(
      "thread_archived_indicator_11_months",
      "Archived three-character month age",
      11 * month,
    ),
    archivedTask(
      "thread_archived_indicator_1_hour",
      "Archived short hour age",
      hour,
    ),
    archivedTask(
      "thread_archived_indicator_unlinked",
      "Archived unlinked worktree",
      23 * hour,
      { linked: false },
    ),
    archivedTask(
      "thread_archived_indicator_unavailable",
      "Archived unavailable conversation",
      2 * hour,
      { conversationAvailable: false, linked: false },
    ),
  ];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([])),
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: archivedTasks, nextCursor: null }),
    }),
  );

  await page.goto("/tasks");
  const archivedRows = page.locator(
    "caffold-archived-task-list .task-archived-row",
  );
  await expect(archivedRows).toHaveCount(4);
  await expect(
    page.locator(
      '[data-thread-id="thread_archived_indicator_11_months"] .task-row-time',
    ),
  ).toHaveText("11M");

  await expect(
    page.locator(
      '[data-thread-id="thread_archived_indicator_unavailable"] .task-row-time',
    ),
  ).toHaveText("2h");

  const layout = await archivedRows.evaluateAll((elements) =>
    elements.map((row) => {
      const indicators = row.querySelector(".task-row-indicators");
      const worktreeBounds = indicators
        .querySelector(":scope > .task-row-worktree")
        ?.getBoundingClientRect();
      const metaBounds = indicators
        .querySelector(":scope > .task-row-meta")
        .getBoundingClientRect();
      return {
        actionWidth: row
          .querySelector(".task-archived-actions")
          .getBoundingClientRect().width,
        display: getComputedStyle(indicators).display,
        hasHorizontalOverflow: row.scrollWidth > row.clientWidth,
        indicatorWidth: indicators.getBoundingClientRect().width,
        metaCenter: metaBounds.left + metaBounds.width / 2,
        threadId: row.dataset.threadId,
        titleWidth: row
          .querySelector(".task-row-title")
          .getBoundingClientRect().width,
        worktreeLeft: worktreeBounds?.left ?? null,
      };
    }),
  );
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const baseline = layout.find(
    ({ threadId }) => threadId === "thread_archived_indicator_11_months",
  );
  expect(baseline.worktreeLeft).not.toBeNull();
  for (const metrics of layout) {
    expect(metrics.display).toBe("grid");
    expect(metrics.indicatorWidth).toBeCloseTo(rootFontSize * 3, 1);
    expect(metrics.metaCenter).toBeCloseTo(baseline.metaCenter, 1);
    expect(metrics.hasHorizontalOverflow).toBe(false);
    if (metrics.worktreeLeft != null) {
      expect(metrics.worktreeLeft).toBeCloseTo(baseline.worktreeLeft, 1);
    }
  }
  expect(new Set(layout.map(({ actionWidth }) => actionWidth)).size).toBe(1);
  expect(new Set(layout.map(({ titleWidth }) => Math.round(titleWidth))).size).toBe(1);
  const unavailableRow = page.locator(
    '[data-thread-id="thread_archived_indicator_unavailable"]',
  );
  await expect(
    unavailableRow.getByRole("img", {
      name: "Conversation unavailable; restore is not available",
    }),
  ).toBeVisible();
  await expect(
    unavailableRow.getByRole("button", { name: /Restore/ }),
  ).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "tasks-archived-indicator-columns");
});

test("starts active Task navigator spinners at independent phases", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const now = Date.now();
  const tasks = ["alpha", "bravo", "charlie"].map((suffix, index) => ({
    id: `thread_spinner_${suffix}`,
    threadId: `thread_spinner_${suffix}`,
    ...canonicalTaskState("active", {
      turnId: `turn_spinner_${suffix}`,
      startedAtMs: now - index * 1_000,
      latestTurnStatus: "inProgress",
    }),
    title: `Running spinner ${suffix}`,
    preview: `Running spinner ${suffix}`,
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: now - index * 1_000,
    updatedMs: now - index * 1_000,
    recencyMs: now - index * 1_000,
    lastEventSummary: `Running ${suffix}`,
    unseen: false,
  }));
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    }),
  );
  await page.route(/\/api\/tasks\/thread_spinner_alpha(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 1,
        threadId: tasks[0].threadId,
        syncState: "ready",
        task: tasks[0],
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.goto("/tasks/thread_spinner_alpha");
  await emitTaskDetailBootstrap(page, {
    revision: 1,
    threadId: tasks[0].threadId,
    syncState: "ready",
    task: tasks[0],
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  const navigatorSpinners = page.locator(
    'caffold-task-navigator .task-row[data-task-status="running"] .task-status-spinner',
  );
  const spinnerPhases = () => navigatorSpinners.evaluateAll((elements) =>
    elements
      .map((spinner) => {
        const row = spinner.closest(".task-row");
        const style = getComputedStyle(spinner);
        return {
          animationDelay: style.animationDelay,
          animationDuration: style.animationDuration,
          animationName: style.animationName,
          phase: spinner.style.animationDelay,
          threadId: row.dataset.threadId,
        };
      })
      .sort((left, right) => left.threadId.localeCompare(right.threadId)),
  );

  await expect(navigatorSpinners).toHaveCount(3);
  const initial = await spinnerPhases();
  for (const spinner of initial) {
    expect(spinner.animationName).toBe("task-status-spin");
    expect(spinner.animationDuration).toBe("0.8s");
    expect(Number.parseFloat(spinner.animationDelay)).toBeLessThan(0);
    expect(Number.parseFloat(spinner.animationDelay)).toBeGreaterThan(-0.8);
    expect(spinner.phase).toMatch(/^-\d+(?:\.\d+)?ms$/);
  }
  expect(new Set(initial.map(({ phase }) => phase)).size).toBe(3);

  const detailSpinner = page.locator(
    ".task-detail-info-button .task-status-spinner",
  );
  await expect(detailSpinner).toHaveCount(1);
  await expect(detailSpinner).toHaveCSS("animation-delay", "0s");
});

test("keeps unseen completion markers blinking, phase-shifted, and motion-safe", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const now = Date.now();
  const tasks = ["alpha", "bravo", "charlie"].map((suffix, index) => ({
    id: `thread-unseen-${suffix}`,
    threadId: `thread-unseen-${suffix}`,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: `Unseen completion ${suffix}`,
    preview: `Unseen completion ${suffix}`,
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: now - index * 1_000,
    updatedMs: now - index * 1_000,
    recencyMs: now - index * 1_000,
    lastCompletedMs: now - index * 1_000,
    lastEventSummary: `Completed ${suffix}`,
    unseen: true,
  }));
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    }),
  );

  await page.goto("/tasks");
  const markers = page.locator(".task-unseen-complete");
  await expect(markers).toHaveCount(3);
  const animated = await markers.evaluateAll((elements) =>
    elements.map((element) => {
      const marker = getComputedStyle(element, "::before");
      return {
        animationName: marker.animationName,
        backgroundColor: marker.backgroundColor,
        delay: marker.animationDelay,
        duration: marker.animationDuration,
        phase: element.style.getPropertyValue("--task-unseen-attention-delay"),
      };
    }),
  );
  for (const marker of animated) {
    expect(marker).toEqual(
      expect.objectContaining({
        animationName: "task-unseen-complete-blink",
        backgroundColor: "rgb(22, 124, 92)",
        duration: "2.4s",
      }),
    );
  }
  expect(new Set(animated.map(({ delay }) => delay)).size).toBe(3);
  expect(new Set(animated.map(({ phase }) => phase)).size).toBe(3);
  await captureReviewScreenshot(page, testInfo, "tasks-unseen-attention");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const staticMarkers = await markers.evaluateAll((elements) =>
    elements.map((element) => {
      const marker = getComputedStyle(element, "::before");
      return {
        animationName: marker.animationName,
        backgroundColor: marker.backgroundColor,
        opacity: marker.opacity,
      };
    }),
  );
  for (const marker of staticMarkers) {
    expect(marker).toEqual(
      expect.objectContaining({
        animationName: "none",
        backgroundColor: "rgb(22, 124, 92)",
        opacity: "1",
      }),
    );
  }
  await captureReviewScreenshot(page, testInfo, "tasks-unseen-attention-reduced-motion");
});

test("archives and restores an idle Caffold task through the grouped Archived section", { tag: "@all-viewports" }, async ({
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
    cwd: "frontend/tests/e2e/fixtures/home/project",
    cwdPath: "frontend/tests/e2e/fixtures/home/project",
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
    rootPath: "frontend/tests/e2e/fixtures/home/project",
    repositoryRootPath: "frontend/tests/e2e/fixtures/home/project",
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
  let releaseRestore;
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const activeDetail = {
    threadId: activeTask.threadId,
    syncState: "ready",
    revision: 1,
    task: activeTask,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: archivedTasks, nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(activeTasks)),
    }),
  );
  await page.route(/\/api\/tasks\/thread_archive(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeDetail),
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
  await page.route(/\/api\/tasks\/thread_archive\/restore$/, async (route) => {
    mutations.push("restore");
    await restoreGate;
    activeTasks = [activeTask];
    archivedTasks = [existingArchivedTask];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task: activeTask,
        activeTopPlacement: {
          section: {
            id: "fixture-section-1",
            name: "frontend/tests/e2e/fixtures/home/project",
            repository: false,
          },
        },
      }),
    });
  });

  await page.goto("/tasks/thread_archive");
  await emitTaskDetailBootstrap(page, activeDetail);
  const navigator = page.locator("caffold-task-navigator");
  await expect(navigator.locator(".task-list-section")).toHaveCount(2);
  await expect(navigator.locator(".task-list-section-header h2")).toHaveText([
    "Archived",
  ]);
  const workspaceBrand = navigator.locator("caffold-workspace-brand");
  await expect(workspaceBrand.locator(".workspace-brand-title")).toHaveText(
    "Caffold",
  );
  await expect(workspaceBrand.locator(".workspace-brand-icon")).toHaveAttribute(
    "src",
    "/assets/icons/favicon-32.png",
  );
  await expect(
    navigator.locator('.task-list-section[data-task-section="managed"]'),
  ).toHaveAttribute("aria-label", "Caffold Tasks");
  const headerTypography = await page.evaluate(() => {
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const navigatorTitle = document.querySelector(
      "caffold-task-navigator .workspace-brand-title",
    );
    const detailTitle = document.querySelector(".task-detail-heading > h2");
    const brandIcon = document.querySelector(
      "caffold-task-navigator .workspace-brand-icon",
    );
    return {
      rootFontSize,
      navigatorTitleSize: Number.parseFloat(
        getComputedStyle(navigatorTitle).fontSize,
      ),
      detailTitleSize: Number.parseFloat(getComputedStyle(detailTitle).fontSize),
      brandIconWidth: Number.parseFloat(getComputedStyle(brandIcon).width),
    };
  });
  expect(headerTypography.navigatorTitleSize).toBeCloseTo(
    headerTypography.rootFontSize * 0.8125,
    2,
  );
  expect(headerTypography.detailTitleSize).toBeCloseTo(
    headerTypography.navigatorTitleSize,
    2,
  );
  expect(headerTypography.brandIconWidth).toBeCloseTo(
    headerTypography.rootFontSize * 1.25,
    2,
  );
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
  const archivedGroup = archivedSection.locator(".task-repository-group").first();
  await expect(archivedGroup.locator(".task-archived-row").first()).toBeVisible();
  const archivedTreeLayout = await archivedGroup
    .evaluate((group) => {
      const icon = group.querySelector(".task-repository-icon");
      const row = group.querySelector(".task-archived-row");
      const title = group.querySelector(".task-row-title");
      const restoreButton = group.querySelector(
        ".task-archived-action-button:not(.task-delete-button)",
      );
      const rowBounds = row.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      const restoreBounds = restoreButton.getBoundingClientRect();
      return {
        restoreButtonHeight: restoreBounds.height,
        rootFontSize: Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ),
        rowHeight: rowBounds.height,
        restoreCenterDelta: Math.abs(
          restoreBounds.top + restoreBounds.height / 2 -
            (rowBounds.top + rowBounds.height / 2),
        ),
        titleCenterDelta: Math.abs(
          titleBounds.top + titleBounds.height / 2 -
            (rowBounds.top + rowBounds.height / 2),
        ),
        titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
        titleInset:
          titleBounds.left - group.getBoundingClientRect().left,
        titleOffsetFromIcon:
          titleBounds.left - icon.getBoundingClientRect().left,
      };
    });
  const expectedArchivedRowHeight = expectedTaskRowHeight(
    testInfo.project.name,
    archivedTreeLayout.rootFontSize,
  );
  expect(archivedTreeLayout.rowHeight).toBeCloseTo(expectedArchivedRowHeight, 1);
  expect(archivedTreeLayout.restoreButtonHeight).toBeCloseTo(
    expectedArchivedRowHeight,
    1,
  );
  expect(archivedTreeLayout.titleFontSize).toBeCloseTo(
    archivedTreeLayout.rootFontSize * 0.8125,
    2,
  );
  expect(archivedTreeLayout.restoreCenterDelta).toBeLessThanOrEqual(0.5);
  expect(archivedTreeLayout.titleCenterDelta).toBeLessThanOrEqual(0.5);
  expect(archivedTreeLayout.titleInset).toBeCloseTo(
    archivedTreeLayout.rootFontSize,
    1,
  );
  expect(archivedTreeLayout.titleOffsetFromIcon).toBeGreaterThan(0);
  expect(archivedTreeLayout.titleOffsetFromIcon).toBeLessThanOrEqual(5);
  await captureReviewScreenshot(page, testInfo, "tasks-archived-section");
  const restoreButton = archivedSection.getByRole("button", {
    name: "Restore Archive round trip",
  });
  await expect(restoreButton.locator(".task-archived-action-icon")).toBeVisible();
  await restoreButton.click();
  const restoringButton = archivedSection.getByRole("button", {
    name: "Restoring Archive round trip",
  });
  await expect(restoringButton).toBeDisabled();
  await expect(restoringButton).toHaveClass(/is-loading/);
  await expect(restoringButton.locator(".task-archived-action-icon")).toBeVisible();
  releaseRestore();

  await expect(
    navigator.locator('.task-list-section[data-task-section="managed"]'),
  ).toContainText("Archive round trip");
  await expect(archivedSection).not.toContainText("Archive round trip");
  expect(
    requestedPaths.filter((path) => path === "/api/tasks"),
  ).toHaveLength(2);
  expect(mutations).toEqual(["archive", "restore"]);
});

test("keeps an idle task active when the archive request fails", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_archive_failure",
    threadId: "thread_archive_failure",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Archive failure stays active",
    preview: "Archive failure fixture",
    cwd: "frontend/tests/e2e/fixtures/home/project",
    cwdPath: "frontend/tests/e2e/fixtures/home/project",
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: "Archive failure fixture",
    unseen: false,
  };
  const detail = {
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
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
      body: JSON.stringify(detail),
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
  await emitTaskDetailBootstrap(page, detail);
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

test("keeps a task archived when restore fails", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_restore_failure",
    threadId: "thread_restore_failure",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Restore failure stays archived",
    preview: "Restore failure fixture",
    cwd: "frontend/tests/e2e/fixtures/home/project",
    cwdPath: "frontend/tests/e2e/fixtures/home/project",
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
      body: JSON.stringify(activeTaskProjection()),
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
  await expect(
    archivedSection.getByRole("button", {
      name: "Retry restoring Restore failure stays archived",
    }),
  ).toBeVisible();
  await expect(archivedSection).toContainText("Restore failure stays archived");
  await expect(
    page.locator(
      'caffold-task-navigator .task-list-section[data-task-section="managed"]',
    ),
  ).not.toContainText("Restore failure stays archived");
});

test("does not offer archive while the canonical task is active", { tag: "@all-viewports" }, async ({ page }) => {
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
    cwd: "frontend/tests/e2e/fixtures/home/project",
    cwdPath: "frontend/tests/e2e/fixtures/home/project",
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: "Active archive guard",
    unseen: false,
  };
  const detail = {
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(/\/api\/tasks\/thread_active_archive(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );

  await page.goto("/tasks/thread_active_archive");
  await emitTaskDetailBootstrap(page, detail);
  await page.getByRole("button", { name: /Task details/ }).click();

  await expect(page.getByRole("button", { name: "Archive task" })).toBeDisabled();
});

test("keeps cached task rows visible when a list refresh fails", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page, {
    sourceKey: "__taskListEventSource",
    autoOpen: true,
  });
  await mockCodexModels(page);

  const task = {
    id: "thread_stale_list",
    threadId: "thread_stale_list",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Must survive failed reload",
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
  let failTaskReads = false;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskReads += 1;
    if (!failTaskReads) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeTaskProjection([task])),
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
  await expect(navigator).toContainText("Must survive failed reload");
  const readsBeforeFailure = taskReads;
  failTaskReads = true;
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-list-refresh", {});
  });

  await expect(navigator).toContainText("Must survive failed reload");
  const recoveryNotice = page.locator(".app-foreground-recovery");
  await expect(recoveryNotice).toHaveAttribute(
    "data-recovery-state",
    "unavailable",
  );
  await expect(recoveryNotice).toContainText("Caffold server unavailable.");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
  await expect(navigator.getByRole("button", { name: "Retry" })).toHaveCount(0);
  expect(taskReads).toBe(readsBeforeFailure + 1);
});
test("uses a global grouped Tasks master-detail list", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await installEventSourceMock(page, {
    bootstrapFunctionKey: "__groupedNavigatorDetailBootstrap",
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
  const detailFor = (task) => ({
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    task,
    events: [
      {
        id: `event_${task.threadId}`,
        threadId: task.threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: `${task.title} detail response` },
        createdMs: task.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  await page.exposeFunction(
    "__groupedNavigatorDetailBootstrap",
    (threadId) => {
      const task = tasks.find((candidate) => candidate.threadId === threadId);
      return task ? detailFor(task) : null;
    },
  );

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
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
      body: JSON.stringify(detailFor(task)),
    });
  });

  await page.goto("/tasks?cwd=src");
  await expect(page).toHaveURL("/");
  const tasksPage = page.locator("caffold-task-workspace");
  const listPane = tasksPage.locator(".task-workspace-master-pane");
  const detailPane = tasksPage.locator(".tasks-detail-pane");
  const resizer = tasksPage.locator(".task-workspace-master-resizer");
  const workspaceNavigation = page.locator(
    "caffold-task-workspace .task-workspace-navigation",
  );
  const rows = tasksPage.locator(".task-row");
  const managedHeader = tasksPage.locator(".task-list-primary-header");
  const archivedHeader = tasksPage.locator(
    '.task-list-section[data-task-section="archived"] .task-list-section-header',
  );
  const newTaskButton = managedHeader.getByRole("button", {
    name: "New Task",
  });

  await expect(tasksPage.locator(".task-repository-group")).toHaveCount(2);
  await expect(rows).toHaveCount(4);
  await expect(newTaskButton).toBeVisible();
  await expect(
    managedHeader.locator(":scope > caffold-workspace-brand"),
  ).toContainText("Caffold");
  const brandIconMetrics = await managedHeader
    .locator(".workspace-brand-icon")
    .evaluate((icon) => {
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const style = getComputedStyle(icon);
      return {
        rootFontSize,
        width: Number.parseFloat(style.width),
        offsetY: new DOMMatrixReadOnly(style.transform).m42,
      };
    });
  expect(brandIconMetrics.width).toBeCloseTo(
    brandIconMetrics.rootFontSize * 1.25,
    2,
  );
  expect(brandIconMetrics.offsetY).toBeCloseTo(
    brandIconMetrics.rootFontSize * -0.0625,
    2,
  );
  await expect(archivedHeader.locator(":scope > span")).toHaveText("0");
  const headerActionAlignment = await tasksPage.evaluate(() => {
    const button = document.querySelector(".task-list-new-task");
    const header = button.closest(".task-list-section-header");
    const headerBounds = header.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    const buttonPaint = getComputedStyle(button, "::before");
    const icon = button.querySelector(".task-action-icon");
    const iconBounds = icon.getBoundingClientRect();
    const iconSize = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--interface-icon-size",
      ),
    ) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const topInset =
      buttonBounds.top + Number.parseFloat(buttonPaint.top) - headerBounds.top;
    const rightInset =
      headerBounds.right -
      (buttonBounds.right - Number.parseFloat(buttonPaint.right));
    return {
      edgeInsetDelta: Math.abs(topInset - rightInset),
      iconWidthDelta: Math.abs(iconBounds.width - iconSize),
      iconHeightDelta: Math.abs(iconBounds.height - iconSize),
    };
  });
  expect(headerActionAlignment.edgeInsetDelta).toBeLessThanOrEqual(1);
  expect(headerActionAlignment.iconWidthDelta).toBeLessThanOrEqual(0.1);
  expect(headerActionAlignment.iconHeightDelta).toBeLessThanOrEqual(0.1);
  await expect(rows.nth(0)).toContainText("Main root task");
  await expect(rows.nth(1)).toContainText("Main core task");
  await expect(rows.nth(2)).toContainText("Feature worktree task");
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
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderRadius: "999px",
        borderWidth: "0px",
        color: "rgb(74, 74, 74)",
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
      const rowBounds = element.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      const indicatorBounds = indicators.getBoundingClientRect();
      return {
        height: rowBounds.height,
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        indicatorCenterDelta: Math.abs(
          indicatorBounds.top + indicatorBounds.height / 2 -
            (rowBounds.top + rowBounds.height / 2),
        ),
        indicatorWidth: Math.round(indicatorBounds.width),
        titleCenterDelta: Math.abs(
          titleBounds.top + titleBounds.height / 2 -
            (rowBounds.top + rowBounds.height / 2),
        ),
        titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
        titleWidth: Math.round(titleBounds.width),
      };
    }),
  );
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const expectedRowHeight = expectedTaskRowHeight(testInfo.project.name, rootFontSize);
  expect(
    rowLayout.every(({ height }) => Math.abs(height - expectedRowHeight) <= 0.1),
  ).toBe(true);
  expect(
    rowLayout.every(
      ({ titleFontSize }) =>
        Math.abs(titleFontSize - rootFontSize * 0.8125) <= 0.01,
    ),
  ).toBe(true);
  expect(rowLayout.every(({ titleCenterDelta }) => titleCenterDelta <= 0.5)).toBe(true);
  expect(
    rowLayout.every(({ indicatorCenterDelta }) => indicatorCenterDelta <= 0.5),
  ).toBe(true);
  expect(new Set(rowLayout.map(({ titleWidth }) => titleWidth)).size).toBe(1);
  expect(new Set(rowLayout.map(({ indicatorWidth }) => indicatorWidth))).toEqual(
    new Set([Math.round(rootFontSize * 3)]),
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
  expect(longTitleLayout.isTruncated).toBe(true);
  const taskScrollerPresentation = await tasksPage
    .locator(".task-list-scroll")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const webkitScrollbar = getComputedStyle(element, "::-webkit-scrollbar");
      return {
        overflowY: style.overflowY,
        scrollbarWidth: style.scrollbarWidth,
        webkitScrollbarDisplay: webkitScrollbar.display,
      };
    });
  expect(taskScrollerPresentation).toEqual({
    overflowY: "auto",
    scrollbarWidth: "none",
    webkitScrollbarDisplay: "none",
  });

  if (testInfo.project.name !== "phone") {
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeVisible();
    await expect(resizer).toBeVisible();
    await expect(tasksPage.locator('textarea[name="prompt"]')).toBeVisible();
    const initialLayout = await tasksPage.evaluate((element) => {
      const list = element
        .querySelector(".task-workspace-master-pane")
        .getBoundingClientRect();
      const detail = element.querySelector(".tasks-detail-pane").getBoundingClientRect();
      const separator = element
        .querySelector(".task-workspace-master-resizer")
        .getBoundingClientRect();
      return {
        detailOffsetFromList: detail.left - list.right,
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        listWidth: list.width,
        separatorCenterOffsetFromList:
          separator.left + separator.width / 2 - list.right,
        separatorWidth: separator.width,
      };
    });
    expect(initialLayout.detailOffsetFromList).toBe(0);
    expect(initialLayout.hasHorizontalOverflow).toBe(false);
    expect(Math.round(initialLayout.listWidth)).toBe(380);
    expect(initialLayout.separatorCenterOffsetFromList).toBe(0);
    expect(Math.round(initialLayout.separatorWidth)).toBe(6);
    const homeHeaderHeight = await managedHeader.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
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
    const resizedNavigationLayout = await tasksPage.evaluate((element) => {
      const list = element.querySelector(".task-workspace-master-pane");
      const navigation = list.querySelector(
        "caffold-task-workspace-navigation",
      );
      const listRect = list.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      return {
        ownedByList: navigation.parentElement === list,
        listWidth: Math.round(listRect.width),
        navigationMatchesListContent:
          Math.abs(navigationRect.width - list.clientWidth) <= 1,
        navigationEndsWithList:
          Math.abs(navigationRect.bottom - listRect.bottom) <= 1,
      };
    });
    expect(resizedNavigationLayout).toEqual({
      ownedByList: true,
      listWidth: 296,
      navigationMatchesListContent: true,
      navigationEndsWithList: true,
    });
    await expect(workspaceNavigation).toBeVisible();

    const listScrollBeforeSelection = await tasksPage.evaluate(() => {
      const scroller = document.querySelector(
        "caffold-task-navigator .task-list-scroll",
      );
      scroller.style.height = "90px";
      scroller.scrollTop = 40;
      scroller.querySelector(
        '.task-list-section[data-task-section="managed"] .task-list',
      ).dataset.domProbe = "preserved";
      const row = document.querySelector(
        'caffold-task-navigator .task-row[data-thread-id="thread_main_core"]',
      );
      row.dataset.domProbe = "preserved";
      row.closest("li").dataset.domProbe = "preserved";
      return scroller.scrollTop;
    });
    expect(listScrollBeforeSelection).toBeGreaterThan(0);
    await tasksPage.evaluate(() =>
      document
        .querySelector('caffold-task-navigator .task-row[data-thread-id="thread_main_root"]')
        .click(),
    );
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(listPane).toBeVisible();
    await expect(detailPane).toContainText("Main root task detail response");
    await expect(
      tasksPage.locator('.task-row[data-thread-id="thread_main_root"]'),
    ).toHaveAttribute("aria-current", "true");
    const selectedRowLayout = await tasksPage.evaluate(() => {
      const navigator = document.querySelector("caffold-task-navigator");
      const selected = navigator.querySelector(
        '.task-row[data-thread-id="thread_main_root"]',
      );
      const peer = navigator.querySelector(
        '.task-row[data-thread-id="thread_main_core"]',
      );
      const navigatorRect = navigator.getBoundingClientRect();
      const selectedRect = selected.getBoundingClientRect();
      const selectedTitleRect = selected
        .querySelector(".task-row-title")
        .getBoundingClientRect();
      const selectedIndicatorsRect = selected
        .querySelector(".task-row-indicators")
        .getBoundingClientRect();
      const peerTitleRect = peer
        .querySelector(".task-row-title")
        .getBoundingClientRect();
      return {
        indicatorGap: selectedIndicatorsRect.left - selectedTitleRect.right,
        indicatorWidth: selectedIndicatorsRect.width,
        leftInset: selectedRect.left - navigatorRect.left,
        titleOffset: selectedTitleRect.left - peerTitleRect.left,
      };
    });
    expect(selectedRowLayout.indicatorGap).toBeCloseTo(rootFontSize * 0.25, 1);
    expect(selectedRowLayout.indicatorWidth).toBeCloseTo(rootFontSize * 3, 1);
    expect(selectedRowLayout.leftInset).toBeCloseTo(0, 1);
    expect(selectedRowLayout.titleOffset).toBeCloseTo(0, 1);
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
    await expect(
      tasksPage.locator(
        'caffold-task-detail-summary [data-task-action="open-new"]',
      ),
    ).toHaveCount(0);
    const detailHeaderHeight = await managedHeader.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(detailHeaderHeight).toBeCloseTo(homeHeaderHeight, 1);

    await newTaskButton.click();
    await expect(page).toHaveURL("/tasks/new?cwd=src");
    await expect(listPane).toBeVisible();
    await expect(detailPane.locator(".task-new-form")).toBeVisible();
    await expect(resizer).toHaveAttribute("aria-valuenow", "296");
    const newTaskHeaderHeight = await managedHeader.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(newTaskHeaderHeight).toBeCloseTo(homeHeaderHeight, 1);
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
    await page.locator("caffold-task-workspace .task-workspace-back").click();
    await expect(page).toHaveURL("/");
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeHidden();
  }
});

test("switches Tasks to master-detail at the Fold8 landscape boundary", { tag: "@all-viewports" }, async ({
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
      body: JSON.stringify(activeTaskProjection([task])),
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
  const tasksPage = page.locator("caffold-task-workspace");
  const listPane = tasksPage.locator(".task-workspace-master-pane");
  const detailPane = tasksPage.locator(".tasks-detail-pane");
  const resizer = tasksPage.locator(".task-workspace-master-resizer");
  await expect(listPane).toBeHidden();
  await expect(detailPane).toBeVisible();
  await expect(resizer).toBeHidden();

  await page.setViewportSize({ width: 900, height: 704 });
  await expect(listPane).toBeVisible();
  await expect(detailPane).toBeVisible();
  await expect(resizer).toBeVisible();
  const layout = await tasksPage.evaluate((element) => {
    const list = element
      .querySelector(".task-workspace-master-pane")
      .getBoundingClientRect();
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
test("keeps the Tasks list DOM stable while opening a managed task", { tag: "@all-viewports" }, async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__caffoldRegisterTaskSseSource?.(this);
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
  const selectedTask = { ...tasks[0], unseen: false };
  const selectedDetail = {
    threadId: selectedTask.threadId,
    syncState: "ready",
    revision: 1,
    task: tasks[0],
    events: [
      {
        id: "event_dom_stability",
        threadId: selectedTask.threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "DOM stability detail response" },
        createdMs: selectedTask.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
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
    await page.evaluate((updatedTask) => {
      window.__taskListEventSource.emit("task-updated", updatedTask);
    }, selectedTask);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(selectedDetail),
    });
  });

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-task-workspace");
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
  await page.evaluate((updatedTask) => {
    window.__taskListEventSource.emit("task-updated", updatedTask);
  }, selectedTask);
  await emitTaskDetailBootstrap(page, selectedDetail);
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
    seenRequests: 1,
  });
});
test("patches Task rows in place without reordering and preserves a running spinner", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, {
    registryKey: "__taskDomEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);

  const now = 1_767_300_000_000;
  const worktree = {
    rootPath: "worktrees/spinner-stability/caffold",
    repositoryRootPath: "Workspace/rust/caffold",
    branch: "fix/task-navigator-spinner-stability",
    headSha: "1111111111111111111111111111111111111111",
    relativeCwd: "",
    linked: false,
  };
  const runningTask = {
    id: "thread_spinner_stability",
    threadId: "thread_spinner_stability",
    ...canonicalTaskState("active", {
      turnId: "turn_spinner_stability",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Spinner stability",
    preview: "Spinner stability preview",
    cwd: worktree.rootPath,
    cwdPath: worktree.rootPath,
    relativeCwd: "",
    worktree,
    createdMs: now,
    updatedMs: now + 100,
    recencyMs: now + 100,
    lastEventSummary: "Running",
    unseen: false,
  };
  const siblingTask = {
    id: "thread_spinner_sibling",
    threadId: "thread_spinner_sibling",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Spinner sibling",
    preview: "Spinner sibling preview",
    cwd: worktree.rootPath,
    cwdPath: worktree.rootPath,
    relativeCwd: "",
    worktree: { ...worktree, linked: true },
    createdMs: now,
    updatedMs: now + 200,
    recencyMs: now + 200,
    lastCompletedMs: now + 200,
    lastEventSummary: "Completed",
    unseen: false,
  };
  const tasks = [siblingTask, runningTask];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    }),
  );
  await page.route(/\/api\/tasks\/thread_spinner_stability(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 1,
        threadId: runningTask.threadId,
        syncState: "ready",
        task: runningTask,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.goto("/tasks/thread_spinner_stability");
  await emitTaskDetailBootstrap(page, {
    revision: 1,
    threadId: runningTask.threadId,
    syncState: "ready",
    task: runningTask,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  const tasksPage = page.locator("caffold-task-workspace");
  const target = tasksPage.locator(
    '.task-row[data-thread-id="thread_spinner_stability"]',
  );
  await expect(target.locator(".task-status-spinner")).toHaveCount(1);
  await tasksPage.evaluate((element) => {
    const row = element.querySelector(
      '.task-row[data-thread-id="thread_spinner_stability"]',
    );
    const item = row.closest("li");
    const records = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(item, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    window.__taskDomProbe = {
      item,
      row,
      spinner: row.querySelector(".task-status-spinner"),
      observer,
      records,
    };
  });

  await page.evaluate((task) => {
    const detailSource = window.__taskDomEventSources.find(
      ({ url }) =>
        url.includes("/api/tasks/thread_spinner_stability/stream"),
    );
    const listSource = window.__taskDomEventSources.find(({ url }) =>
      url.includes("/api/tasks/stream"),
    );
    detailSource.emit("task-sync", {
      threadId: task.threadId,
      revision: 2,
      detail: {
        revision: 2,
        threadId: task.threadId,
        syncState: "ready",
        task,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      },
      reason: "canonical-repeat",
    });
    listSource.emit("task-updated", task);
  }, runningTask);
  await tasksPage.evaluate((element) => {
    const navigator = element.querySelector("caffold-task-navigator");
    navigator.setStreamState("connecting");
    navigator.setStreamState("ready");
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

  expect(
    await tasksPage.evaluate((element) => {
      const row = element.querySelector(
        '.task-row[data-thread-id="thread_spinner_stability"]',
      );
      return {
        itemPreserved: window.__taskDomProbe.item === row.closest("li"),
        mutationCount: window.__taskDomProbe.records.length,
        rowPreserved: window.__taskDomProbe.row === row,
        spinnerPreserved:
          window.__taskDomProbe.spinner === row.querySelector(".task-status-spinner"),
      };
    }),
  ).toEqual({
    itemPreserved: true,
    mutationCount: 0,
    rowPreserved: true,
    spinnerPreserved: true,
  });

  await page.evaluate((task) => {
    const listSource = window.__taskDomEventSources.find(({ url }) =>
      url.includes("/api/tasks/stream"),
    );
    listSource.emit("task-updated", {
      ...task,
      title: "Updated sibling",
    });
  }, siblingTask);
  await expect(
    tasksPage.locator(
      '.task-row[data-thread-id="thread_spinner_sibling"] .task-row-title',
    ),
  ).toHaveText("Updated sibling");
  expect(
    await tasksPage.evaluate((element) => {
      const row = element.querySelector(
        '.task-row[data-thread-id="thread_spinner_stability"]',
      );
      return {
        rowPreserved: window.__taskDomProbe.row === row,
        spinnerPreserved:
          window.__taskDomProbe.spinner === row.querySelector(".task-status-spinner"),
      };
    }),
  ).toEqual({ rowPreserved: true, spinnerPreserved: true });

  const updatedRunningTask = {
    ...runningTask,
    title: "Updated spinner stability",
    worktree: { ...worktree, linked: true },
    updatedMs: now + 300,
    recencyMs: now + 300,
  };
  await page.evaluate((task) => {
    const listSource = window.__taskDomEventSources.find(({ url }) =>
      url.includes("/api/tasks/stream"),
    );
    listSource.emit("task-updated", task);
  }, updatedRunningTask);
  await expect(target).toHaveAttribute("title", "Updated spinner stability");
  await expect(target.locator(".task-row-worktree")).toHaveCount(1);
  await expect(
    tasksPage.locator('.task-list .task-row[data-thread-id]').first(),
  ).toHaveAttribute("data-thread-id", "thread_spinner_sibling");
  expect(
    await tasksPage.evaluate((element) => {
      const row = element.querySelector(
        '.task-row[data-thread-id="thread_spinner_stability"]',
      );
      return {
        rowPreserved: window.__taskDomProbe.row === row,
        spinnerPreserved:
          window.__taskDomProbe.spinner === row.querySelector(".task-status-spinner"),
      };
    }),
  ).toEqual({ rowPreserved: true, spinnerPreserved: true });

  const idleTask = {
    ...updatedRunningTask,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    lastCompletedMs: now + 400,
    unseen: true,
  };
  await page.evaluate((task) => {
    const listSource = window.__taskDomEventSources.find(({ url }) =>
      url.includes("/api/tasks/stream"),
    );
    listSource.emit("task-updated", task);
  }, idleTask);
  await expect(target).toHaveAttribute("data-task-status", "idle");
  await expect(target).not.toHaveAttribute("aria-busy", "true");
  await expect(target.locator(".task-status-spinner")).toHaveCount(0);
  await expect(target.locator(".task-unseen-complete")).toHaveCount(0);
  expect(
    await tasksPage.evaluate((element) => {
      const row = element.querySelector(
        '.task-row[data-thread-id="thread_spinner_stability"]',
      );
      window.__taskDomProbe.observer.disconnect();
      return window.__taskDomProbe.row === row;
    }),
  ).toBe(true);
});
test("groups Tasks by repository without worktree accordions", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__caffoldRegisterTaskSseSource?.(this);
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
      body: JSON.stringify(activeTaskProjection(tasks)),
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
  const tasksPage = page.locator("caffold-task-workspace");
  const groups = tasksPage.locator(".task-repository-group");
  await expect(tasksPage.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "home",
  );
  await expect(
    page.locator(
      'caffold-task-workspace .task-workspace-navigation [data-workspace-mode="settings"] svg',
    ),
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
  await page.evaluate((task) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId: task.threadId,
      revision: 3,
      task,
    });
  }, tasks[0]);
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
      payload: { summary: [], content: [] },
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
  await page.evaluate((task) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId: task.threadId,
      revision: 5,
      task,
    });
  }, idleTask);
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  await expect(featureTask.locator(".task-unseen-complete")).toBeVisible();
  await expect(featureTask.locator(".task-row-time")).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "tasks-completed-unseen");
  await featureTask.click();
  await emitTaskDetailBootstrap(page, {
    threadId: "thread_gluesql_feature",
    syncState: "ready",
    revision: 1,
    task: tasks[0],
    events: detailEvents,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
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
  if (testInfo.project.name !== "phone") {
    await tasksPage.getByRole("button", { name: "New Task" }).click();
    await expect(page).toHaveURL(
      "/tasks/new?cwd=Workspace%2Frust%2Fgluesql",
    );
  }
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
    const nextGroup = group.nextElementSibling;
    const lastRowTitle = group.querySelector(".task-list > li:last-child .task-row-title");
    const nextHeaderLabel = nextGroup.querySelector(".task-repository-label");
    return {
      bottomPadding: Number.parseFloat(getComputedStyle(scroller).paddingBottom),
      betweenGroupTextGap:
        nextHeaderLabel.getBoundingClientRect().top -
        lastRowTitle.getBoundingClientRect().bottom,
      headerBackground: getComputedStyle(header).backgroundColor,
      headerHeight: header.getBoundingClientRect().height,
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      rowBorderBottom: getComputedStyle(row).borderBottomWidth,
      rowHeight: row.getBoundingClientRect().height,
      rowTitleInset:
        rowTitle.getBoundingClientRect().left - group.getBoundingClientRect().left,
      rowTitleOffsetFromIcon:
        rowTitle.getBoundingClientRect().left - headerIcon.getBoundingClientRect().left,
      titleIsIndentedPastIcon:
        rowTitle.getBoundingClientRect().left > headerIcon.getBoundingClientRect().left,
      withinGroupTextGap:
        rowTitle.getBoundingClientRect().top -
        headerLabel.getBoundingClientRect().bottom,
    };
  });
  expect(treeLayout.bottomPadding).toBeGreaterThanOrEqual(20);
  expect(treeLayout.headerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(Math.abs(treeLayout.headerHeight - treeLayout.rowHeight)).toBeLessThanOrEqual(
    0.6,
  );
  expect(treeLayout.rowBorderBottom).toBe("0px");
  expect(treeLayout.rowTitleInset).toBeCloseTo(treeLayout.rootFontSize, 1);
  expect(treeLayout.rowTitleOffsetFromIcon).toBeGreaterThan(0);
  expect(treeLayout.rowTitleOffsetFromIcon).toBeLessThanOrEqual(5);
  expect(treeLayout.titleIsIndentedPastIcon).toBe(true);
  expect(treeLayout.betweenGroupTextGap).toBeGreaterThan(
    treeLayout.withinGroupTextGap + treeLayout.rootFontSize * 0.5,
  );
  const secondGroupGap = await groups.nth(1).evaluate((group) =>
    Number.parseFloat(getComputedStyle(group).marginTop),
  );
  expect(secondGroupGap).toBeCloseTo(treeLayout.rootFontSize, 1);
  if (testInfo.project.name === "phone") {
    await expect(tasksPage.locator(".task-workspace-master-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-detail-pane")).toBeHidden();
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
