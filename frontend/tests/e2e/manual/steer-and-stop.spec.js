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

for (const theme of ["light", "dark"]) {
  test.describe(`${theme} manual screenshots`, () => {
    test.beforeEach(async ({ page }) => {
      await installBrowserDefaults(page);
      await installManualDefaults(page, theme);
      await installManualTasks(page, { runningCheckout: true });
      await installManualRepository(page);
    });

    test("a running turn takes new prompts and can be stopped", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await page.goto(`/tasks/${MANUAL_TASKS.flakyCheckout.threadId}`);

      const conversation = page.locator("caffold-task-conversation");
      await expect(conversation).toContainText("Run it in WebKit too before you finish.");
      const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
      await expect(form.getByRole("button", { name: "Stop current turn" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `running-turn-${theme}`);
    });
  });
}
