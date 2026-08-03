import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps a clean working tree explicit and offers branch review", async ({ page }) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.cleanWorkingTree = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await expect(taskReview).toContainText("The working tree has no changes.");
  await taskReview.getByRole("button", { name: "Review branch changes" }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
  );
});

test("names the selected base when a branch comparison is clean", async ({ page }) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.cleanBranch = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.getByRole("button", { name: "Branch", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
  );
  await expect(taskReview).toContainText("No changes compared with origin/main.");
});

test("normalizes a non-Git task to Files and Source without hiding why", async ({ page }) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
  taskScenario.updateTask({ worktree: null });
  await page.reload();
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
  );
  await expect(taskReview).toContainText("Git review is unavailable for this task.");
  await expect(taskReview.getByRole("button", { name: "Changes", exact: true })).toBeDisabled();
  await expect(taskReview.getByRole("button", { name: "Diff", exact: true })).toBeDisabled();
});

test("keeps unchanged and deleted file representations explicit", async ({ page }) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.edgeCaseFiles = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await taskReview.locator('button[data-entry-path="src/alpha.rs"]').click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText("pub const ALPHA");
  await taskReview.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(taskReview).toContainText("No changes in this scope.");
  await taskReview.getByRole("button", { name: "View source" }).click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText("pub const ALPHA");

  await taskReview.getByRole("button", { name: "Changes", exact: true }).click();
  if (test.info().project.name === "phone") {
    await taskReview.getByRole("button", { name: "Back to navigator" }).click();
  }
  await taskReview.locator('button[data-repo-relative-path="deleted.rs"]').click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?view=source&file=deleted.rs`,
  );
  await expect(taskReview).toContainText("This file was deleted in the selected scope.");
});

test("keeps the last canonical working tree visible when refresh fails", async ({ page }) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  await expect(changes.locator("button[data-change-path]")).toHaveCount(4);

  reviewScenario.failNextGitStatus = true;
  await taskReview.getByRole("button", { name: "Refresh review" }).click();
  await expect(taskReview).toContainText("Working tree refresh failed:");
  await expect(changes.locator("button[data-change-path]")).toHaveCount(4);
});
