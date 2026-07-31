import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { FILES_HOME_URL } from "./support/file-browser-fixtures.js";
import { captureReviewScreenshot } from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("opens browser-local settings and persists viewer sizes", async ({ page }, testInfo) => {
  await page.goto(FILES_HOME_URL);

  const appMenu = page.locator("caffold-app-menu");
  await appMenu.locator(".app-menu-button").click();
  const popover = appMenu.locator(".app-menu-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Settings");
  await captureReviewScreenshot(page, testInfo, "app-menu-popover");
  await popover.locator('button[data-action="open-settings"]').click();

  await expect(page).toHaveURL("/settings");
  const settingsPage = page.locator("caffold-settings-page");
  await expect(settingsPage).toBeVisible();
  await expect(page.locator("caffold-pathbar")).toBeHidden();
  await expect(page.locator("caffold-files-page")).toBeHidden();

  const compact = settingsPage.locator(
    'button[data-action="set-file-tree-size"][data-value="compact"]',
  );
  const previewRow = settingsPage.locator(".settings-preview-row").first();
  const previewIcon = previewRow.locator(".settings-preview-icon");
  await settingsPage
    .locator('button[data-action="set-file-tree-size"][data-value="default"]')
    .click();
  await expect(previewRow).toHaveCSS("min-height", "30px");
  await expect(previewIcon).toHaveCSS("width", "18px");
  await compact.click();
  await expect(compact).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fileTreeSize))
    .toBe("compact");
  await expect(settingsPage.locator(".settings-tree-preview")).toHaveCSS(
    "font-size",
    "13px",
  );
  await expect(previewRow).toHaveCSS("min-height", "24px");
  await expect(previewIcon).toHaveCSS("width", "15px");

  const codePreview = settingsPage.locator(".settings-code-preview");
  const largeCode = settingsPage.locator(
    'button[data-action="set-code-size"][data-value="large"]',
  );
  await expect(codePreview).toHaveCSS("font-size", "13px");
  await settingsPage
    .locator('button[data-action="set-code-size"][data-value="default"]')
    .click();
  await expect(codePreview).toHaveCSS("font-size", "15px");
  await largeCode.click();
  await expect(largeCode).toHaveAttribute("aria-checked", "true");
  await expect(codePreview).toHaveCSS("font-size", "17px");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.codeSize))
    .toBe("large");

  const taskPreview = settingsPage.locator(".settings-task-preview");
  const taskPreviewGroup = taskPreview.locator(".settings-task-preview-group");
  const taskPreviewRow = taskPreview.locator(".settings-task-preview-row");
  const compactTasks = settingsPage.locator(
    'button[data-action="set-task-list-size"][data-value="compact"]',
  );
  await settingsPage
    .locator('button[data-action="set-task-list-size"][data-value="default"]')
    .click();
  await expect(taskPreviewRow).toHaveCSS("min-height", "36px");
  await expect(taskPreviewGroup).toHaveCSS("min-height", "28px");
  await compactTasks.click();
  await expect(compactTasks).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.taskListSize))
    .toBe("compact");
  await expect(taskPreview).toHaveCSS("font-size", "13px");
  await expect(taskPreviewRow).toHaveCSS("min-height", "30px");
  await expect(taskPreviewGroup).toHaveCSS("min-height", "24px");

  const taskDetailPreview = settingsPage.locator(".settings-task-detail-preview");
  const taskDetailMessage = taskDetailPreview.locator(
    '.settings-task-detail-message[data-message-role="assistant"] p',
  );
  const taskDetailMeta = taskDetailPreview.locator("time").first();
  const largeTaskDetail = settingsPage.locator(
    'button[data-action="set-task-detail-size"][data-value="large"]',
  );
  await expect(taskDetailPreview).toHaveCSS("font-size", "15px");
  await expect(taskDetailMessage).toHaveCSS("line-height", "22px");
  await expect(taskDetailMeta).toHaveCSS("font-size", "12px");
  await largeTaskDetail.click();
  await expect(largeTaskDetail).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.taskDetailSize))
    .toBe("large");
  await expect(taskDetailPreview).toHaveCSS("font-size", "17px");
  await expect(taskDetailMessage).toHaveCSS("line-height", "25px");
  await expect(taskDetailMeta).toHaveCSS("font-size", "14px");

  await captureReviewScreenshot(page, testInfo, "settings-appearance");
  await page.reload();
  await expect(page).toHaveURL("/settings");
  await expect(
    settingsPage.locator(
      'button[data-action="set-file-tree-size"][data-value="compact"]',
    ),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    settingsPage.locator('button[data-action="set-code-size"][data-value="large"]'),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    settingsPage.locator(
      'button[data-action="set-task-list-size"][data-value="compact"]',
    ),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    settingsPage.locator(
      'button[data-action="set-task-detail-size"][data-value="large"]',
    ),
  ).toHaveAttribute("aria-checked", "true");
  await settingsPage.locator('button[data-action="close-settings"]').click();
  await expect(page).toHaveURL("/tasks");
  await page.goto(FILES_HOME_URL);
  await expect(page.locator("caffold-file-list .file-entry").first()).toHaveCSS(
    "font-size",
    "13px",
  );
  await expect(page.locator("caffold-file-list .file-entry").first()).toHaveCSS(
    "min-height",
    "24px",
  );
  await expect(page.locator("caffold-file-list .entry-icon-svg").first()).toHaveCSS(
    "width",
    "15px",
  );
  await page.locator('button[data-entry-path="src"]').click();
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.locator("caffold-code-viewer .code-lines")).toHaveCSS(
    "font-size",
    "17px",
  );
  const codeLineHeight = await page
    .locator("caffold-code-viewer .code-lines")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
  expect(codeLineHeight).toBeGreaterThan(25);
  expect(codeLineHeight).toBeLessThan(30);

  await page.locator("caffold-file-viewer").evaluate((viewer) => {
    viewer.setDiff({
      path: "src/example.rs",
      repoRelativePath: "src/example.rs",
      kind: "Working tree",
      repository: { rootPath: "src" },
      diff: "@@ -1 +1 @@\n-old line\n+new line",
    });
  });
  await expect(page.locator("caffold-diff-viewer .diff-lines")).toHaveCSS(
    "font-size",
    "17px",
  );
});
