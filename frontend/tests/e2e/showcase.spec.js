import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { installShowcaseFixture } from "./support/showcase-fixture.js";
import { captureReviewScreenshot } from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("renders a representative review-first workspace", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const showcase = await installShowcaseFixture(page);
  await page.goto(`/tasks/${showcase.threadId}`);

  const tasksPage = page.locator("caffold-tasks-page");
  const navigator = page.locator("caffold-task-navigator");
  const selectedRow = navigator.locator(
    `.task-row[data-thread-id="${showcase.threadId}"]`,
  );
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "d2-coding",
  );
  await expect(tasksPage).toHaveCSS("font-family", /Caffold D2 Coding/);
  await expect(selectedRow).toHaveAttribute("aria-current", "true");
  await expect(navigator).toContainText("Stabilize mobile task navigation");
  await expect(navigator).toContainText("Review notification settings");
  await expect(tasksPage.locator(".task-detail-heading")).toContainText(
    "Refine README onboarding",
  );

  const finalResponse = tasksPage.locator(
    'caffold-task-assistant-message[data-message-phase="final"]',
  );
  await expect(finalResponse).toContainText("README is ready to review");
  await expect(finalResponse).toContainText("host-local voice input");
  await expect(
    tasksPage.getByRole("button", { name: "Start voice input" }),
  ).toBeEnabled();
  await captureReviewScreenshot(
    page,
    testInfo,
    "showcase-review-first-conversation",
  );

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const review = tasksPage.locator("caffold-task-review");
  const readme = review.locator(
    'button[data-file-tree-relative-path="README.md"]',
  );
  await expect(readme).toBeVisible();
  await readme.click();
  await expect(readme).toHaveAttribute("aria-current", "true");
  await expect(review.locator("caffold-review-file-viewer")).toContainText(
    "Caffold is a browser interface",
  );
  await expect(review).toContainText(showcase.branch);
  await captureReviewScreenshot(
    page,
    testInfo,
    "showcase-working-tree-review",
  );
});
