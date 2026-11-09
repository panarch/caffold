import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualNotes,
  installManualRepository,
  installManualTasks,
  MANUAL_NOTE_ID,
  MANUAL_TASKS,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

test.use({ timezoneId: "UTC", locale: "en-US" });

// The homepage shows the same Task and next instruction on two screens.
// Capture both themes from the real interface, with the manual's sample data.
for (const theme of ["light", "dark"]) {
  test(`continue the same Task in ${theme} mode`, { tag: ["@foldable", "@phone"] }, async ({ page }, testInfo) => {
    await installBrowserDefaults(page);
    await installManualDefaults(page, theme);
    await installManualTasks(page);
    await installManualRepository(page);
    await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);

    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".task-detail-heading")).toContainText(MANUAL_TASKS.darkTheme.title);
    await expect(page.locator('caffold-task-assistant-message[data-message-phase="final"]')).toContainText(
      "Settings now has an Appearance choice",
    );
    const plan = page.locator("caffold-task-current-plan .task-current-plan-strip");
    await expect(plan).toHaveAttribute("data-presentation", "ready");
    await expect(plan).toContainText("5 / 5");

    const composer = page.locator('.task-follow-up-form textarea[name="prompt"]');
    await composer.fill("Add a live preview beside the theme picker.");
    await composer.blur();
    await expect(composer).toHaveValue("Add a live preview beside the theme picker.");
    await expect(page.locator('.task-follow-up-form button[type="submit"]')).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await captureReviewScreenshot(page, testInfo, `landing-task-${theme}`);
  });
}

// The product tour uses wide and phone views of each surface, in both themes.
for (const theme of ["light", "dark"]) {
  test.describe(`homepage tour in ${theme} mode`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      // A narrower desktop capture keeps the featured controls legible when
      // the homepage places its selector alongside the image.
      if (testInfo.project.name === "desktop") {
        await page.setViewportSize({ width: 960, height: 640 });
      }
      await installBrowserDefaults(page);
      await installManualDefaults(page, theme);
      await installManualRepository(page);
    });

    test("work with the agent during a running turn", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
      await installManualTasks(page, { runningCheckout: true });
      await page.goto(`/tasks/${MANUAL_TASKS.flakyCheckout.threadId}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const conversation = page.locator("caffold-task-conversation");
      await expect(conversation).toContainText("Run it in WebKit too before you finish.");
      await expect(conversation).toContainText("tests/e2e/checkout.spec.ts");
      await expect(page.getByRole("button", { name: "Stop current turn", exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await captureReviewScreenshot(page, testInfo, `landing-work-${theme}`);
    });

    test("see what changed in the Working Tree", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
      // Review keeps its file list beside the diff only from 1,061px, so this
      // scene is captured wider in the same 3:2 shape.
      if (testInfo.project.name === "desktop") {
        await page.setViewportSize({ width: 1080, height: 720 });
      }
      await installManualTasks(page);
      await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("button", { name: "Working Tree", exact: true }).click();
      const review = page.locator("caffold-task-review");
      await review.locator('button[data-file-tree-relative-path="src/settings/SettingsPage.tsx"]').click();
      const viewer = review.locator("caffold-review-file-viewer");
      await expect(viewer).toBeVisible();
      await expect(viewer).toContainText("useThemePreference");
      await page.evaluate(() => document.fonts.ready);
      await captureReviewScreenshot(page, testInfo, `landing-changes-${theme}`);
    });

    test("move between Tasks with the Task Switcher", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
      await installManualTasks(page);
      await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("caffold-task-conversation")).toContainText("Dark theme is ready to review");
      await page.locator(".task-workspace-surface").focus();
      await page.keyboard.press("t");
      const dialog = page.locator("caffold-task-switcher-dialog > dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".task-switcher-row-title").first()).toHaveText(MANUAL_TASKS.darkTheme.title);
      await expect(dialog).toContainText(MANUAL_TASKS.flakyCheckout.title);
      await page.evaluate(() => document.fonts.ready);
      await captureReviewScreenshot(page, testInfo, `landing-tasks-${theme}`);
    });

    test("carry context in Notes", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
      await installManualTasks(page);
      await installManualNotes(page);
      await page.goto(`/notes/${MANUAL_NOTE_ID}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const primary = page.locator('caffold-note-document[data-note-side="primary"]');
      const navigator = page.locator("caffold-notes-navigator");
      await expect(primary.locator("caffold-markdown-preview table")).toBeVisible();
      await expect(primary.locator(".notes-workspace-location")).toHaveText("Lumen / Decisions");
      await expect(navigator).toHaveCount(1);
      if (testInfo.project.name === "phone") {
        await expect(navigator).toBeHidden();
        await expect(primary.getByRole("button", { name: "Back to notes" })).toBeVisible();
      } else {
        await expect(navigator).toBeVisible();
        await navigator.getByRole("button", { name: "Expand Launch", exact: true }).click();
        await expect(navigator.getByRole("button", { name: "Announcement outline", exact: true })).toBeVisible();
        await expect(navigator.getByRole("button", { name: "Theme tokens", exact: true })).toHaveAttribute("aria-current", "true");
        await expect(navigator.getByRole("button", { name: "Resumable uploads", exact: true })).toBeVisible();
        await expect(navigator.getByRole("button", { name: "Release checklist", exact: true })).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);
      await captureReviewScreenshot(page, testInfo, `landing-notes-${theme}`);
    });
  });
}
