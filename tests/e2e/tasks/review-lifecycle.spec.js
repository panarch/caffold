import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("preserves conversation and thread-local Review state while lifecycles deactivate", async ({
  page,
}) => {
  const { taskScenario, tasksPage } = await openCompletedTaskForReview(page);
  const conversation = tasksPage.locator(".task-conversation-pane");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  await conversation.evaluate((element) => element.setAttribute("data-persist-probe", "kept"));
  const conversationScroll = await conversationScroller.evaluate(async (element) => {
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(max / 2);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return element.scrollTop;
  });

  const textarea = tasksPage.locator('.task-follow-up-form textarea[name="prompt"]');
  await textarea.fill("Keep this draft while reviewing");
  const detailReadsBeforeReview = taskScenario.taskDetailReadRequests;

  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  const review = tasksPage.locator("caffold-task-review");
  await expect(review).toBeVisible();
  await review.evaluate((element) => {
    element.setAttribute("data-persist-probe", "kept");
    element.panelWidth = 360;
    element.resizer().setValue(360);
    element.applyPanelWidth();
  });
  await expect(conversation).toBeHidden();
  await expect
    .poll(() =>
      review.evaluate((element) => Boolean(element.watchUnsubscribe)),
    )
    .toBe(true);

  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect(conversation).toBeVisible();
  await expect(conversation).toHaveAttribute("data-persist-probe", "kept");
  await expect(textarea).toHaveValue("Keep this draft while reviewing");
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationScroll,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(taskScenario.taskDetailReadRequests).toBe(detailReadsBeforeReview);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__caffoldMockEventSources.filter(
            (source) => source.url.startsWith("/api/watch?") && source.readyState !== 2,
          ).length,
      ),
    )
    .toBe(0);

  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(review).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      review.evaluate((element) => Math.round(element.panelWidth)),
    )
    .toBe(360);
});
