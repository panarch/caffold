import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
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

async function emitSummarySync(page, threadId, detail, reason) {
  await page.evaluate(
    ({ threadId, detail, reason }) => {
      const source = window.__taskSummaryEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        detail,
        reason,
      });
    },
    { threadId, detail, reason },
  );
}

async function summaryNodeState(page) {
  return page.evaluate(() => {
    const summary = document.querySelector("caffold-task-detail-summary");
    const nodes = window.__taskSummaryNodes;
    return {
      owner: nodes.owner === summary,
      info:
        nodes.info === summary.querySelector("caffold-task-detail-info"),
      infoButton:
        nodes.infoButton === summary.querySelector(".task-detail-info-button"),
      infoPopover:
        nodes.infoPopover === summary.querySelector(".task-detail-popover"),
      infoOpen: nodes.infoPopover.matches(":popover-open"),
    };
  });
}

const stableSummaryNodes = {
  owner: true,
  info: true,
  infoButton: true,
  infoPopover: true,
};

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

test("keeps the task info leaf and popover stable across canonical sync", async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_stable";
  const task = summaryTask(threadId, "Stable summary", "repo-stable", 100);
  await installSummaryFixture(page, [task]);
  let pendingGithubRoute = null;
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    pendingGithubRoute = route;
  });

  await page.goto(`/tasks/${threadId}`);
  const summary = page.locator("caffold-task-detail-summary");
  await expect(summary).toBeVisible();
  await expect.poll(() => Boolean(pendingGithubRoute)).toBe(true);
  await expect(summary.locator(".task-review-menu")).toHaveCount(1);
  const taskDetailsButton = summary.getByRole("button", {
    name: /Task details/,
  });
  const taskDetailsPopover = summary.locator(".task-detail-popover");
  await summary.evaluate((element) => {
    window.__taskSummaryNodes = {
      owner: element,
      info: element.querySelector("caffold-task-detail-info"),
      infoButton: element.querySelector(".task-detail-info-button"),
      infoPopover: element.querySelector(".task-detail-popover"),
    };
  });

  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("caffold:icons-ready"));
  });
  await pendingGithubRoute.fulfill({
    json: {
      repository: { rootPath: "repo-stable", branch: "main", dirty: false },
      github: { owner: "example", name: "stable" },
      ghAvailable: true,
      authenticated: true,
      issuesAvailable: true,
      pullsAvailable: true,
      message: null,
    },
  });
  await expect(summary.locator(".task-review-menu")).toHaveCount(2);
  await expect
    .poll(() => summaryNodeState(page))
    .toEqual({ ...stableSummaryNodes, infoOpen: true });

  const activeTask = {
    ...task,
    ...canonicalTaskState("active", {
      turnId: "turn_summary_live",
      latestTurnStatus: "inProgress",
    }),
    title: "Canonical summary update",
    updatedMs: task.updatedMs + 1,
    recencyMs: task.recencyMs + 1,
  };
  await emitSummarySync(
    page,
    threadId,
    summaryDetail(activeTask, 2),
    "summary-state-update",
  );
  await expect(summary.locator("h2")).toHaveText("Canonical summary update");
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: active");
  await expect(
    taskDetailsPopover.locator('[data-task-info-field="status"]'),
  ).toHaveText("active");
  await expect(
    taskDetailsPopover.locator('[data-task-info-action="archive"]'),
  ).toBeDisabled();
  await expect
    .poll(() => summaryNodeState(page))
    .toEqual({ ...stableSummaryNodes, infoOpen: true });

  const [buttonBox, popoverBox] = await Promise.all([
    taskDetailsButton.boundingBox(),
    taskDetailsPopover.boundingBox(),
  ]);
  expect(buttonBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox.x).toBeGreaterThanOrEqual(7);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
    page.viewportSize().width - 7,
  );
  expect(popoverBox.y).toBeGreaterThanOrEqual(
    buttonBox.y + buttonBox.height + 4,
  );
  expect(buttonBox.x + buttonBox.width / 2).toBeGreaterThanOrEqual(
    popoverBox.x - 1,
  );
  expect(buttonBox.x + buttonBox.width / 2).toBeLessThanOrEqual(
    popoverBox.x + popoverBox.width + 1,
  );
  await captureReviewScreenshot(page, testInfo, "tasks-summary-live-popover");
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
  const taskDetailsPopover = summary.locator(".task-detail-popover");
  await summary.getByRole("button", { name: /Task details/ }).click();
  await expect(taskDetailsPopover).toBeVisible();
  await summary.evaluate((element) => {
    window.__taskSummaryOwner = element;
    window.__taskSummaryPopover = element.querySelector(".task-detail-popover");
  });

  await taskNavigator
    .locator(`.task-row[data-thread-id="${taskB.threadId}"]`)
    .click();
  await expect(summary.locator("h2")).toHaveText("Summary B");
  await expect(
    summary.getByRole("button", { name: "Repo B has no GitHub remote" }),
  ).toBeDisabled();
  await expect(taskDetailsPopover).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => {
          const summary = document.querySelector("caffold-task-detail-summary");
          return {
            owner: window.__taskSummaryOwner === summary,
            popoverReset:
              window.__taskSummaryPopover !==
              summary.querySelector(".task-detail-popover"),
          };
        },
      ),
    )
    .toEqual({ owner: true, popoverReset: true });

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
