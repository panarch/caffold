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

  const workspace = page.locator('caffold-note-document[data-note-side="primary"]');
  await expect(workspace.locator(".notes-workspace-detail-header > h1")).toHaveText(
    "Theme tokens",
  );
  await expect(workspace.locator(".notes-workspace-location")).toHaveText("Lumen / Decisions");
  await expect(workspace.locator("caffold-markdown-preview table")).toBeVisible();
  await expect(workspace.getByRole("button", { name: "View side by side" }).locator("svg")).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "notes");
});

test("Notes keeps theme decisions beside the release checklist", { tag: "@foldable" }, async ({ page }, testInfo) => {
  await page.goto(`/notes/${MANUAL_NOTE_ID}`);
  const primary = page.locator('caffold-note-document[data-note-side="primary"]');
  await primary.getByRole("button", { name: "View side by side" }).click();
  const picker = page.locator('caffold-notes-navigator[data-picker="secondary"]');
  await expect(picker.getByRole("heading", { name: "Choose a note to read alongside" })).toBeVisible();
  await picker.getByRole("button", { name: "Release checklist", exact: true }).click();

  const secondary = page.locator('caffold-note-document[data-note-side="secondary"]');
  await expect(primary.locator("caffold-markdown-preview table")).toBeVisible();
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Release checklist");
  await expect(secondary.locator("caffold-markdown-preview")).toContainText("Review the theme tokens against the final UI.");
  await expect(page).toHaveURL(`/notes/${MANUAL_NOTE_ID}?beside=note-release-checklist`);
  await expect(primary.getByRole("button", { name: /choose another note/ })).toBeVisible();
  await expect(secondary.getByRole("button", { name: "Close side by side" })).toBeVisible();
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "notes-side-by-side");
});

test("Notes chooses another companion while keeping the reference open", { tag: "@foldable" }, async ({ page }, testInfo) => {
  await page.goto(`/notes/${MANUAL_NOTE_ID}?beside=note-release-checklist`);
  const primary = page.locator('caffold-note-document[data-note-side="primary"]');
  const secondary = page.locator('caffold-note-document[data-note-side="secondary"]');
  await expect(primary.locator("caffold-markdown-preview table")).toBeVisible();
  await secondary.getByRole("button", { name: "Release checklist, choose another note" }).click();

  const picker = page.locator('caffold-notes-navigator[data-picker="secondary"]');
  await expect(picker.getByRole("heading", { name: "Choose another note" })).toBeVisible();
  await picker.getByRole("button", { name: "Expand Launch", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Announcement outline", exact: true })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Cancel note selection" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Close side by side" })).toBeVisible();
  await expect(primary.locator("caffold-markdown-preview table")).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "notes-side-by-side-picker");

  await picker.getByRole("button", { name: "Announcement outline", exact: true }).click();
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Announcement outline");
  await expect(primary.locator("caffold-markdown-preview h1")).toHaveText("Theme tokens");
  await expect(page).toHaveURL(`/notes/${MANUAL_NOTE_ID}?beside=note-announcement`);
});
