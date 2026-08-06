import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("uses two panes off phone and a semantic navigator/viewer split on phone", async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const before = await taskReview.evaluate((review) => {
    const toolbar = review.querySelector(".task-review-toolbar");
    const navigator = review.querySelector(".task-review-navigator-pane");
    const viewer = review.querySelector(".task-review-viewer-pane");
    return {
      overflow: review.scrollWidth > review.clientWidth,
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
      navigatorVisible: getComputedStyle(navigator).display !== "none",
      viewerVisible: getComputedStyle(viewer).display !== "none",
      toolbarRows: new Set(
        [...toolbar.querySelectorAll(".task-review-axis, .task-review-base")]
          .filter((control) => getComputedStyle(control).display !== "none")
          .map((control) => Math.round(control.getBoundingClientRect().top)),
      ).size,
    };
  });
  expect(before.overflow).toBe(false);
  expect(before.toolbarOverflow).toBe(false);
  expect(before.navigatorVisible).toBe(true);
  expect(before.viewerVisible).toBe(testInfo.project.name !== "phone");
  if (testInfo.project.name === "phone") {
    expect(before.toolbarRows).toBeLessThanOrEqual(2);
  }

  const summaryClearance = await page.evaluate(() => {
    const closeButton = document.querySelector(".codex-workspace-close");
    const close = closeButton.getBoundingClientRect();
    const heading = document
      .querySelector("caffold-task-detail-summary .task-detail-heading h2")
      .getBoundingClientRect();
    return {
      closeLabel: closeButton.getAttribute("aria-label"),
      closeRight: close.right,
      closeTitleCenterDelta: Math.abs(
        close.top + close.height / 2 -
          (heading.top + heading.height / 2),
      ),
      closeVisible:
        getComputedStyle(closeButton).display !== "none" && close.width > 0,
      headingLeft: heading.left,
      headingWidth: heading.width,
    };
  });
  expect(summaryClearance.closeVisible).toBe(true);
  expect(summaryClearance.closeLabel).toBe("Back to task");
  expect(summaryClearance.closeTitleCenterDelta).toBeLessThanOrEqual(2);
  expect(summaryClearance.headingLeft).toBeGreaterThanOrEqual(
    summaryClearance.closeRight,
  );
  expect(summaryClearance.headingWidth).toBeGreaterThanOrEqual(100);

  await taskReview.locator('button[data-repo-relative-path="planner.rs"]').click();
  const after = await taskReview.evaluate((review) => {
    const navigator = review.querySelector(".task-review-navigator-pane");
    const viewer = review.querySelector(".task-review-viewer-pane");
    return {
      overflow: review.scrollWidth > review.clientWidth,
      navigatorVisible: getComputedStyle(navigator).display !== "none",
      viewerVisible: getComputedStyle(viewer).display !== "none",
    };
  });
  expect(after.overflow).toBe(false);
  expect(after.viewerVisible).toBe(true);
  expect(after.navigatorVisible).toBe(testInfo.project.name !== "phone");
});

