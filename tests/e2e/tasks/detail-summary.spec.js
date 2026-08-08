import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

function summaryTask(threadId, title, rootPath, recencyMs) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath,
      branch: "main",
      headSha: "0123456789abcdef",
      relativeCwd: "",
      linked: false,
    },
    createdMs: recencyMs,
    updatedMs: recencyMs,
    recencyMs,
    lastEventSummary: `${title} preview`,
  };
}

function summaryDetail(task, revision = 1) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: null,
    model: null,
    reasoningEffort: null,
  };
}

async function installSummaryFixture(page, tasks) {
  await installEventSourceMock(page, {
    registryKey: "__taskSummaryEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: { tasks, nextCursor: null },
    }),
  );
  for (const task of tasks) {
    await page.route(
      new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`),
      (route) => route.fulfill({ json: summaryDetail(task) }),
    );
  }
}

test("keeps the task summary owner and its disclosure across canonical sync", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Detail ownership regression");
  const threadId = "thread_summary_stable";
  const task = summaryTask(threadId, "Stable summary", "repo-stable", 100);
  await installSummaryFixture(page, [task]);
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository: { rootPath: "repo-stable", branch: "main", dirty: false },
        github: { owner: "example", name: "stable" },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    }),
  );

  await page.goto(`/tasks/${threadId}`);
  const summary = page.locator("caffold-task-detail-summary");
  await expect(summary).toBeVisible();
  await expect(summary.locator(".task-review-menu")).toHaveCount(2);
  await summary
    .locator('.task-review-menu summary[aria-label="Open Git workspace"]')
    .click();
  await expect(
    summary.locator('.task-review-menu:has(summary[aria-label="Open Git workspace"])'),
  ).toHaveAttribute("open", "");
  await summary.evaluate((element) => {
    window.__taskSummaryOwner = element;
  });

  const updatedTask = {
    ...task,
    title: "Canonical summary update",
    updatedMs: task.updatedMs + 1,
    recencyMs: task.recencyMs + 1,
  };
  await page.evaluate(
    ({ threadId, detail }) => {
      const source = window.__taskSummaryEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        detail,
        reason: "canonical-summary-update",
      });
    },
    { threadId, detail: summaryDetail(updatedTask, 2) },
  );

  await expect(summary.locator("h2")).toHaveText("Canonical summary update");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__taskSummaryOwner ===
          document.querySelector("caffold-task-detail-summary"),
      ),
    )
    .toBe(true);
  await expect(
    summary.locator('.task-review-menu:has(summary[aria-label="Open Git workspace"])'),
  ).toHaveAttribute("open", "");
});

test("rejects a stale GitHub availability response after switching tasks", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Detail ownership regression");
  const taskA = summaryTask("thread_summary_a", "Summary A", "repo-a", 100);
  const taskB = summaryTask("thread_summary_b", "Summary B", "repo-b", 200);
  await installSummaryFixture(page, [taskB, taskA]);
  let pendingTaskARoute = null;
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "repo-a") {
      pendingTaskARoute = route;
      return;
    }
    return route.fulfill({
      json: {
        repository: { rootPath: "repo-b", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "Repo B has no GitHub remote",
      },
    });
  });

  await page.goto(`/tasks/${taskA.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const taskNavigator = page.locator("caffold-task-navigator");
  const summary = tasksPage.locator("caffold-task-detail-summary");
  await expect(summary).toBeVisible();
  await expect.poll(() => Boolean(pendingTaskARoute)).toBe(true);
  await summary.evaluate((element) => {
    window.__taskSummaryOwner = element;
  });

  await taskNavigator
    .locator(`.task-row[data-thread-id="${taskB.threadId}"]`)
    .click();
  await expect(summary.locator("h2")).toHaveText("Summary B");
  await expect(
    summary.getByRole("button", { name: "Repo B has no GitHub remote" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__taskSummaryOwner ===
          document.querySelector("caffold-task-detail-summary"),
      ),
    )
    .toBe(true);

  await pendingTaskARoute.fulfill({
    json: {
      repository: { rootPath: "repo-a", branch: "main", dirty: false },
      github: { owner: "example", name: "stale" },
      ghAvailable: true,
      authenticated: true,
      issuesAvailable: true,
      pullsAvailable: true,
      message: null,
    },
  });

  await expect(summary.locator(".task-review-menu")).toHaveCount(1);
  await expect(
    summary.getByRole("button", { name: "Repo B has no GitHub remote" }),
  ).toBeDisabled();
});

test("keeps GitHub availability inactive while task detail is deactivated", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Detail ownership regression");
  const threadId = "thread_summary_inactive";
  const task = summaryTask(threadId, "Inactive summary", "repo-inactive", 100);
  await installSummaryFixture(page, [task]);
  const pendingRoutes = [];
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    pendingRoutes.push(route);
  });

  await page.goto(`/tasks/${threadId}`);
  await expect(
    page.locator("caffold-task-detail-summary"),
  ).toBeVisible();
  await expect.poll(() => pendingRoutes.length).toBe(1);

  await page.locator("caffold-task-detail").evaluate((detail) => {
    detail.deactivate();
    window.dispatchEvent(new CustomEvent("caffold:icons-ready"));
  });

  await expect.poll(() => pendingRoutes.length).toBe(1);
  await expect(
    page.locator("caffold-task-detail-summary"),
  ).toBeHidden();
});
