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

  await page.locator('button[data-file-tree-path="preview-image.svg"]').click();
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
      caffold-file-list .file-tree-scroll {
        max-height: 150px;
      }
    `,
  });

  const fileTree = page.locator("caffold-file-list");
  await fileTree.locator('button[data-file-tree-path="src"]').click();
  const planner = fileTree.locator('button[data-file-tree-path="src/planner"]');
  await expect(planner).toBeVisible();

  const beforeTop = await planner.evaluate(async (element) => {
    const scroller = element.closest(".file-tree-scroll");
    const scrollerTop = scroller.getBoundingClientRect().top;
    scroller.scrollTop += element.getBoundingClientRect().top - scrollerTop - 8;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return element.getBoundingClientRect().top;
  });

  await planner.click();
  await expect(
    fileTree.locator('button[data-file-tree-path="src/planner/mod.rs"]'),
  ).toBeVisible();
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

test(
  "fills horizontally scrolled file rows without a selection rail",
  async ({ page }, testInfo) => {
    await page.goto(FILES_HOME_URL);

    await expect(page.locator(`button[data-file-tree-path="${LONG_ROOT_FILE}"]`)).toBeVisible();
    const selectedFile = page.locator('button[data-file-tree-path="README.md"]');
    await selectedFile.click();
    if (testInfo.project.name === "phone") {
      await page.getByRole("button", { name: "Back to files" }).click();
    }

    const fileRowMetrics = await selectedFile.evaluate((element) => {
      const scroller = element.closest(".file-tree-scroll");
      scroller.scrollLeft = scroller.scrollWidth;
      const styles = window.getComputedStyle(element);

      return {
        borderLeftWidth: styles.borderLeftWidth,
        clientWidth: scroller.clientWidth,
        rowHeight: element.getBoundingClientRect().height,
        rowWidth: element.getBoundingClientRect().width,
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
      };
    });

    expect(fileRowMetrics.borderLeftWidth).toBe("0px");
    expect(fileRowMetrics.scrollWidth).toBeGreaterThan(fileRowMetrics.clientWidth);
    expect(fileRowMetrics.scrollLeft).toBeGreaterThan(0);
    expect(Math.abs(fileRowMetrics.rowWidth - fileRowMetrics.scrollWidth)).toBeLessThanOrEqual(1);
    if (testInfo.project.name === "desktop") {
      expect(fileRowMetrics.rowHeight).toBeCloseTo(24, 0);
    } else {
      expect(fileRowMetrics.rowHeight).toBeCloseTo(36, 0);
    }

    await page.addStyleTag({
      content: `button[data-file-tree-path="${LONG_ROOT_FILE}"] { display: none; }`,
    });
    const fittedRowMetrics = await selectedFile.evaluate((element) => {
      const scroller = element.closest(".file-tree-scroll");
      return {
        clientWidth: scroller.clientWidth,
        rowWidth: element.getBoundingClientRect().width,
        scrollWidth: scroller.scrollWidth,
      };
    });

    expect(fittedRowMetrics.scrollWidth).toBe(fittedRowMetrics.clientWidth);
    expect(Math.abs(fittedRowMetrics.rowWidth - fittedRowMetrics.clientWidth)).toBeLessThanOrEqual(
      1,
    );
  },
);

test("scrolls long names horizontally in Files and Changes", async ({ page }) => {
  await page.goto(FILES_HOME_URL);

  const fileTree = page.locator("caffold-file-list");
  await expect(
    fileTree.locator(`button[data-file-tree-path="${LONG_ROOT_FILE}"]`),
  ).toBeVisible();
  await expectHorizontalScroller(page, "caffold-file-list .file-tree-scroll");

  await fileTree.locator('button[data-file-tree-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");
  const changesTree = page.locator("caffold-git-diff-changes-tree");
  await expect(
    changesTree.locator(`button[data-file-tree-path="${LONG_CHANGE_FILE}"]`),
  ).toBeVisible();
  await expectHorizontalScroller(
    page,
    "caffold-git-diff-changes-tree .file-tree-scroll",
  );
});

test("scrolls long source lines horizontally in the code viewer", async ({ page }) => {
  const longLine = "long-source-token-".repeat(48);
  const content = Array.from({ length: 120 }, (_, index) =>
    index === 49 ? longLine : `source line ${index + 1}`,
  ).join("\n");

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
        size: content.length,
        modifiedMs: null,
        languageHint: "markdown",
        content,
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-file-tree-path="README.md"]').click();
  await expect(page.locator("caffold-code-viewer")).toContainText("long-source-token");
  await expectHorizontalScroller(page, "caffold-code-viewer .code-lines");
  await expectCodeViewerGutterSeparated(page);
  await expect
    .poll(() =>
      page.locator("caffold-code-viewer").evaluate((viewer) => {
        viewer.scrollToLine(60);
        return viewer.visibleLine();
      }),
    )
    .toBe(60);
});

test("sizes source and diff gutters from their longest rendered line numbers", async ({
  page,
}) => {
  await page.goto(FILES_HOME_URL);

  const widths = await page.evaluate(async () => {
    await Promise.all([
      customElements.whenDefined("caffold-code-viewer"),
      customElements.whenDefined("caffold-diff-viewer"),
    ]);

    const stage = document.createElement("div");
    stage.style.cssText = "position: fixed; inset: 0 auto auto 0; width: 600px; height: 200px;";
    document.body.append(stage);

    const codeViewer = document.createElement("caffold-code-viewer");
    codeViewer.style.cssText = "width: 600px; height: 100px;";
    stage.append(codeViewer);

    const sourceWidth = (lineCount) => {
      const content = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join(
        "\n",
      );
      codeViewer.setFile({ content, languageHint: "text" });
      return codeViewer.querySelector(".line-number").getBoundingClientRect().width;
    };

    const source = {
      oneDigit: sourceWidth(9),
      twoDigits: sourceWidth(99),
      fourDigits: sourceWidth(1_000),
    };

    const diffViewer = document.createElement("caffold-diff-viewer");
    diffViewer.style.cssText = "width: 600px; height: 100px;";
    stage.append(diffViewer);

    const diffWidths = (oldLine, newLine) => {
      diffViewer.setDiff({ diff: `@@ -${oldLine},1 +${newLine},1 @@\n context` });
      const row = diffViewer.querySelector(".diff-row-context");
      return {
        old: row.querySelector(".diff-old-line").getBoundingClientRect().width,
        new: row.querySelector(".diff-new-line").getBoundingClientRect().width,
      };
    };

    const diff = {
      shortOldLongNew: diffWidths(9, 999),
      longOldShortNew: diffWidths(10_000, 8),
    };

    stage.remove();
    return { diff, source };
  });

  expect(widths.source.oneDigit).toBeCloseTo(widths.source.twoDigits, 0);
  expect(widths.source.fourDigits).toBeGreaterThan(widths.source.twoDigits);
  expect(widths.diff.shortOldLongNew.new).toBeGreaterThan(
    widths.diff.shortOldLongNew.old,
  );
  expect(widths.diff.longOldShortNew.old).toBeGreaterThan(
    widths.diff.longOldShortNew.new,
  );
  expect(widths.diff.shortOldLongNew.old).toBeCloseTo(
    widths.diff.longOldShortNew.new,
    0,
  );
});

test("maps diff scroll positions to source lines", async ({ page }) => {
  await page.goto(FILES_HOME_URL);
  await page.addStyleTag({
    content: `
      caffold-diff-viewer[data-line-anchor-test] {
        display: block;
        height: 12rem;
      }
    `,
  });
  await page.evaluate(() => {
    const viewer = document.createElement("caffold-diff-viewer");
    viewer.dataset.lineAnchorTest = "";
    document.querySelector("caffold-files-page").append(viewer);
    const lines = Array.from(
      { length: 120 },
      (_, index) => ` source line ${index + 1}`,
    );
    viewer.setDiff({ diff: `@@ -1,120 +1,120 @@\n${lines.join("\n")}` });
  });

  await expect
    .poll(() =>
      page.locator("caffold-diff-viewer[data-line-anchor-test]").evaluate((viewer) => {
        viewer.scrollToLine(60);
        return viewer.visibleLine();
      }),
    )
    .toBe(60);
});

test("uses a single-pane file viewer on phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Only the phone layout switches browser panes.");

  await page.goto(FILES_HOME_URL);
  await page.addStyleTag({
    content: `
      caffold-file-list .file-tree-scroll {
        max-height: 140px;
      }
    `,
  });

  const fileBrowser = page.locator("caffold-file-browser");
  const fileList = page.locator("caffold-file-list .file-tree-scroll");
  const fileTarget = page.locator(`button[data-file-tree-path="${LONG_ROOT_FILE}"]`);
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
      caffold-file-list .file-tree-scroll,
      caffold-git-diff-page .file-tree-scroll {
        max-height: 72px;
      }
    `,
  });

  const fileList = page.locator("caffold-file-list .file-tree-scroll");
  const fileTarget = page.locator('button[data-file-tree-path="README.md"]');
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

  await page.locator('button[data-file-tree-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");

  const changesList = page.locator("caffold-git-diff-page .file-tree-scroll");
  const changeTarget = page.locator(`button[data-file-tree-path="${LONG_CHANGE_FILE}"]`);
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

  await page.locator('button[data-file-tree-path="README.md"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  await expect(page.locator("caffold-code-viewer")).toContainText("Fixture Home");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expectGlobalScrollLocked(page);

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "short-file-gutter");
});