test("keeps one compact file-navigation header on phone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Phone owns the single-pane back control.");
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.locator('button[data-repo-relative-path="planner.rs"]').click();

  const backButtons = taskReview.getByRole("button", { name: "Back to navigator" });
  await expect(backButtons).toHaveCount(1);
  await expect(backButtons).toHaveAttribute("data-close-mode", "back");
  await expect(taskReview.locator(".task-review-mobile-back")).toHaveCount(0);
  await expect(
    taskReview.locator("caffold-review-file-viewer .viewer-info-button"),
  ).toHaveCount(1);

  const geometry = await taskReview.evaluate((review) => {
    const toolbar = review.querySelector(".task-review-toolbar");
    const refresh = review.querySelector(".task-review-refresh");
    const viewerHeader = review.querySelector("caffold-review-file-viewer .viewer-header");
    const close = viewerHeader.querySelector(".viewer-close-button");
    const info = viewerHeader.querySelector(".viewer-info-button");
    const titleBlock = viewerHeader.querySelector(".viewer-title-block");
    const toolbarRect = toolbar.getBoundingClientRect();
    const refreshRect = refresh.getBoundingClientRect();
    const headerRect = viewerHeader.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const infoRect = info.getBoundingClientRect();
    const titleBlockRect = titleBlock.getBoundingClientRect();
    const hitOutset = Math.abs(
      Number.parseFloat(getComputedStyle(close, "::before").top),
    );
    return {
      closeHeight: closeRect.height,
      closeWidth: closeRect.width,
      headerHeight: headerRect.height,
      hitHeight: closeRect.height + hitOutset * 2,
      infoHeight: infoRect.height,
      infoWidth: infoRect.width,
      overflow: review.scrollWidth > review.clientWidth,
      refreshBottom: refreshRect.bottom,
      refreshRight: refreshRect.right,
      refreshTop: refreshRect.top,
      toolbarBottom: toolbarRect.bottom,
      toolbarRight: toolbarRect.right,
      toolbarTop: toolbarRect.top,
      titleCenter: titleBlockRect.top + titleBlockRect.height / 2,
      headerCenter: headerRect.top + headerRect.height / 2,
    };
  });

  expect(geometry.overflow).toBe(false);
  expect(geometry.refreshTop).toBeGreaterThanOrEqual(geometry.toolbarTop);
  expect(geometry.refreshBottom).toBeLessThanOrEqual(geometry.toolbarBottom);
  expect(geometry.refreshRight).toBeLessThanOrEqual(geometry.toolbarRight);
  expect(geometry.closeWidth).toBeLessThanOrEqual(36);
  expect(geometry.closeHeight).toBeLessThanOrEqual(36);
  expect(geometry.infoWidth).toBeCloseTo(geometry.closeWidth, 1);
  expect(geometry.infoHeight).toBeCloseTo(geometry.closeHeight, 1);
  expect(geometry.hitHeight).toBeGreaterThanOrEqual(40);
  expect(geometry.headerHeight).toBeLessThanOrEqual(42);
  expect(Math.abs(geometry.titleCenter - geometry.headerCenter)).toBeLessThanOrEqual(1);

  await captureReviewScreenshot(page, testInfo, "tasks-review-phone-file");
  await backButtons.click();
  await expect(taskReview).not.toHaveAttribute("data-file-selected", "");
});

test("clamps the navigator so the shared viewer keeps its minimum width", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Phone intentionally shows one pane at a time.");
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.evaluate((review) => {
    review.resizer().setValue(10_000);
    review.panelWidth = review.resizer().currentValue;
    review.applyPanelWidth();
  });
  const widths = await taskReview.evaluate((review) => ({
    navigator: review.querySelector(".task-review-navigator-pane").getBoundingClientRect().width,
    viewer: review.querySelector(".task-review-viewer-pane").getBoundingClientRect().width,
  }));
  expect(widths.navigator).toBeGreaterThanOrEqual(220);
  expect(widths.viewer).toBeGreaterThanOrEqual(360);
});

