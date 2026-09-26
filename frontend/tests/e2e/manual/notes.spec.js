import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualNotes,
  MANUAL_NOTE_ID,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installManualDefaults(page);
  await installManualNotes(page);
});

test("Notes shows the tree beside the open Note", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/notes/${MANUAL_NOTE_ID}`);

  const workspace = page.locator("caffold-notes-workspace");
  await expect(workspace.locator(".notes-workspace-detail-header > h1")).toHaveText(
    "Theme tokens",
  );
  await expect(workspace.locator(".notes-workspace-location")).toHaveText("Lumen / Decisions");
  await expect(workspace.locator("caffold-markdown-preview table")).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "notes");
});
