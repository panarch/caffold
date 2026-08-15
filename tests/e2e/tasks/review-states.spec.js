import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  openCompletedTaskForReview,
  selectTaskReviewScope,
} from "../support/task-review-test.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps a clean working tree explicit and offers branch review", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.cleanWorkingTree = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await expect(taskReview).toContainText("No changes.");
  await expect(taskReview).toContainText(
    "Review committed changes against the branch base.",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-review-clean-working-tree");
  await taskReview.getByRole("button", { name: "Review branch changes" }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
  );
});

test("names the selected base when a branch comparison is clean", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.cleanBranch = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
  );
  await expect(
    taskReview.getByText("No changes compared with origin/main.", { exact: true }),
  ).toHaveCount(1);
  await expect(taskReview).not.toContainText("No files changed.");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-review-clean-branch");
});

test("normalizes a non-Git task to Files and Source without hiding why", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
  taskScenario.updateTask({ worktree: null });
  await page.reload();
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
  );
  await expect(taskReview).toContainText("Git review is unavailable for this task.");
  await expect(
    tasksPage.locator('caffold-detail-view-switch button[data-detail-view="working"]'),
  ).toHaveCount(0);
  await expect(
    tasksPage.locator('caffold-detail-view-switch button[data-detail-view="branch"]'),
  ).toHaveCount(0);
  await expect(taskReview.locator('[data-review-value="changes"]')).toBeHidden();
  await expect(taskReview.locator('[data-review-value="diff"]')).toBeHidden();
  await expect(taskReview.getByRole("button", { name: "Files", exact: true })).toBeVisible();
  await expect(
    taskReview.locator("caffold-file-navigator").getByRole("button", {
      name: /alpha\.rs file/,
    }),
  ).toBeAttached();
  if (testInfo.project.name === "phone") {
    await expect(taskReview.locator('[data-review-value="source"]')).toBeHidden();
    await taskReview
      .locator("caffold-file-navigator")
      .getByRole("button", { name: /alpha\.rs file/ })
      .click();
  }
  await expect(taskReview.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-review-no-git");
});

test("keeps unchanged and deleted file representations explicit", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.edgeCaseFiles = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await taskReview.locator('button[data-file-tree-path="src/alpha.rs"]').click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText("pub const ALPHA");
  await taskReview.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(taskReview).toContainText("No changes in this scope.");
  if (test.info().project.name === "phone") {
    await expect(
      taskReview.getByRole("button", { name: "Back to navigator" }),
    ).toHaveCount(1);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-review-no-scope-changes");
  await taskReview.getByRole("button", { name: "View source" }).click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText("pub const ALPHA");

  if (test.info().project.name === "phone") {
    await taskReview.getByRole("button", { name: "Back to navigator" }).click();
  }
  await taskReview.getByRole("button", { name: "Changes", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="deleted.rs"]').click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?view=source&file=deleted.rs`,
  );
  await expect(taskReview).toContainText("This file was deleted in the selected scope.");
  if (test.info().project.name === "phone") {
    await expect(
      taskReview.getByRole("button", { name: "Back to navigator" }),
    ).toHaveCount(1);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-review-deleted-source");
});

test("keeps the last canonical working tree visible when a live update fails", async ({
  page,
}, testInfo) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  await expect(changes.locator('button[data-file-tree-kind="file"]')).toHaveCount(4);

  reviewScenario.failNextGitStatus = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 11,
      paths: ["src/planner.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect(taskReview).toContainText("Working tree update failed:");
  await expect(changes.locator('button[data-file-tree-kind="file"]')).toHaveCount(4);
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-review-update-error");
});
