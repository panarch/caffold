import { expect, test } from "@playwright/test";
import {
  installBrowserDefaults,
  mockTaskStoreStatus,
} from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  archivedListTask,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

const threadId = "interrupted_archive_task";
const timestamp = Date.parse("2026-11-06T05:49:27Z");
const task = {
  id: threadId,
  threadId,
  title: "Keep the reading position when switching file viewer tabs",
  cwd: "src",
  cwdPath: "src",
  relativeCwd: "",
  worktree: true,
  ...canonicalTaskState("idle"),
  createdMs: timestamp,
  updatedMs: timestamp,
  recencyMs: timestamp,
  unseen: false,
};
const diagnosis = {
  code: "managed_worktree_archive_incomplete",
  message: "The worktree was removed. Archive this task to finish.",
  allowedActions: ["archiveTask"],
};
const occupied = {
  ...diagnosis,
  message: "The archived worktree path is occupied.",
  allowedActions: [],
};
const globalNotice = ".app-foreground-recovery";
const taskNotice = ".task-detail-load-error";
const archivePath = `**/api/tasks/${threadId}/archive`;
const retryError = "Could not save the Task in Archived. Try again.";

for (const theme of ["light", "dark"]) {
  test(`finishes an interrupted archive from Task Detail in ${theme} mode`, { tag: "@all-viewports" }, async ({ page }, testInfo) => {
    const listing = await installFixture(page, { theme });
    let normalRequests = 0;
    let forceRequests = 0;
    let releaseFirstResponse;
    const firstResponse = new Promise((resolve) => { releaseFirstResponse = resolve; });
    await page.route(`${archivePath}/force`, (route) => {
      forceRequests += 1;
      return route.abort();
    });
    await page.route(archivePath, async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postData()).toBeNull();
      normalRequests += 1;
      if (normalRequests === 1) {
        await firstResponse;
        return route.fulfill({ status: 500, json: { error: { code: "internal_error", message: retryError } } });
      }
      listing.archived = true;
      return route.fulfill({ json: archivedListTask(task) });
    });

    await page.goto(`/tasks/${threadId}`);
    await emitDiagnosis(page, diagnosis);
    const notice = page.locator(taskNotice);
    const archive = notice.getByRole("button", { name: "Archive task", exact: true });
    await expect(notice).toContainText(diagnosis.message);
    await expect(archive).toBeInViewport();
    await expect(archive).toBeEnabled();
    await expect(page.locator(globalNotice)).toBeHidden();
    await captureReviewScreenshot(page, testInfo, `ready-to-archive-${theme}`);

    await archive.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => normalRequests).toBe(1);
    await expect(notice.getByRole("button", { name: "Archiving..." })).toBeDisabled();
    releaseFirstResponse();
    await expect(notice).toContainText(retryError);
    await expect(archive).toBeEnabled();
    await expect(page.locator(globalNotice)).toBeHidden();
    await captureReviewScreenshot(page, testInfo, `archive-retry-${theme}`);

    await archive.click();
    await expect(page).toHaveURL("/");
    const archived = page.locator(`.task-archived-row[data-thread-id="${threadId}"]`);
    await expect(archived).toContainText(task.title);
    await expect(archived.getByRole("button", { name: `Restore ${task.title}`, exact: true })).toBeVisible();
    await expect(page.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0);
    expect(normalRequests).toBe(2);
    expect(forceRequests).toBe(0);
    await captureReviewScreenshot(page, testInfo, `archive-complete-${theme}`);
  });
}

test("returning to the task settles foreground recovery without retrying the server", { tag: "@server-changes" }, async ({ page }, testInfo) => {
  await installFixture(page, { theme: "dark" });
  await page.addInitScript(() => {
    window.__archiveVisibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      get: () => window.__archiveVisibility,
    });
  });
  let statusReads = 0;
  const records = [];
  await page.route("**/api/task-store/status", (route) => {
    statusReads += 1;
    return route.fulfill({ json: mockTaskStoreStatus() });
  });
  await page.route("**/api/diagnostics/foreground-recovery", (route) => {
    records.push(...route.request().postDataJSON().records);
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/tasks/${threadId}`);
  await emitDiagnosis(page, diagnosis);
  await expect(page.locator(taskNotice)).toContainText(diagnosis.message);
  const beforeHide = statusReads;
  await page.evaluate((id) => {
    window.__archiveOldSource = window.__caffoldTaskSse.source(id);
    window.__archiveVisibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  }, threadId);
  await expect.poll(() => page.evaluate(() => window.__archiveOldSource.readyState)).toBe(2);
  await page.evaluate(() => {
    window.__archiveVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => statusReads).toBeGreaterThan(beforeHide);
  await emitDiagnosis(page, diagnosis);
  await expect.poll(() => records.find((record) => record.end === "settled")?.recovery.at(-1)?.node).toBe("ready");
  expect(records.flatMap((record) => record.notice).map((notice) => notice.state)).not.toContain("unavailable");
  await expect(page.locator(globalNotice)).toBeHidden();
  await expect(page.locator(taskNotice).getByRole("button", { name: "Archive task" })).toBeEnabled();
  await captureReviewScreenshot(page, testInfo, "after-tab-return-dark");
});

test("an occupied archived path shows the task problem without offering archive", { tag: "@server-steady" }, async ({ page }, testInfo) => {
  await installFixture(page, { theme: "light", error: occupied });
  await page.goto(`/tasks/${threadId}`);
  await emitDiagnosis(page, occupied);
  const notice = page.locator(taskNotice);
  await expect(notice).toContainText(occupied.message);
  await expect(notice.getByRole("button")).toHaveCount(0);
  await expect(page.locator(globalNotice)).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "worktree-path-occupied-light");
});

async function installFixture(page, { theme, error = diagnosis }) {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((mode) => {
    localStorage.setItem("caffold:settings", JSON.stringify({ themeMode: mode }));
  }, theme);
  await page.clock.setFixedTime(new Date("2026-11-22T00:00:00Z"));
  const listing = { archived: false };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection(listing.archived ? [] : [task]) }),
  );
  await page.route("**/api/tasks/archived*", (route) =>
    route.fulfill({ json: { tasks: listing.archived ? [archivedListTask(task)] : [], nextCursor: null } }),
  );
  await page.route(`**/api/tasks/${threadId}`, (route) =>
    route.fulfill({ status: 409, json: { error } }),
  );
  return listing;
}

async function emitDiagnosis(page, error) {
  await expect.poll(() => page.evaluate((id) =>
    window.__caffoldTaskSse?.source(id)?.readyState, threadId,
  )).toBe(1);
  await page.evaluate(({ id, error }) => {
    window.__caffoldTaskSse.source(id).emit("task-sync", {
      threadId: id,
      revision: 0,
      reason: "stream-bootstrap",
      detail: {
        threadId: id,
        revision: 0,
        eventRevision: 0,
        syncState: "loading",
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
      },
      error,
    });
  }, { id: threadId, error });
}
