import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__recoveryEventSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
});

function task(threadId, title, conversationAvailable = true) {
  const now = 1_767_190_400_000;
  return {
    id: threadId,
    threadId,
    conversationAvailable,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
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
    unseen: false,
  };
}

function recoveryTask(threadId, title, reason, actions) {
  return {
    ...task(threadId, title, false),
    recovery: { reason, actions },
  };
}

function taskDetail(taskRecord) {
  return {
    threadId: taskRecord.threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task: taskRecord,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
    model: "gpt-test",
    reasoningEffort: "medium",
    fastMode: false,
  };
}

async function installRecoveryList(page, recovery, state = {}) {
  state.projection ??= activeTaskProjection([], [recovery]);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: state.projection }),
  );
  return state;
}

async function openRecovery(page, recovery) {
  await page.goto("/tasks");
  const row = page.locator(
    `.task-row[data-thread-id="${recovery.threadId}"]`,
  );
  await expect(row).toBeVisible();
  await expect(row.locator(".task-row-recovery-icon")).toBeVisible();
  await expect(row.locator(".task-row-recovery-reason")).toHaveCount(0);
  await row.click();
  await expect(page).toHaveURL(
    new RegExp(`/tasks/${recovery.threadId}/recovery$`),
  );
  await expect(page.locator("caffold-task-recovery")).toBeVisible();
}

async function emitTaskListEvent(page, type, payload) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__recoveryEventSources.some((source) =>
          source.url.startsWith("/api/tasks/stream") && source.readyState !== 2
        )
      )
    )
    .toBe(true);
  await page.evaluate(({ eventType, eventPayload }) => {
    const source = [...window.__recoveryEventSources]
      .reverse()
      .find((candidate) =>
        candidate.url.startsWith("/api/tasks/stream") && candidate.readyState !== 2
      );
    source.emit(eventType, eventPayload);
  }, { eventType: type, eventPayload: payload });
}

test("opens archived-in-Codex recovery without opening ordinary Task detail and restores it", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_restore";
  const recovery = recoveryTask(
    threadId,
    "Archived recovery Task",
    "codexArchived",
    ["restoreToActive", "moveToArchived", "recheck"],
  );
  const restored = task(threadId, "Restored recovery Task");
  await installRecoveryList(page, recovery);
  let detailReads = 0;
  let restoreCalls = 0;
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: taskDetail(restored) });
  });
  await page.route(`/api/tasks/${threadId}/recovery/restore`, (route) => {
    restoreCalls += 1;
    return route.fulfill({
      json: {
        task: restored,
        activeTopPlacement: {
          section: {
            id: "fixture-restored-section",
            name: "frontend/tests/e2e/fixtures/home",
            repository: false,
          },
        },
      },
    });
  });

  await openRecovery(page, recovery);
  await expect(
    page.getByRole("heading", { name: "Archived recovery Task" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Archived in Codex" })).toBeVisible();
  await expect(page.locator(".task-recovery-description p")).toHaveText([
    "This Task is still Active in Caffold.",
    "Restore it, or move it to Archived here as well.",
  ]);
  await expect(page.locator(".task-recovery-card")).toHaveCount(0);
  await expect(page.locator(".task-recovery-context")).toHaveCount(0);
  const restoreButton = page.getByRole("button", { name: /Restore to Active/ });
  const archiveButton = page.getByRole("button", { name: /Move to Archived/ });
  await expect(restoreButton).toHaveClass(/task-secondary-button/);
  await expect(archiveButton).toHaveClass(/task-secondary-button/);
  await expect(
    page.locator("caffold-task-recovery .task-primary-button"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Recheck/ }),
  ).toHaveClass(/task-recovery-recheck-button/);
  await expect(page.locator(".task-recovery-thread code")).toHaveText(threadId);
  await expect(page.locator(".task-recovery-details")).toHaveCount(0);
  expect(detailReads).toBe(0);
  const detailSourcesBeforeRestore = await page.evaluate(() =>
    window.__recoveryEventSources.filter((source) =>
      source.url.includes(`/api/tasks/${"thread_recovery_restore"}/stream`)
    ).length
  );
  expect(detailSourcesBeforeRestore).toBe(0);

  await activateActionHint(page, /Restore to Active/);
  await expect.poll(() => restoreCalls).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await emitTaskDetailBootstrap(page, taskDetail(restored));
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toContainText("Restored recovery Task");
  expect(detailReads).toBe(0);
});

