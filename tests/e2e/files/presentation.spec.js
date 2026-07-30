import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
  scrollTop,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";
import {
  clickHeaderAction,
} from "../support/header-actions.js";
import {
  expectGlobalScrollLocked,
  leftPanelWidth,
  dragHorizontalResizer,
  expectPreservedScroll,
  expectHorizontalScroller,
  expectCodeViewerGutterSeparated,
  expectMobileBrowserViewerOverlay,
  expectMobileViewerCompactHeader,
} from "../support/review-layout.js";
import {
  FILES_HOME_URL,
  LONG_ROOT_FILE,
  LONG_CHANGE_FILE,
} from "../support/file-browser-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("previews image files in the viewer", async ({ page }, testInfo) => {
  await page.goto(FILES_HOME_URL);

  await page.locator('button[data-entry-path="preview-image.svg"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("preview-image.svg");
  await expect(page.locator("caffold-file-viewer")).toContainText("SVG image");
  await page.getByRole("button", { name: "Show details for preview-image.svg" }).click();
  const details = page.locator("caffold-file-viewer .viewer-meta-popover");
  await expect(details.locator('[data-field="size"] dd')).toHaveText("325 B");
  await expect(details.locator('[data-field="type"] dd')).toHaveText("SVG image");

  const preview = page.locator("caffold-file-viewer img.image-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute(
    "src",
    /\/api\/image\?path=preview-image\.svg&revision=\d+$/,
  );
  await expect(
    preview.evaluate((image) => image.complete && image.naturalWidth > 0),
  ).resolves.toBe(true);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "image-file-viewer");
});

test("keeps the toggled tree row anchored while expanding", async ({ page }) => {
  await page.goto(FILES_HOME_URL);
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list {
        max-height: 150px;
      }
    `,
  });

  await page.locator('button[data-entry-path="src"]').click();
  const planner = page.locator('button[data-entry-path="src/planner"]');
  await expect(planner).toBeVisible();

  const beforeTop = await planner.evaluate((element) => {
    const scroller = element.closest(".file-list");
    scroller.scrollTop = 0;
    return element.getBoundingClientRect().top;
  });

  await planner.click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.waitForTimeout(50);

  const afterTop = await planner.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
});

test("resizes the left file panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The phone layout stacks panels vertically.");

  await page.goto(FILES_HOME_URL);
  const handle = page.locator(".panel-resizer");
  await expect(handle).toBeVisible();

  const beforeWidth = await leftPanelWidth(page);
  await dragHorizontalResizer(page, handle, 96);

  const afterWidth = await leftPanelWidth(page);
  expect(afterWidth).toBeGreaterThan(beforeWidth + 48);
  await captureReviewScreenshot(page, testInfo, "file-panel-resized");
});

test("scrolls long names horizontally in Files and Changes", async ({ page }) => {
  await page.goto(FILES_HOME_URL);

  await expect(page.locator(`button[data-entry-path="${LONG_ROOT_FILE}"]`)).toBeVisible();
  await expectHorizontalScroller(page, ".file-list");

  await page.locator('button[data-entry-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");
  await expect(page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`)).toBeVisible();
  await expectHorizontalScroller(page, ".changes-tree-list");
});

test("scrolls long source lines horizontally in the code viewer", async ({ page }) => {
  const longLine = "long-source-token-".repeat(48);

  await page.route(/\/api\/file(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "README.md") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        path: "README.md",
        name: "README.md",
        size: longLine.length,
        modifiedMs: null,
        languageHint: "markdown",
        content: `# Fixture Home\n\n${longLine}\n`,
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("caffold-code-viewer")).toContainText("long-source-token");
  await expectHorizontalScroller(page, "caffold-code-viewer .code-lines");
  await expectCodeViewerGutterSeparated(page);
});

test("uses a single-pane file viewer on phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Only the phone layout switches browser panes.");

  await page.goto(FILES_HOME_URL);
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list {
        max-height: 140px;
      }
    `,
  });

  const fileBrowser = page.locator("caffold-file-browser");
  const fileList = page.locator("caffold-file-list .file-list");
  const fileTarget = page.locator(`button[data-entry-path="${LONG_ROOT_FILE}"]`);
  await expect(fileBrowser).toHaveAttribute("data-browser-view", "list");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toBeHidden();

  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(fileBrowser).toHaveAttribute("data-browser-view", "viewer");
  await expect(page.locator("caffold-file-list")).toBeHidden();
  await expect(page.locator("caffold-file-viewer")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toContainText(LONG_ROOT_FILE);
  await expect(page.getByRole("button", { name: "Back to files" })).toBeVisible();
  await expectMobileBrowserViewerOverlay(page);
  await expectMobileViewerCompactHeader(page);
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "mobile-file-viewer-single-pane");

  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(fileBrowser).toHaveAttribute("data-browser-view", "list");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toBeHidden();
  await expect(fileTarget).toHaveAttribute("aria-current", "true");
  await expectPreservedScroll(fileList, beforeFileScroll);
});

test("keeps list scroll positions when selecting files and changes", async ({ page }, testInfo) => {
  await page.goto(FILES_HOME_URL);
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list,
      caffold-git-diff-page .changes-tree-list {
        max-height: 72px;
      }
    `,
  });

  const fileList = page.locator("caffold-file-list .file-list");
  const fileTarget = page.locator('button[data-entry-path="README.md"]');
  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page.locator("caffold-file-list")).toBeVisible();
  }
  await expectPreservedScroll(fileList, beforeFileScroll);

  await page.locator('button[data-entry-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");

  const changesList = page.locator("caffold-git-diff-page .changes-tree-list");
  const changeTarget = page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`);
  await changeTarget.scrollIntoViewIfNeeded();
  const beforeChangesScroll = await scrollTop(changesList);
  expect(beforeChangesScroll).toBeGreaterThan(0);

  await changeTarget.click();
  await expect(page.locator("caffold-diff-viewer")).toContainText("long_change_name_fixture");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(page.locator("caffold-git-diff-page")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(changesList).toBeVisible();
  }
  await expectPreservedScroll(changesList, beforeChangesScroll);
});

test("extends the line-number gutter for short files", async ({ page }, testInfo) => {
  await page.goto(FILES_HOME_URL);

  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  await expect(page.locator("caffold-code-viewer")).toContainText("Fixture Home");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expectGlobalScrollLocked(page);

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "short-file-gutter");
});
