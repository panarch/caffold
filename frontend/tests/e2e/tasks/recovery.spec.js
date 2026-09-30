import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  enterActionHints,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeListTask,
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
    eventsRange: { from: null, to: null },
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

async function openRecovery(page, recovery, { iconsPending = false } = {}) {
  await page.goto("/tasks", {
    waitUntil: iconsPending ? "domcontentloaded" : "load",
  });
  const row = page.locator(
    `.task-row[data-thread-id="${recovery.threadId}"]`,
  );
  await expect(row).toBeVisible();
  if (!iconsPending) {
    await expect(row.locator(".task-row-recovery-icon")).toBeVisible();
  }
  await expect(row.locator(".task-row-recovery-reason")).toHaveCount(0);
  await row.click();
  await expect(page).toHaveURL(
    new RegExp(`/tasks/${recovery.threadId}/recovery$`),
  );
  await expect(page.locator("caffold-task-recovery")).toBeVisible();
}

async function holdRecoveryIcons(page) {
  const requested = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route("https://esm.sh/lucide@1.22.0", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fallback();
  });
  return { requested: requested.promise, release: release.resolve };
}

async function scrollRecoveryActionIntoView(action) {
  await action.evaluate((element) => {
    const scrollport = element.closest(".task-recovery-body");
    if (!scrollport) {
      throw new Error("Recovery action has no Recovery scroll owner");
    }
    const before = {
      left: scrollport.scrollLeft,
      top: scrollport.scrollTop,
    };
    return new Promise((resolve) => {
      const handleScroll = () => resolve();
      scrollport.addEventListener("scroll", handleScroll, { once: true });
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (
        scrollport.scrollLeft === before.left &&
        scrollport.scrollTop === before.top
      ) {
        scrollport.removeEventListener("scroll", handleScroll);
        resolve();
      }
    });
  });
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
        task: activeListTask(restored),
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

for (const scenario of [
  {
    action: "archive",
    reason: "codexArchived",
    actions: ["restoreToActive", "moveToArchived", "recheck"],
    label: /Move to Archived/,
  },
  {
    action: "remove",
    reason: "threadMissing",
    actions: ["removeFromCaffold", "recheck"],
    label: /Remove from Caffold/,
  },
]) {
  test(`keeps the ${scenario.action} Action Hint usable when Recovery icons finish loading`, { tag: "@all-viewports" }, async ({ page }) => {
    const threadId = `thread_recovery_late_icons_${scenario.action}`;
    const recovery = recoveryTask(
      threadId,
      "Recovery with delayed icons",
      scenario.reason,
      scenario.actions,
    );
    const state = await installRecoveryList(page, recovery);
    await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
      route.fulfill({ json: { tasks: [], nextCursor: null } }),
    );
    let actionCalls = 0;
    await page.route(`/api/tasks/${threadId}/recovery/${scenario.action}`, (route) => {
      actionCalls += 1;
      state.projection = activeTaskProjection();
      return route.fulfill({
        json: scenario.action === "archive" ? recovery : { threadId },
      });
    });
    const icons = await holdRecoveryIcons(page);
    try {
      await openRecovery(page, recovery, { iconsPending: true });
      await icons.requested;
      const owner = page.locator("caffold-task-recovery");
      const button = owner.locator(`[data-task-recovery-action="${scenario.action}"]`);
      await expect(button.locator("svg")).toHaveCount(0);
      await waitForActionHintTarget(page, scenario.label);
      const dialog = await enterActionHints(page);
      const badge = dialog.getByLabel(scenario.label);
      await expect(badge).toBeVisible();
      const code = await badge.getAttribute("data-action-hint-code");
      expect(code).toMatch(/^[A-Z]+$/);
      const originalButton = await button.elementHandle();
      const originalScrollport = await owner.locator(".task-recovery-body").elementHandle();

      icons.release();
      await expect(button.locator("svg")).toHaveCount(1);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("data-action-hint-code", code);
      expect(await originalButton.evaluate((element) => element.isConnected)).toBe(true);
      expect(await originalScrollport.evaluate((element) => element.isConnected)).toBe(true);
      await page.keyboard.type(code.toLowerCase());
      await expect(dialog).toBeHidden();

      if (scenario.action === "remove") {
        await expect(page.getByText("Remove this Task from Caffold?")).toBeVisible();
        expect(actionCalls).toBe(0);
        await activateActionHint(page, /Remove Task$/);
      }
      await expect.poll(() => actionCalls).toBe(1);
      await expect(page).toHaveURL(/\/tasks$|\/$/);
    } finally {
      icons.release();
    }
  });
}

