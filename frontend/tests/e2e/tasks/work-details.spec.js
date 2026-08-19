import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("owns disclosure presentation and preserves its identity across canonical updates", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await installTaskLoopFixture(page, {
    contextPath: "Users/taehoon/Workspace/rust/codger",
    threadId: "thread_work_details_owner",
  });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);

  const owner = page.locator("caffold-task-work-details");
  const disclosure = owner.locator(":scope > details");
  const summary = disclosure.locator(":scope > summary");
  const collapsedChevron = summary.locator(
    ".task-work-details-chevron-collapsed",
  );
  const expandedChevron = summary.locator(
    ".task-work-details-chevron-expanded",
  );
  const chevronCenterDelta = (chevronSelector) =>
    summary.evaluate((element, selector) => {
      const label = element.querySelector(".task-work-details-label-text");
      const chevron = element.querySelector(selector);
      const labelRect = label.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();
      return Math.abs(
        labelRect.top + labelRect.height / 2 -
          (chevronRect.top + chevronRect.height / 2),
      );
    }, chevronSelector);

  await expect(owner).toHaveCount(1);
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(collapsedChevron).toBeVisible();
  await expect(expandedChevron).not.toBeVisible();
  await expect
    .poll(() => chevronCenterDelta(".task-work-details-chevron-collapsed"))
    .toBeLessThanOrEqual(1);

  await summary.evaluate((element) => {
    window.__workDetailsOwner = element.closest("caffold-task-work-details");
  });
  await summary.click();

  await expect(disclosure).toHaveAttribute("open", "");
  await expect(collapsedChevron).not.toBeVisible();
  await expect(expandedChevron).toBeVisible();
  await expect
    .poll(() => chevronCenterDelta(".task-work-details-chevron-expanded"))
    .toBeLessThanOrEqual(1);
  await captureReviewScreenshot(page, testInfo, "task-work-details-expanded");

  await expect
    .poll(() => page.evaluate(() => window.__caffoldMockEventSources.length))
    .toBeGreaterThan(0);
  await page.evaluate(
    ({ detail, threadId }) => {
      const source = window.__caffoldMockEventSources.find(
        (candidate) =>
          candidate.url === `/api/tasks/${threadId}/stream` &&
          candidate.readyState !== 2,
      );
      if (!source) {
        throw new Error(`Task detail stream not found for ${threadId}`);
      }
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        reason: "canonical-sync",
        detail,
      });
    },
    {
      threadId: scenario.threadId,
      detail: scenario.detailResponse({ revision: 2 }),
    },
  );

  await expect
    .poll(() => owner.evaluate((element) => element === window.__workDetailsOwner))
    .toBe(true);
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(expandedChevron).toBeVisible();
  expect(scenario.pageErrors).toEqual([]);
});
