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