test("keeps the removal confirmation Action Hint usable when Recovery icons finish loading", { tag: "@all-viewports" }, async ({ page }) => {
  const threadId = "thread_recovery_confirmation_late_icons";
  const recovery = recoveryTask(
    threadId,
    "Missing Thread with delayed icons",
    "threadMissing",
    ["removeFromCaffold", "recheck"],
  );
  const state = await installRecoveryList(page, recovery);
  let removeCalls = 0;
  await page.route(`/api/tasks/${threadId}/recovery/remove`, (route) => {
    removeCalls += 1;
    state.projection = activeTaskProjection();
    return route.fulfill({ json: { threadId } });
  });
  const icons = await holdRecoveryIcons(page);
  try {
    await openRecovery(page, recovery, { iconsPending: true });
    await icons.requested;
    await page.getByRole("button", { name: /Remove from Caffold/ }).click();
    await expect(page.getByText("Remove this Task from Caffold?")).toBeVisible();
    await waitForActionHintTarget(page, /Remove Task$/);
    const dialog = await enterActionHints(page);
    const badge = dialog.getByLabel(/Remove Task$/);
    await expect(badge).toBeVisible();
    const code = await badge.getAttribute("data-action-hint-code");
    expect(code).toMatch(/^[A-Z]+$/);

    icons.release();
    await expect(page.locator(".task-recovery-icon-slot svg")).toHaveCount(1);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-action-hint-code", code);
    expect(removeCalls).toBe(0);
    await page.keyboard.type(code.toLowerCase());
    await expect.poll(() => removeCalls).toBe(1);
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/tasks$|\/$/);
  } finally {
    icons.release();
  }
});

test("preserves Recovery focus and scroll position when icons finish loading", { tag: "@all-viewports" }, async ({ page }) => {
  const recovery = recoveryTask(
    "thread_recovery_focus_late_icons",
    "Recovery with delayed icons",
    "codexArchived",
    ["restoreToActive", "moveToArchived", "recheck"],
  );
  await installRecoveryList(page, recovery);
  const icons = await holdRecoveryIcons(page);
  try {
    await openRecovery(page, recovery, { iconsPending: true });
    await icons.requested;
    await page.addStyleTag({
      content: `
        caffold-task-recovery .task-recovery-content { min-height: 800px; }
        caffold-task-recovery .task-recovery-body { height: 120px; max-height: 120px; }
      `,
    });
    const button = page.getByRole("button", { name: /Move to Archived/ });
    await button.evaluate((element) => element.focus({ preventScroll: true }));
    await expect(button).toBeFocused();
    const scrollport = page.locator(".task-recovery-body");
    const originalScrollport = await scrollport.elementHandle();
    await expect.poll(() => scrollport.evaluate(
      (element) => element.scrollHeight > element.clientHeight + 80,
    )).toBe(true);
    await scrollport.evaluate((element) => { element.scrollTop = 80; });
    await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBe(80);

    icons.release();
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toBeFocused();
    expect(await originalScrollport.evaluate((element) => element.isConnected)).toBe(true);
    await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBe(80);
  } finally {
    icons.release();
  }
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
    return route.fulfill({
      json: { ...activeListTask(rechecked), recovery: rechecked.recovery },
    });
  });

  await openRecovery(page, recovery);
  await page.addStyleTag({
    content: `
      caffold-task-recovery .task-recovery-content {
        min-height: 360px !important;
      }
      caffold-task-recovery .task-recovery-body {
        height: 120px !important;
        max-height: 120px !important;
      }
    `,
  });
  const recoveryScroll = page.locator(".task-recovery-body");
  await expect.poll(() => recoveryScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await expect(page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  )).toContainText("Scroll: Task recovery");
  await page.keyboard.press("j");
  await expect.poll(() => recoveryScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  const recheck = page.getByRole("button", { name: /Recheck/ });
  await scrollRecoveryActionIntoView(recheck);
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
    tasks: [activeListTask(task(threadId, recovery.title))],
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
