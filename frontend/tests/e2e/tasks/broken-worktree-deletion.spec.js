import { expect, test } from "@playwright/test";
import { actionHintDialog } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { activeTaskProjection, canonicalTaskState, captureReviewScreenshot, installEventSourceMock, mockAgentModels } from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);
});

const id = "broken_worktree_task";
const error = {
  code: "managed_worktree_not_repository", message: "The managed worktree is not a Git repository.",
  allowedActions: ["deleteTask"], worktreeId: "a04ae845-e3a5-4d4d-83d2-9a03780ec114",
  worktreePath: `/managed/${"long-directory-name/".repeat(9)}a04ae845-e3a5-4d4d-83d2-9a03780ec114`, worktreeMissing: false,
};
const task = { id, threadId: id, title: "Broken task with a long title to check wrapping and keyboard access", cwd: "project", cwdPath: "project",
  ...canonicalTaskState("idle"), worktree: true, updatedMs: 20, recencyMs: 20, unseen: false };

async function installTasks(page, tasks = [task], archived = []) {
  const listing = { tasks };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => route.fulfill({ json: activeTaskProjection(listing.tasks) }));
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) => route.fulfill({ json: { tasks: archived, nextCursor: null } }));
  return listing;
}

async function openBroken(page, diagnosis = error) {
  await page.goto(`/tasks/${id}`);
  await expect.poll(() => page.evaluate((threadId) => Boolean(window.__caffoldTaskSse.source(threadId)), id)).toBe(true);
  await page.evaluate(({ id, diagnosis }) => {
    window.__caffoldTaskSse.source(id).emit("task-sync", { threadId: id, revision: 0, reason: "stream-bootstrap",
      detail: { threadId: id, revision: 0, eventRevision: 0, syncState: "loading", task: null, events: [], eventsPage: { nextCursor: null } }, error: diagnosis });
  }, { id, diagnosis });
  await expect(page.locator('button[data-task-action="delete-broken-task"]')).toBeVisible();
}

test("broken deletion keeps the established deletion dialog appearance at maximum Interface size", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("caffold:settings", JSON.stringify({
    interfaceScalePercent: 120, conversationTextPx: 20, codeTextPx: 20, themeMode: "dark",
  })));
  const archived = { ...task, id: "archived_reference", threadId: "archived_reference",
    title: "Archived reference task", worktree: null, conversationAvailable: true };
  await installTasks(page, [task], [archived]);
  await page.route(new RegExp(`/api/tasks/${id}$`), (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ status: 409, json: { error } });
  });
  const appearance = (dialog) => dialog.evaluate((element) => {
    const styles = (node, properties) => {
      const style = getComputedStyle(node);
      return Object.fromEntries(properties.map((property) => [property, style[property]]));
    };
    const text = ["fontFamily", "fontSize", "fontWeight", "lineHeight"];
    const button = [...text, "minHeight", "padding", "borderRadius", "borderColor", "backgroundColor", "color", "outlineStyle"];
    return {
      panel: styles(element, ["width", "borderRadius", "borderColor", "backgroundColor", "boxShadow"]),
      card: styles(element.querySelector("form"), ["padding", "gap"]),
      heading: styles(element.querySelector("h2"), text),
      task: styles(element.querySelector("p"), text),
      actions: styles(element.querySelector("footer"), ["gap", "marginTop", "justifyContent"]),
      cancel: styles(element.querySelector('button[value="cancel"]'), button),
      confirm: styles(element.querySelector('button[value="delete"]'), button),
    };
  });

  await page.goto("/tasks");
  await page.getByRole("button", { name: "Delete Archived reference task", exact: true }).click();
  const reference = page.locator("caffold-task-archived-delete-dialog > dialog");
  await expect(reference).toBeVisible();
  await page.mouse.move(0, 0);
  const expected = await appearance(reference);
  await captureReviewScreenshot(page, testInfo, "archived-delete-reference-large-dark");
  await reference.getByRole("button", { name: "Cancel" }).click();
  await expect(reference).toBeHidden();

  await openBroken(page);
  await page.locator('button[data-task-action="delete-broken-task"]').click();
  const dialog = page.locator("caffold-broken-task-delete-dialog > dialog");
  await expect(dialog).toBeVisible();
  await page.mouse.move(0, 0);
  expect(await appearance(dialog)).toEqual(expected);
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
  await captureReviewScreenshot(page, testInfo, "broken-delete-large-dark");
  await dialog.getByRole("button", { name: "Delete task", exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Delete task", exact: true })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a broken worktree offers deletion with native focus, cancellation and one confirmed request", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const listing = await installTasks(page);
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(new RegExp(`/api/tasks/${id}$`), async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 409, json: { error } });
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ confirmBrokenWorktreeDeletion: true, expectedWorktreeId: error.worktreeId });
    requests += 1;
    await gate;
    listing.tasks = [];
    return route.fulfill({ json: { threadId: id } });
  });
  await openBroken(page);
  const button = page.locator('button[data-task-action="delete-broken-task"]');
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await button.click();
  const dialog = page.locator("caffold-broken-task-delete-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(task.title);
  await expect(dialog).toContainText(error.worktreePath);
  await expect(dialog).toContainText("cannot check for uncommitted changes");
  await expect(dialog).toContainText("this conversation");
  await expect(dialog).toContainText("cannot be undone");
  await expect(dialog).toContainText("Local Git branches will be kept");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Delete task", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  expect(requests).toBe(0);
  await button.click();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
  await captureReviewScreenshot(page, testInfo, "broken-worktree-confirmation");
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeVisible();
  const cancelCode = await actionHintDialog(page).getByRole("button", { name: / — Cancel$/ }).getAttribute("data-action-hint-code");
  expect(cancelCode).toBeTruthy();
  await page.keyboard.type(cancelCode.toLowerCase());
  await expect(dialog).toBeHidden();
  expect(requests).toBe(0);
  await button.click();
  await dialog.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await expect(dialog.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(requests).toBe(1);
  release();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new URL("/", page.url()).href);
  await expect(page.locator(`.task-row[data-thread-id="${id}"]`)).toHaveCount(0);
});