test("keeps Review reflowed at the appearance extremes", async ({ page }, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.locator('button[data-repo-relative-path="planner.rs"]').click();

  for (const settings of [
    { interfaceScalePercent: 90, conversationTextPx: 13, codeTextPx: 12 },
    { interfaceScalePercent: 120, conversationTextPx: 20, codeTextPx: 20 },
  ]) {
    await page.evaluate(async (appearance) => {
      const { setAppearanceSetting } = await import("/assets/settings.js");
      for (const [name, value] of Object.entries(appearance)) {
        setAppearanceSetting(name, value);
      }
    }, settings);
    const layout = await taskReview.evaluate((review) => {
      const toolbar = review.querySelector(".task-review-toolbar");
      const viewer = review.querySelector(".task-review-viewer-pane");
      const code = review.querySelector(".diff-code");
      return {
        overflow: review.scrollWidth > review.clientWidth,
        toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
        viewerOverflow: viewer.scrollWidth > viewer.clientWidth,
        codeFontSize: code ? getComputedStyle(code).fontSize : null,
        selectedInsets: [...review.querySelectorAll(
          '.task-review-axis-options button[aria-pressed="true"] > span',
        )].map((selected) => {
          const group = selected.closest(".task-review-axis-options").getBoundingClientRect();
          const visual = selected.getBoundingClientRect();
          return {
            bottom: group.bottom - visual.bottom,
            top: visual.top - group.top,
          };
        }),
        truncatedAxisLabels: [...review.querySelectorAll(
          ".task-review-axis-options button > span",
        )]
          .filter((label) => label.scrollWidth > label.clientWidth)
          .map((label) => label.textContent.trim()),
      };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.toolbarOverflow).toBe(false);
    expect(layout.viewerOverflow).toBe(false);
    expect(layout.codeFontSize).toBe(`${settings.codeTextPx}px`);
    expect(layout.truncatedAxisLabels).toEqual([]);
    for (const inset of layout.selectedInsets) {
      expect(inset.top).toBeGreaterThanOrEqual(0);
      expect(inset.bottom).toBeGreaterThanOrEqual(0);
      expect(inset.top).toBeLessThanOrEqual(2);
      expect(inset.bottom).toBeLessThanOrEqual(2);
    }
    if (settings.interfaceScalePercent === 120) {
      await captureReviewScreenshot(page, testInfo, "tasks-review-appearance-max");
    }
  }
});

test("keeps compact Task segments pixel-aligned on Retina displays", async ({
  browser,
}, testInfo) => {
  const viewportByProject = {
    desktop: { width: 1280, height: 800 },
    foldable: { width: 933, height: 704 },
    phone: { width: 390, height: 844 },
  };
  const isMobile = testInfo.project.name !== "desktop";
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:18765",
    deviceScaleFactor: 2,
    hasTouch: isMobile,
    isMobile,
    viewport: viewportByProject[testInfo.project.name],
  });
  const page = await context.newPage();
  const misalignedSegments = [];

  try {
    await installBrowserDefaults(page);
    const { tasksPage } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

    for (const interfaceScalePercent of [90, 100, 105, 120]) {
      await page.evaluate(async (value) => {
        const { setAppearanceSetting } = await import("/assets/settings.js");
        setAppearanceSetting("interfaceScalePercent", value);
      }, interfaceScalePercent);
      const { devicePixelRatio, segments } = await page.evaluate(() => ({
        devicePixelRatio: window.devicePixelRatio,
        segments: [
          ...document.querySelectorAll(".task-mode-switch, .task-review-axis-options"),
        ]
          .filter((group) => group.getClientRects().length > 0)
          .map((group) => {
            const button = group.querySelector('button[aria-pressed="true"]');
            const selected = button.querySelector("span");
            const groupBounds = group.getBoundingClientRect();
            const buttonBounds = button.getBoundingClientRect();
            const selectedBounds = selected.getBoundingClientRect();
            return {
              bottomInsetPx: Math.round(
                (groupBounds.bottom - selectedBounds.bottom) * window.devicePixelRatio,
              ),
              buttonBottomInsetPx: Math.round(
                (groupBounds.bottom - buttonBounds.bottom) * window.devicePixelRatio,
              ),
              buttonTopInsetPx: Math.round(
                (buttonBounds.top - groupBounds.top) * window.devicePixelRatio,
              ),
              group: group.className,
              leftInsetPx: Math.round(
                (selectedBounds.left - buttonBounds.left) * window.devicePixelRatio,
              ),
              rightInsetPx: Math.round(
                (buttonBounds.right - selectedBounds.right) * window.devicePixelRatio,
              ),
              topInsetPx: Math.round(
                (selectedBounds.top - groupBounds.top) * window.devicePixelRatio,
              ),
            };
          }),
      }));
      expect(devicePixelRatio).toBe(2);
      for (const segment of segments) {
        expect(segment.topInsetPx).toBeGreaterThanOrEqual(0);
        expect(segment.bottomInsetPx).toBeGreaterThanOrEqual(0);
        if (
          Math.abs(segment.topInsetPx - segment.bottomInsetPx) > 1 ||
          segment.leftInsetPx > 1 ||
          segment.rightInsetPx > 1
        ) {
          misalignedSegments.push({ interfaceScalePercent, ...segment });
        }
      }
      if (interfaceScalePercent === 100) {
        await captureReviewScreenshot(
          page,
          testInfo,
          "tasks-review-retina",
        );
      }
    }
    expect(misalignedSegments).toEqual([]);
  } finally {
    await context.close();
  }
});

test("reflows Review at a desktop 200 percent effective viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop browser zoom is the reflow contract.");
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 400 });

  const layout = await taskReview.evaluate((review) => ({
    overflow: review.scrollWidth > review.clientWidth,
    toolbarOverflow:
      review.querySelector(".task-review-toolbar").scrollWidth >
      review.querySelector(".task-review-toolbar").clientWidth,
    navigatorWidth: review
      .querySelector(".task-review-navigator-pane")
      .getBoundingClientRect().width,
    viewerWidth: review
      .querySelector(".task-review-viewer-pane")
      .getBoundingClientRect().width,
  }));
  expect(layout.overflow).toBe(false);
  expect(layout.toolbarOverflow).toBe(false);
  expect(layout.navigatorWidth).toBeGreaterThanOrEqual(220);
  expect(layout.viewerWidth).toBeGreaterThanOrEqual(360);
});
