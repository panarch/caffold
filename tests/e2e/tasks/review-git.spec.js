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

test("reviews working tree changes through the canonical Review route", async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await expect(page.locator("caffold-review-workspace")).toBeHidden();

  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(taskReview).toBeVisible();
  await expect(changes.locator("button[data-change-path]")).toHaveCount(4);
  await expect(changes.locator('button[data-task-related="true"]')).toHaveCount(3);

  await changes.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?file=planner.rs`,
  );
  await expect(
    changes.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(viewer).toContainText("new planner behavior");

  const beforeWatch = reviewScenario.gitStatusRequests;
  reviewScenario.includeLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
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
  await expect(viewer).toContainText("new planner behavior");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");
});

test("keeps selectedPath while scope, navigator, and viewer switch independently", async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const workingTree = taskReview.locator("caffold-git-diff-changes-tree");
  await workingTree.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "new planner behavior",
  );

  const refsBefore = reviewScenario.gitRefsRequests;
  const compareBefore = reviewScenario.gitCompareRequests;
  await taskReview.getByRole("button", { name: "Branch", exact: true }).click();
  await expect.poll(() => reviewScenario.gitRefsRequests).toBeGreaterThan(refsBefore);
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(compareBefore);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(taskReview.locator("select[data-review-base]")).toHaveValue(
    "origin/main",
  );

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(
    compareTree.locator('button[data-compare-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "new branch behavior",
  );

  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "planner.rs",
  );

  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&nav=files&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(
    taskReview.locator('caffold-file-navigator button[data-entry-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");

  await taskReview.locator("select[data-review-base]").selectOption("origin/release");
  await expect(
    compareTree.locator('button[data-compare-path="src/release.rs"]'),
  ).toBeAttached();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");
});

test("keeps compact review controls and available panes inside the workspace", async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const layout = await taskReview.evaluate((element) => {
    const workspace = element.querySelector(".task-review-workspace");
    const pageRect = document.querySelector("caffold-tasks-page").getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const navigator = element.querySelector(".task-review-navigator-pane");
    const viewer = element.querySelector(".task-review-viewer-pane");
    return {
      leftGap: Math.abs(workspaceRect.left - pageRect.left),
      rightGap: Math.abs(workspaceRect.right - pageRect.right),
      horizontalOverflow: workspace.scrollWidth > workspace.clientWidth,
      navigatorWidth: navigator.getBoundingClientRect().width,
      viewerWidth: viewer.getBoundingClientRect().width,
      toolbarRows: Math.round(
        element.querySelector(".task-review-toolbar").getBoundingClientRect().height,
      ),
    };
  });

  expect(layout.leftGap).toBeLessThanOrEqual(1);
  expect(layout.rightGap).toBeLessThanOrEqual(1);
  expect(layout.horizontalOverflow).toBe(false);
  expect(layout.navigatorWidth).toBeGreaterThanOrEqual(220);
  if (testInfo.project.name === "phone") {
    expect(layout.viewerWidth).toBe(0);
  } else {
    expect(layout.viewerWidth).toBeGreaterThanOrEqual(360);
  }
  expect(layout.toolbarRows).toBeLessThanOrEqual(
    testInfo.project.name === "phone" ? 120 : 90,
  );
});

test("keeps a 180-file change set inspectable without clipping its identity", async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.largeChangeSet = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  await expect(changes.locator("button[data-change-path]")).toHaveCount(184);
  const longPath = changes.locator(
    'button[data-repo-relative-path="generated/deep/review/file-180-with-a-long-review-name.rs"]',
  );
  await expect(longPath).toHaveAttribute(
    "title",
    "generated/deep/review/file-180-with-a-long-review-name.rs",
  );
});

test("maps the visible source line when Diff and Source representations switch", async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await taskReview.locator('button[data-entry-path="src/planner.rs"]').click();

  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  expect(await viewer.evaluate((element) => element.scrollToLine(60))).toBe(true);
  await expect
    .poll(() => viewer.evaluate((element) => element.visibleLine()))
    .toBeGreaterThan(1);
  const sourceLine = await viewer.evaluate((element) => element.visibleLine());
  expect(sourceLine).toBeLessThanOrEqual(60);

  await taskReview.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(viewer.locator("caffold-diff-viewer")).toBeVisible();
  await expect.poll(() => viewer.evaluate((element) => element.visibleLine())).toBe(60);

  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  await expect
    .poll(() => viewer.evaluate((element) => element.visibleLine()))
    .toBe(sourceLine);
});

test("rejects a late branch response after the base changes", async ({ page }) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  reviewScenario.setCompareDelay("origin/main", 250);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.getByRole("button", { name: "Branch", exact: true }).click();
  await expect(taskReview.locator("select[data-review-base]")).toBeEnabled();
  await taskReview.locator("select[data-review-base]").selectOption("origin/release");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(
    compareTree.locator('button[data-compare-path="src/release.rs"]'),
  ).toBeAttached();
  await page.waitForTimeout(300);
  await expect(
    compareTree.locator('button[data-compare-path="src/planner.rs"]'),
  ).toHaveCount(0);
});
