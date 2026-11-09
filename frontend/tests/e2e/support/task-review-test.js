import { expect } from "@playwright/test";
import { installTaskLoopFixture } from "./task-loop-fixture.js";
import { installTaskReviewFixture } from "./task-review-fixture.js";

export async function openCompletedTaskForReview(page, options = {}) {
  const reviewScenario = await installTaskReviewFixture(page);
  options.configureReview?.(reviewScenario);
  const taskScenario = await installTaskLoopFixture(page);
  await taskScenario.seedCompletedTask();
  await page.goto(`/tasks/${taskScenario.threadId}`);
  return {
    reviewScenario,
    taskScenario,
    tasksPage: page.locator("caffold-tasks-page"),
    taskReview: page.locator("caffold-tasks-page caffold-task-review"),
  };
}

export async function selectTaskReviewScope(tasksPage, scope) {
  const option = tasksPage.locator(
    `caffold-segmented-control[data-detail-view-switch] button[data-segmented-value="${scope}"]`,
  );
  await option.click();
}

// While a file is open, the phone shows it alone and the drawer widths fold
// the navigator into a strip. A person returns to the navigator through Back
// on a phone and through the strip in the drawer widths.
export async function showReviewNavigator(taskReview, projectName) {
  if (projectName === "phone") {
    await taskReview.getByRole("button", { name: "Back to navigator" }).click();
  } else if (projectName === "foldable") {
    await taskReview.locator("caffold-split-view .split-view-strip").click();
  }
  await expect(taskReview.locator(".task-review-navigator-pane")).toBeVisible();
}
