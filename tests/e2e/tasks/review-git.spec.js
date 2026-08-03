import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("reviews working tree changes and refreshes them from the task watch", async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect(page.locator("caffold-review-workspace")).toBeHidden();

  const diffView = taskReview.locator(".task-diff-view");
  const changes = diffView.locator("caffold-git-diff-changes-tree");
  const viewer = diffView.locator(
    '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
  );
  await expect(diffView).toBeVisible();
  await expect(changes.locator("button[data-change-path]")).toHaveCount(4);
  await expect(changes.locator('button[data-task-related="true"]')).toHaveCount(3);
  await expect(
    changes.locator('button[data-repo-relative-path="unrelated.rs"]'),
  ).not.toHaveAttribute("data-task-related", "true");

  await changes.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(
    changes.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(viewer).toContainText("new planner behavior");

  if (testInfo.project.name === "phone") {
    const before = reviewScenario.gitStatusRequests;
    await viewer.locator(".viewer-refresh-button").click();
    await expect.poll(() => reviewScenario.gitStatusRequests).toBeGreaterThan(before);
  }

  const beforeWatch = reviewScenario.gitStatusRequests;
  reviewScenario.includeLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) => candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 4,
      paths: ["src/live-update.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect.poll(() => reviewScenario.gitStatusRequests).toBeGreaterThan(beforeWatch);
  await expect(
    changes.locator('button[data-repo-relative-path="live-update.rs"]'),
  ).toHaveCount(1);
  await expect(
    changes.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(viewer).toContainText("new planner behavior");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");
});

test("reviews branch changes and preserves each scope selection", async ({
  page,
}, testInfo) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();

  const diffView = taskReview.locator(".task-diff-view");
  const workingTree = diffView.locator("caffold-git-diff-changes-tree");
  await workingTree.locator('button[data-repo-relative-path="planner.rs"]').click();

  const refsBefore = reviewScenario.gitRefsRequests;
  const compareBefore = reviewScenario.gitCompareRequests;
  await diffView.getByRole("button", { name: "Branch" }).click();
  await expect(diffView).toHaveAttribute("data-task-diff-mode", "branch");
  await expect.poll(() => reviewScenario.gitRefsRequests).toBeGreaterThan(refsBefore);
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(compareBefore);
  await expect(diffView.locator("select[data-task-compare-base]")).toHaveValue(
    "origin/main",
  );
  await expect(diffView.locator("[data-task-compare-head]")).toHaveText("main");

  const compareTree = diffView.locator("caffold-git-compare-tree");
  await compareTree.locator('button[data-compare-path="src/planner.rs"]').click();
  await expect.poll(() => reviewScenario.gitCompareDiffRequests).toBeGreaterThan(0);
  const compareViewer = diffView.locator(
    '.task-diff-panel[data-task-diff-panel="branch"] caffold-review-file-viewer',
  );
  await expect(compareViewer).toContainText("new branch behavior");

  await diffView.locator("select[data-task-compare-base]").selectOption("origin/release");
  await expect(
    compareTree.locator('button[data-compare-path="src/release.rs"]'),
  ).toBeVisible();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");

  await diffView.getByRole("button", { name: "Working Tree" }).click();
  await expect(diffView).toHaveAttribute("data-task-diff-mode", "working");
  await expect(
    workingTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    diffView.locator(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
    ),
  ).toContainText("new planner behavior");
});

test("uses compact review controls without overflowing the task workspace", async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();

  const layout = await taskReview.locator(".task-diff-view").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;height:var(--interface-compact-control-size)";
    document.body.append(probe);
    const compact = probe.getBoundingClientRect().height;
    probe.remove();
    const pageRect = document.querySelector("caffold-tasks-page").getBoundingClientRect();
    const viewRect = element.getBoundingClientRect();
    return {
      compact,
      controls: [
        ...element.querySelectorAll(".task-diff-mode-switch button"),
        element.querySelector('[data-task-review-action="refresh"]'),
      ].map((control) => control.getBoundingClientRect().height),
      leftGap: Math.abs(viewRect.left - pageRect.left),
      rightGap: Math.abs(viewRect.right - pageRect.right),
      horizontalOverflow: element.scrollWidth > element.clientWidth,
    };
  });

  for (const height of layout.controls) {
    expect(height).toBeCloseTo(layout.compact, 1);
  }
  expect(layout.leftGap).toBeLessThanOrEqual(1);
  expect(layout.rightGap).toBeLessThanOrEqual(1);
  expect(layout.horizontalOverflow).toBe(false);
});

test("keeps a large change set inspectable without clipping long paths", async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.largeChangeSet = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  await expect(changes.locator("button[data-change-path]")).toHaveCount(184);
  const longPath = changes.locator(
    'button[data-repo-relative-path="generated/deep/review/file-180-with-a-long-review-name.rs"]',
  );
  await expect(longPath).toHaveCount(1);
  await expect(longPath).toHaveAttribute(
    "title",
    "generated/deep/review/file-180-with-a-long-review-name.rs",
  );
});
