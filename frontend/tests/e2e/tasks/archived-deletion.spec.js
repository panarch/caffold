import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  activateActionHint,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page);
  await mockAgentModels(page);
});

function archivedTask(threadId, title, conversationAvailable = true) {
  return {
    id: threadId,
    threadId,
    conversationAvailable,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: conversationAvailable ? `${title} preview` : "Conversation unavailable",
    cwd: conversationAvailable ? "frontend/tests/e2e/fixtures/home/project" : "",
    cwdPath: conversationAvailable ? "frontend/tests/e2e/fixtures/home/project" : null,
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: conversationAvailable
      ? `${title} summary`
      : "Conversation unavailable",
    unseen: false,
  };
}

async function mockArchivedList(page, tasks) {
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection()),
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks, nextCursor: null }),
    }),
  );
}

test("confirms permanent deletion and removes the archived row only after success", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const task = archivedTask("thread_delete", "Delete archived task");
  await mockArchivedList(page, [task]);
  let releaseDelete;
  const deleteGate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  let deleteRequests = 0;
  await page.route(/\/api\/tasks\/thread_delete$/, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    deleteRequests += 1;
    await deleteGate;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId: task.threadId }),
    });
  });

  await page.goto("/tasks");
  const row = page.locator(
    'caffold-task-navigator .task-archived-row[data-thread-id="thread_delete"]',
  );
  await expect(row).toBeVisible();
  expect(
    await row.locator(".task-archived-action-button").evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    ),
  ).toEqual(["Restore Delete archived task", "Delete Delete archived task"]);

  await activateActionHint(page, /Delete Delete archived task$/);
  const dialog = page.getByRole("dialog", {
    name: "Permanently delete archived task?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Delete archived task");
  await expect(
    dialog.locator("#task-delete-dialog-description br"),
  ).toHaveCount(1);
  await expect(dialog).toContainText("It cannot be restored.");
  await expect(dialog.locator(".task-delete-dialog-preserved")).toHaveText(
    "Your local Git branch will be kept.",
  );
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await captureReviewScreenshot(page, testInfo, "tasks-delete-confirmation");

  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(hint.getByRole("button", { name: / — Cancel$/ })).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Delete permanently$/ }),
  ).toBeVisible();
  const cancelCode = await hint.getByRole("button", {
    name: / — Cancel$/,
  }).getAttribute("data-action-hint-code");
  expect(cancelCode).toBeTruthy();
  await page.keyboard.type(cancelCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(dialog).not.toBeVisible();
  await expect(row).toBeVisible();
  expect(deleteRequests).toBe(0);

  await activateActionHint(page, /Delete Delete archived task$/);
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("f");
  const deleteHint = actionHintDialog(page).getByRole("button", {
    name: / — Delete permanently$/,
  });
  const deleteCode = await deleteHint.getAttribute("data-action-hint-code");
  expect(deleteCode).toBeTruthy();
  await page.keyboard.type(deleteCode.toLowerCase());
  const deleting = row.getByRole("button", {
    name: "Deleting Delete archived task",
  });
  await expect(deleting).toBeDisabled();
  await expect(
    row.getByRole("button", { name: "Restore Delete archived task" }),
  ).toBeDisabled();
  await expect.poll(() => deleteRequests).toBe(1);
  await expect(row).toBeVisible();

  releaseDelete();
  await expect(row).toHaveCount(0);
});

