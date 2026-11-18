import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { actionHintDialog } from "../support/action-hints.js";
import {
  installManualDefaults,
  installManualLanguageServers,
  installManualRepository,
  installManualTasks,
  MANUAL_TASKS,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

for (const theme of ["light", "dark"]) {
  test.describe(`${theme} manual screenshots`, () => {
    test.beforeEach(async ({ page }) => {
      await installBrowserDefaults(page);
      await installManualDefaults(page, theme);
      await installManualTasks(page);
      await installManualRepository(page);
    });

    test("Working Tree shows the Task's changed files and their diff", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
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
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // A capture finishes CSS animations, and the file cards rise with a
      // diff's end, so the scene shows the diff at its end.
      await review.locator("caffold-diff-viewer .diff-lines").evaluate((lines) => {
        lines.scrollTop = lines.scrollHeight;
      });
      await captureReviewScreenshot(page, testInfo, `review-working-tree-${theme}`);
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
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `git-compare-${theme}`);
    });

    test("a name in a diff opens its menu, and Find references lists where it is declared and used", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await installManualLanguageServers(page);
      await openSettingsPageDiff(page);

      const review = page.locator("caffold-task-review");
      await review
        .locator('caffold-diff-viewer .diff-row[data-new-line="7"] .code-name')
        .filter({ hasText: /^useThemePreference$/ })
        .click();
      const menu = review.locator("caffold-code-name-menu");
      await expect(menu.getByRole("button")).toHaveText(["Go to definition", "Find references"]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `review-name-menu-${theme}`);

      await menu.getByRole("button", { name: "Find references" }).click();
      const places = review.locator("caffold-review-places");
      await expect(places.getByRole("heading", { level: 2 })).toHaveText("References");
      await expect(places.locator(".review-places-meta")).toHaveText("useThemePreference · 4");
      await expect(places.locator(".review-places-file-name")).toHaveText([
        "theme.ts",
        "SettingsPage.tsx",
        "AppearancePreview.tsx",
      ]);
      await expect(places.getByRole("button", { name: "Close references" })).toBeVisible();
      await captureReviewScreenshot(page, testInfo, `review-references-${theme}`);
    });

    test("G puts codes on the names in view", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await installManualLanguageServers(page);
      await openSettingsPageDiff(page);
      const name = page
        .locator('caffold-task-review caffold-diff-viewer .diff-row[data-new-line="7"] .code-name')
        .filter({ hasText: /^useThemePreference$/ });
      await expect(name).toBeVisible();

      await page.locator(".task-workspace-surface").evaluate((element) => element.focus({ preventScroll: true }));
      await page.keyboard.press("g");
      const dialog = actionHintDialog(page);
      await expect(dialog).toHaveAttribute("data-look", "names");
      await expect(dialog.getByLabel(/ — useThemePreference, line 7$/)).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `review-name-hints-${theme}`);
    });

    test("a Pull Request offers Start Task", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}/github/pulls/214`);

      const pull = page.locator("caffold-github-pull-detail-page");
      await expect(pull).toContainText("Resume interrupted photo uploads");
      await expect(
        pull.getByRole("button", { name: "Start Task for pull request #214" }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `github-pull-request-${theme}`);
    });
  });
}

// Opens the Working Tree diff of SettingsPage.tsx the way a person does.
async function openSettingsPageDiff(page) {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
  await page.getByRole("button", { name: "Working Tree", exact: true }).click();
  const review = page.locator("caffold-task-review");
  await review
    .locator('button[data-file-tree-relative-path="src/settings/SettingsPage.tsx"]')
    .click();
  await expect(review.locator("caffold-diff-viewer")).toContainText("useThemePreference");
}
