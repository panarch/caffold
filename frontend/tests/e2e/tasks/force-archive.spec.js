import { expect, test } from "@playwright/test";
import { popoverActionHintDialog } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test("a broken worktree can be explicitly discarded and archived from Task details", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);
  const id = "force_archive_task";
  const worktreeId = "a04ae845-e3a5-4d4d-83d2-9a03780ec114";
  const task = {
    id, threadId: id, title: "Recover a Task after moving its project folder",
    cwd: "project", cwdPath: "project", worktree: true,
    ...canonicalTaskState("idle"), updatedMs: 20, recencyMs: 20,
  };
  const diagnosis = {
    code: "managed_worktree_not_repository",
    message: "The managed worktree is not a Git repository.",
    allowedActions: ["deleteTask"], worktreeId,
    worktreePath: `/managed/${worktreeId}`, worktreeMissing: false,
  };
  let archived = false;
  let normalRequests = 0;
  let forceRequests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => route.fulfill({
    json: activeTaskProjection(archived ? [] : [task]),
  }));
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) => route.fulfill({
    json: { tasks: archived ? [{ ...task, conversationAvailable: true }] : [], nextCursor: null },
  }));
  await page.route(`**/api/tasks/${id}`, (route) => route.fulfill({
    status: 409, json: { error: diagnosis },
  }));
  await page.route(`**/api/tasks/${id}/archive`, (route) => {
    normalRequests += 1;
    return route.fulfill({ status: 409, json: { error: {
      ...diagnosis, allowedActions: ["deleteTask", "forceArchive"],
    } } });
  });
  await page.route(`**/api/tasks/${id}/archive/force`, async (route) => {
    forceRequests += 1;
    expect(route.request().postDataJSON()).toEqual({ expectedWorktreeId: worktreeId });
    await gate;
    archived = true;
    await route.fulfill({ json: task });
  });
  await page.goto(`/tasks/${id}`);
  await expect.poll(() => page.evaluate((id) => Boolean(window.__caffoldTaskSse.source(id)), id)).toBe(true);
  await page.evaluate(({ id, diagnosis }) => {
    window.__caffoldTaskSse.source(id).emit("task-sync", {
      threadId: id, revision: 0, reason: "stream-bootstrap",
      detail: { threadId: id, revision: 0, eventRevision: 0, syncState: "loading", task: null, events: [], eventsPage: { nextCursor: null } },
      error: diagnosis,
    });
  }, { id, diagnosis });
  await page.getByRole("button", { name: /^Task details/ }).click();
  const actions = page.locator("caffold-task-detail-info-actions");
  const discard = actions.getByRole("button", { name: "Discard changes and archive", exact: true });
  await expect(discard).toHaveCount(0);
  await actions.getByRole("button", { name: "Archive task", exact: true }).click();
  await expect(discard).toBeEnabled();
  await expect(actions).not.toContainText("Discarded changes cannot be restored.");
  expect(normalRequests).toBe(1);
  expect(forceRequests).toBe(0);
  await discard.scrollIntoViewIfNeeded();
  await expect(discard).toBeInViewport();
  await discard.focus();
  await page.keyboard.press("f");
  const hints = popoverActionHintDialog(page);
  await expect(hints).toBeVisible();
  const hint = hints.getByRole("button", { name: / — Discard changes and archive$/ });
  await expect(hint).toBeVisible();
  const code = await hint.getAttribute("data-action-hint-code");
  expect(code).toBeTruthy();
  await page.keyboard.type(code.toLowerCase());
  const dialog = page.getByRole("dialog", { name: "Discard changes and archive?", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(dialog).toContainText(task.title);
  await expect(dialog).toContainText(`/managed/${worktreeId}`);
  await expect(dialog).toContainText("Discarded changes cannot be restored.");
  await expect(dialog).toContainText("The conversation and local Git branches will be kept.");
  expect(forceRequests).toBe(0);
  await captureReviewScreenshot(page, testInfo, "force-archive-confirmation");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(forceRequests).toBe(0);
  await expect(page.getByRole("button", { name: /^Task details/ })).toBeFocused();
  await page.getByRole("button", { name: /^Task details/ }).click();
  await discard.click();
  await expect(dialog).toBeVisible();
  await cancel.click();
  await expect(dialog).toBeHidden();
  expect(forceRequests).toBe(0);
  await page.getByRole("button", { name: /^Task details/ }).click();
  await discard.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("f");
  const modalHints = dialog.locator("caffold-action-hint-dialog > dialog:modal");
  await expect(modalHints).toBeVisible();
  const confirmHint = modalHints.getByRole("button", { name: / — Discard changes and archive$/ });
  const confirmCode = await confirmHint.getAttribute("data-action-hint-code");
  expect(confirmCode).toBeTruthy();
  await page.keyboard.type(confirmCode.toLowerCase());
  await expect.poll(() => forceRequests).toBe(1);
  await expect(dialog).toBeHidden();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  release();
  await expect(page).toHaveURL("/");
  await expect(page.locator(`.task-row[data-thread-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator(`.task-archived-row[data-thread-id="${id}"]`)).toContainText(task.title);
});
