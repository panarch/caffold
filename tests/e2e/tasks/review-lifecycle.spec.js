import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("preserves conversation and task layout state while review tools activate independently", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  const conversation = tasksPage.locator(".task-conversation-pane");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  await expect(conversation).toBeVisible();
  await conversation.evaluate((element) =>
    element.setAttribute("data-persist-probe", "kept"),
  );
  await taskReview.evaluate((element) =>
    element.setAttribute("data-persist-probe", "kept"),
  );

  const conversationScroll = await conversationScroller.evaluate((element) => {
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(max / 2);
    return { max, top: element.scrollTop };
  });
  expect(conversationScroll.max).toBeGreaterThan(0);

  const masterState =
    testInfo.project.name === "desktop"
      ? await tasksPage.evaluate((element) => {
          const separator = element.querySelector(".tasks-master-resizer");
          separator.focus();
          separator.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
          );
          const list = element.querySelector(".task-list-scroll");
          list.style.height = "90px";
          list.scrollTop = 40;
          return {
            width: Math.round(
              element.querySelector(".tasks-list-pane").getBoundingClientRect().width,
            ),
            scrollTop: list.scrollTop,
          };
        })
      : null;

  await tasksPage.locator('button[data-summary-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect(conversation).toBeHidden();
  await expect
    .poll(() =>
      taskReview
        .locator("caffold-file-browser")
        .evaluate((browser) => browser.watchActive && Boolean(browser.watchUnsubscribe)),
    )
    .toBe(true);

  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(conversation).toBeVisible();
  await expect
    .poll(() =>
      taskReview
        .locator("caffold-file-browser")
        .evaluate((browser) => !browser.watchActive && !browser.watchUnsubscribe),
    )
    .toBe(true);

  await tasksPage.locator(".task-follow-up-form .task-model-button").click();
  await tasksPage.locator(".task-model-popover [data-effort=\"ultra\"]").click();
  const textarea = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await textarea.fill("Keep this draft while reviewing");
  const detailReadsBeforeDiff = taskScenario.taskDetailReadRequests;

  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  await expect(conversation).toBeHidden();
  await expect
    .poll(() => taskReview.evaluate((review) => Boolean(review.diffWatchUnsubscribe)))
    .toBe(true);

  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(conversation).toBeVisible();
  await expect(conversation).toHaveAttribute("data-persist-probe", "kept");
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect(textarea).toHaveValue("Keep this draft while reviewing");
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Ultra",
  );
  await expect
    .poll(() => taskReview.evaluate((review) => !review.diffWatchUnsubscribe))
    .toBe(true);
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationScroll.top,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(taskScenario.taskDetailReadRequests).toBe(detailReadsBeforeDiff);

  if (masterState) {
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(masterState.width);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(masterState.scrollTop);
  }
});
