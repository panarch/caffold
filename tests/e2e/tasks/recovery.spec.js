import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__recoveryEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);
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
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
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

test("opens archived-in-Codex recovery without opening ordinary Task detail and restores it", async ({
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
            name: "tests/fixtures/home",
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

  await restoreButton.click();
  await expect.poll(() => restoreCalls).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toContainText("Restored recovery Task");
  await expect.poll(() => detailReads).toBe(1);
});

test("moves an already-Codex-archived recovery Task into Caffold Archived", async ({
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
  await page.getByRole("button", { name: /Move to Archived/ }).click();

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

test("confirms before removing a missing Codex Thread from Caffold", async ({
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
  await page.getByRole("button", { name: /Remove from Caffold/ }).click();
  await expect(page.getByText("Remove this Task from Caffold?")).toBeVisible();
  expect(removeCalls).toBe(0);

  await page.getByRole("button", { name: "Remove Task" }).click();
  await expect.poll(() => removeCalls).toBe(1);
  await expect(page).toHaveURL(/\/tasks$|\/$/);
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0);
});

test("recheck follows the refreshed Section projection", async ({ page }) => {
  const threadId = "thread_recovery_recheck";
  const recovery = recoveryTask(
    threadId,
    "Placement recovery",
    "temporarilyUnavailable",
    ["recheck"],
  );
  const restored = task(threadId, "Rechecked active Task");
  const state = await installRecoveryList(page, recovery);
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail(restored) }),
  );

  await openRecovery(page, recovery);
  state.projection = activeTaskProjection([restored]);
  await page.getByRole("button", { name: /Recheck/ }).click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toContainText("Rechecked active Task");
});

test("keeps a readable Section-placement recovery on ordinary Task detail", async ({
  page,
}) => {
  const threadId = "thread_recovery_readable";
  const readable = {
    ...task(threadId, "Readable placement recovery"),
    recovery: {
      reason: "sectionPlacementPending",
      actions: ["recheck"],
    },
  };
  await installRecoveryList(page, readable);
  let detailReads = 0;
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: taskDetail(readable) });
  });

  await page.goto("/tasks");
  await page.locator(`.task-row[data-thread-id="${threadId}"]`).click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(page.locator("caffold-task-recovery")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Readable placement recovery" }),
  ).toBeVisible();
  await expect.poll(() => detailReads).toBe(1);
});
