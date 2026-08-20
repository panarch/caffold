import { expect, test } from "@playwright/test";
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

  await row.getByRole("button", { name: "Delete Delete archived task" }).click();
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

  await cancel.click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toBeVisible();
  expect(deleteRequests).toBe(0);

  await row.getByRole("button", { name: "Delete Delete archived task" }).click();
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
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