test("activates Archived retry, paging, restore, and Task-list scrolling through the workspace", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const firstPage = Array.from({ length: 28 }, (_, index) =>
    archivedTask(
      `thread_archived_page_${index + 1}`,
      `Archived page task ${index + 1}`,
    )
  );
  const pagedTask = archivedTask(
    "thread_archived_page_more",
    "Archived loaded later",
  );
  let archivedReads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection() })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) => {
    archivedReads += 1;
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (archivedReads === 1) {
      return route.fulfill({
        status: 503,
        json: { error: "Archived list unavailable" },
      });
    }
    return route.fulfill({
      json: cursor === "archived-next"
        ? { tasks: [pagedTask], nextCursor: null }
        : { tasks: firstPage, nextCursor: "archived-next" },
    });
  });
  let restoreRequests = 0;
  await page.route(
    `/api/tasks/${firstPage[0].threadId}/restore`,
    (route) => {
      restoreRequests += 1;
      return route.fulfill({
        json: {
          task: firstPage[0],
          activeTopPlacement: {
            section: {
              id: "fixture-restored-section",
              name: "frontend/tests/e2e/fixtures/home/project",
              repository: false,
            },
          },
        },
      });
    },
  );

  await page.goto("/tasks");
  await expect(page.getByRole("alert")).toContainText(
    "Archived list unavailable",
  );
  await activateActionHint(page, /Retry$/);
  await expect.poll(() => archivedReads).toBe(2);

  const taskList = page.locator(".task-list-scroll");
  await expect.poll(() => taskList.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  const selector = page.locator("caffold-scroll-surface-selector > dialog:modal");
  const scrollHud = page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await expect.poll(async () =>
    await selector.isVisible() || await scrollHud.isVisible()
  ).toBe(true);
  if (await selector.isVisible()) {
    await selector.getByLabel(/^[A-Z]+ — Task list$/).click();
  }
  await expect(scrollHud).toContainText("Scroll: Task list");
  await page.keyboard.press("j");
  await expect.poll(() => taskList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  const loadMore = page.getByRole("button", {
    name: "Load more archived tasks",
  });
  await revealActionTarget(page, loadMore);
  await activateActionHint(page, /Load more archived tasks$/);
  await expect.poll(() => archivedReads).toBe(3);
  await expect(page.locator(".task-row-title").filter({
    hasText: "Archived loaded later",
  })).toHaveText("Archived loaded later");

  const restore = page.getByRole("button", {
    name: "Restore Archived page task 1",
    exact: true,
  });
  await revealActionTarget(page, restore);
  await activateActionHint(page, /Restore Archived page task 1$/);
  await expect.poll(() => restoreRequests).toBe(1);
  await expect(restore).toHaveCount(0);
});

test("offers delete without restore when the archived conversation is unavailable", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const task = archivedTask(
    "thread_unavailable_delete",
    "Thread unavailable",
    false,
  );
  await mockArchivedList(page, [task]);
  await page.route(/\/api\/tasks\/thread_unavailable_delete$/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "codex_unavailable",
          message: "Delete failed by fixture.",
        },
      }),
    }),
  );

  await page.goto("/tasks");
  const row = page.locator(
    'caffold-task-navigator .task-archived-row[data-thread-id="thread_unavailable_delete"]',
  );
  const unavailableLabel =
    "Conversation unavailable; restore is not available";
  const unavailable = row.getByRole("img", { name: unavailableLabel });
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toHaveAttribute("title", unavailableLabel);
  await expect(row.locator(".task-row-time")).toBeVisible();
  await expect(row.getByRole("button", { name: /Restore/ })).toHaveCount(0);
  const deleteButton = row.getByRole("button", {
    name: "Delete Thread unavailable",
  });
  await expect(deleteButton).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "tasks-unavailable-warning-delete");
  await deleteButton.hover();
  await captureReviewScreenshot(page, testInfo, "tasks-unavailable-delete-hover");

  await deleteButton.click();
  await page
    .getByRole("dialog", { name: "Permanently delete archived task?" })
    .getByRole("button", { name: "Delete permanently" })
    .click();

  await expect(row).toBeVisible();
  await expect(row.getByRole("alert")).toHaveText("Delete failed by fixture.");
  await expect(
    row.getByRole("button", { name: "Retry deleting Thread unavailable" }),
  ).toBeVisible();
});

async function revealActionTarget(page, control) {
  await control.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
}