test("partial deletion failure is shown in the dialog, and a revoked diagnosis closes it", { tag: "@desktop" }, async ({ page }) => {
  await installTasks(page);
  let requests = 0;
  let eligible = true;
  await page.route(new RegExp(`/api/tasks/${id}$`), (route) => {
    if (route.request().method() === "DELETE") {
      requests += 1;
      return route.fulfill({ status: 502, json: { error: { message: "Provider delete failed" } } });
    }
    return route.fulfill({ status: 409, json: { error: eligible ? error : { code: "managed_worktree_not_broken", message: "Worktree is usable", allowedActions: [] } } });
  });
  await openBroken(page);
  await page.locator('button[data-task-action="delete-broken-task"]').click();
  const dialog = page.locator("caffold-broken-task-delete-dialog > dialog");
  await dialog.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Provider delete failed");
  await expect(dialog.getByRole("button", { name: "Delete task", exact: true })).toBeEnabled();
  expect(requests).toBe(1);
  eligible = false;
  await dialog.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".task-detail-load-error")).toContainText("Worktree is usable");
  await expect(page.locator('button[data-task-action="delete-broken-task"]')).toHaveCount(0);
  expect(requests).toBe(2);
});

test("missing worktrees name conversation deletion and stale success leaves a new selection alone", { tag: "@desktop" }, async ({ page }) => {
  const other = { ...task, id: "other_task", threadId: "other_task", title: "Other task" };
  await installTasks(page, [task, other]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await page.route(new RegExp(`/api/tasks/${id}$`), async (route) => {
    requests += 1;
    await gate;
    return route.fulfill({ json: { threadId: id } });
  });
  await openBroken(page, { ...error, code: "managed_worktree_missing", worktreeMissing: true });
  await page.locator('button[data-task-action="delete-broken-task"]').click();
  const dialog = page.locator("caffold-broken-task-delete-dialog > dialog");
  await expect(dialog).toContainText("The worktree folder is missing");
  await expect(dialog).not.toContainText("remaining worktree files");
  await dialog.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => {
    history.pushState({}, "", "/tasks/other_task");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/tasks\/other_task$/);
  await expect(dialog).toBeHidden();
  release();
  await expect(page).toHaveURL(/\/tasks\/other_task$/);
  await expect(page.locator("caffold-task-detail")).toHaveAttribute("data-task-detail-view", "conversation");
});