test("moves an already-Codex-archived recovery Task into Caffold Archived", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_archive";
  const recovery = recoveryTask(
    threadId,
    "Archive membership recovery",
    "codexArchived",
    ["restoreToActive", "moveToArchived", "recheck"],
  );
  const state = await installRecoveryList(page, recovery);
  const archivedState = { tasks: [] };
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      json: { tasks: archivedState.tasks, nextCursor: null },
    }),
  );
  let archiveCalls = 0;
  await page.route(`/api/tasks/${threadId}/recovery/archive`, (route) => {
    archiveCalls += 1;
    state.projection = activeTaskProjection();
    archivedState.tasks = [recovery];
    return route.fulfill({ json: recovery });
  });

  await openRecovery(page, recovery);
  await activateActionHint(page, /Move to Archived/);

  await expect.poll(() => archiveCalls).toBe(1);
  await expect(page).toHaveURL(/\/tasks$|\/$/);
  await expect(
    page.locator(`caffold-active-task-list .task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(
      `caffold-archived-task-list .task-archived-row[data-thread-id="${threadId}"]`,
    ),
  ).toBeVisible();
});

test("confirms before removing a missing Codex Thread from Caffold", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_missing";
  const recovery = recoveryTask(
    threadId,
    "Missing Thread recovery",
    "threadMissing",
    ["recheck", "removeFromCaffold"],
  );
  const state = await installRecoveryList(page, recovery);
  let removeCalls = 0;
  await page.route(`/api/tasks/${threadId}/recovery/remove`, (route) => {
    removeCalls += 1;
    state.projection = activeTaskProjection();
    return route.fulfill({ json: { threadId } });
  });

  await openRecovery(page, recovery);
  await activateActionHint(page, /Remove from Caffold/);
  await expect(page.getByText("Remove this Task from Caffold?")).toBeVisible();
  expect(removeCalls).toBe(0);

  await activateActionHint(page, /Remove Task$/);
  await expect.poll(() => removeCalls).toBe(1);
  await expect(page).toHaveURL(/\/tasks$|\/$/);
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0);
});

test("recheck uses the explicit recovery endpoint without rewriting the cached list", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_recheck";
  const recovery = recoveryTask(
    threadId,
    "Placement recovery",
    "temporarilyUnavailable",
    ["recheck"],
  );
  const rechecked = recoveryTask(
    threadId,
    "Placement recovery",
    "codexArchived",
    ["restoreToActive", "moveToArchived", "recheck"],
  );
  await installRecoveryList(page, recovery);
  let recheckCalls = 0;
  await page.route(`/api/tasks/${threadId}/recovery/recheck`, (route) => {
    recheckCalls += 1;
    expect(route.request().method()).toBe("POST");
    return route.fulfill({ json: rechecked });
  });

  await openRecovery(page, recovery);
  const recoveryScroll = page.locator(".task-recovery-body");
  await page.locator(".task-recovery-content").evaluate((element) => {
    element.style.minHeight = "360px";
  });
  await recoveryScroll.evaluate((element) => {
    element.style.height = "120px";
    element.style.maxHeight = "120px";
  });
  await expect.poll(() => recoveryScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await expect(page.locator(
    "caffold-task-workspace > caffold-scroll-mode-hud .scroll-mode-status",
  )).toContainText("Scroll: Task recovery");
  await page.keyboard.press("j");
  await expect.poll(() => recoveryScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  const recheck = page.getByRole("button", { name: /Recheck/ });
  await recheck.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await activateActionHint(page, /Recheck/);

  await expect.poll(() => recheckCalls).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/recovery$`));
  await expect(
    page.getByRole("heading", { name: "Archived in Codex" }),
  ).toBeVisible();
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toContainText("Placement recovery");
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveAttribute("data-task-recovery-reason", "codexArchived");
});

