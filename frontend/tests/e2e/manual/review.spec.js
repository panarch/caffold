import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualRepository,
  installManualTasks,
  MANUAL_TASKS,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installManualDefaults(page);
  await installManualTasks(page);
  await installManualRepository(page);
});

test("Working Tree shows the Task's changed files and their diff", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
  await page.getByRole("button", { name: "Working Tree", exact: true }).click();

  const review = page.locator("caffold-task-review");
  const file = review.locator(
    'button[data-file-tree-relative-path="src/settings/SettingsPage.tsx"]',
  );
  await file.click();
  await expect(file).toHaveAttribute("aria-current", "true");
  await expect(review.locator("caffold-review-file-viewer")).toContainText(
    "useThemePreference",
  );
  await expect(review).toContainText("dark-theme");
  await captureReviewScreenshot(page, testInfo, "review-working-tree");
});

test("Git Compare shows the changes between two refs", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(
    `/tasks/${MANUAL_TASKS.darkTheme.threadId}/git/compare` +
      "?base=origin%2Frelease%2F2.4&head=origin%2Fmain&file=src%2Fuploads%2FUploadButton.tsx",
  );

  const git = page.locator("caffold-task-git-layout");
  await expect(git.getByRole("combobox", { name: "Base ref" })).toHaveValue(
    "origin/release/2.4",
  );
  await expect(git.getByRole("combobox", { name: "Head ref" })).toHaveValue("origin/main");
  await expect(
    page.locator("caffold-git-compare-page caffold-review-file-viewer:not([hidden]) caffold-diff-viewer"),
  ).toContainText("ResumableUpload");
  await captureReviewScreenshot(page, testInfo, "git-compare");
});

test("a Pull Request offers Start Task", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}/github/pulls/214`);

  const pull = page.locator("caffold-github-pull-detail-page");
  await expect(pull).toContainText("Resume interrupted photo uploads");
  await expect(
    pull.getByRole("button", { name: "Start Task for pull request #214" }),
  ).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "github-pull-request");
});