test("opens a readable Section-placement recovery on Recovery detail", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_readable";
  const readable = {
    ...task(threadId, "Readable placement recovery"),
    recovery: {
      reason: "sectionPlacementPending",
      actions: ["restoreToActive", "recheck"],
    },
  };
  await installRecoveryList(page, readable);
  let detailReads = 0;
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: taskDetail(readable) });
  });

  await page.goto("/tasks");
  const row = page.locator(`.task-row[data-thread-id="${threadId}"]`);
  await expect(row.locator(".task-row-recovery-icon")).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/recovery$`));
  await expect(
    page.getByRole("heading", { name: "Section placement is pending" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Restore to Active/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Recheck/ })).toBeVisible();
  expect(detailReads).toBe(0);
});

test("redirects an ordinary Task deep link when the DB projection requires Recovery", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_deep_link";
  const recovery = recoveryTask(
    threadId,
    "Placement recovery opened from a stale link",
    "sectionPlacementPending",
    ["restoreToActive", "recheck"],
  );
  await installRecoveryList(page, recovery);

  await page.goto(`/tasks/${threadId}`);

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/recovery$`));
  await expect(page.locator("caffold-task-detail")).toBeHidden();
  await expect(page.locator("caffold-task-recovery")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Section placement is pending" }),
  ).toBeVisible();
});

test("keeps the DB Recovery projection authoritative over a runtime snapshot", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_runtime_snapshot";
  const recovery = recoveryTask(
    threadId,
    "Runtime-readable placement recovery",
    "sectionPlacementPending",
    ["restoreToActive", "recheck"],
  );
  await installRecoveryList(page, recovery);

  await page.goto("/tasks");
  await emitTaskListEvent(page, "task-list-snapshot", {
    tasks: [task(threadId, recovery.title)],
  });

  const row = page.locator(`.task-row[data-thread-id="${threadId}"]`);
  await expect(row.locator(".task-row-recovery-icon")).toBeVisible();
  await expect(row).toHaveAttribute(
    "data-task-recovery-reason",
    "sectionPlacementPending",
  );
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/recovery$`));
  await expect(
    page.getByRole("heading", { name: "Section placement is pending" }),
  ).toBeVisible();
});

test("reconciles an open ordinary Task detail to a later DB Recovery projection", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_recovery_selected_transition";
  const ordinary = task(threadId, "Selected Task awaiting placement recovery");
  const recovery = recoveryTask(
    threadId,
    ordinary.title,
    "sectionPlacementPending",
    ["restoreToActive", "recheck"],
  );
  const state = {
    projection: activeTaskProjection([ordinary]),
  };
  await installRecoveryList(page, recovery, state);

  await page.goto("/tasks");
  const row = page.locator(`.task-row[data-thread-id="${threadId}"]`);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await emitTaskDetailBootstrap(page, taskDetail(ordinary));
  await expect(page.locator("caffold-task-detail")).toBeVisible();

  state.projection = activeTaskProjection([], [recovery]);
  await emitTaskListEvent(page, "task-list-refresh", {});

  await expect(row.locator(".task-row-recovery-icon")).toHaveCount(1);
  await expect(row).toHaveAttribute(
    "data-task-recovery-reason",
    "sectionPlacementPending",
  );
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/recovery$`));
  await expect(page.locator("caffold-task-detail")).toBeHidden();
  await expect(page.locator("caffold-task-recovery")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Restore to Active/ }),
  ).toBeVisible();
});
