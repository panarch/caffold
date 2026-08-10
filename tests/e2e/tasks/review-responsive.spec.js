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
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const before = await taskReview.evaluate((review) => {
    const modeSwitch = document.querySelector(
      "caffold-task-detail-summary .task-mode-switch",
    );
    const summary = document.querySelector("caffold-task-detail-summary");
    const summaryActions = summary.querySelector(".task-detail-actions");
    const summaryInfo = summary.querySelector(".task-detail-info-button");
    const summaryTitle = summary.querySelector(".task-detail-heading h2");
    const summaryRect = summary.getBoundingClientRect();
    const actionsRect = summaryActions.getBoundingClientRect();
    const infoRect = summaryInfo.getBoundingClientRect();
    const infoVisualInset = Number.parseFloat(
      getComputedStyle(summaryInfo, "::before").right,
    );
    const navigator = review.querySelector(".task-review-navigator-pane");
    const viewer = review.querySelector(".task-review-viewer-pane");
    const visiblePaneControls = [...review.querySelectorAll(
      ".task-review-pane-axis .task-review-axis-options",
    )].filter((control) => control.getClientRects().length > 0);
    const rightmostPaneControl = visiblePaneControls.reduce((rightmost, control) =>
      !rightmost || control.getBoundingClientRect().right > rightmost.getBoundingClientRect().right
        ? control
        : rightmost,
    null);
    return {
      overflow: review.scrollWidth > review.clientWidth,
      modeSwitchOverflow: modeSwitch.scrollWidth > modeSwitch.clientWidth,
      summaryActionsContained:
        actionsRect.left >= summaryRect.left - 1 &&
        actionsRect.right <= summaryRect.right + 1,
      navigatorVisible: getComputedStyle(navigator).display !== "none",
      viewerVisible: getComputedStyle(viewer).display !== "none",
      actionEdgeDelta: Math.abs(
        infoRect.right - infoVisualInset -
          rightmostPaneControl.getBoundingClientRect().right,
      ),
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      taskTitleFontSize: Number.parseFloat(getComputedStyle(summaryTitle).fontSize),
    };
  });
  expect(before.overflow).toBe(false);
  expect(before.modeSwitchOverflow).toBe(false);
  expect(before.summaryActionsContained).toBe(true);
  expect(before.navigatorVisible).toBe(true);
  expect(before.viewerVisible).toBe(testInfo.project.name !== "phone");
  expect(before.actionEdgeDelta).toBeLessThanOrEqual(1);
  expect(before.taskTitleFontSize).toBeLessThan(before.rootFontSize);
  expect(before.taskTitleFontSize).toBeGreaterThanOrEqual(before.rootFontSize * 0.8);

  const summaryClearance = await page.evaluate(() => {
    const closeButton = document.querySelector(".task-workspace-back");
    const close = closeButton.getBoundingClientRect();
    const heading = document
      .querySelector("caffold-task-detail-summary .task-detail-heading h2")
      .getBoundingClientRect();
    return {
      closeLabel: closeButton.getAttribute("aria-label"),
      closeIconLabel: closeButton.querySelector(".sr-only")?.textContent,
      closeRight: close.right,
      closeTitleCenterDelta: Math.abs(
        close.top + close.height / 2 -
          (heading.top + heading.height / 2),
      ),
      closeVisible:
        getComputedStyle(closeButton).display !== "none" && close.width > 0,
      headingLeft: heading.left,
      headingWidth: heading.width,
      usesCollapsedWorkspace: window.matchMedia("(max-width: 899px)").matches,
    };
  });
  expect(summaryClearance.closeVisible).toBe(
    summaryClearance.usesCollapsedWorkspace,
  );
  expect(summaryClearance.closeLabel).toBe("Back to tasks");
  expect(summaryClearance.closeIconLabel).toBe("Back to tasks");
  if (summaryClearance.closeVisible) {
    expect(summaryClearance.closeTitleCenterDelta).toBeLessThanOrEqual(2);
    expect(summaryClearance.headingLeft).toBeGreaterThanOrEqual(
      summaryClearance.closeRight,
    );
  }
  expect(summaryClearance.headingWidth).toBeGreaterThanOrEqual(100);

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  const after = await taskReview.evaluate((review) => {
    const navigator = review.querySelector(".task-review-navigator-pane");
    const viewer = review.querySelector(".task-review-viewer-pane");
    const viewerInfo = review.querySelector(
      "caffold-review-file-viewer .viewer-info-button",
    );
    const viewerAxis = review.querySelector(
      ".task-review-viewer-axis .task-review-axis-options",
    );
    const summary = document.querySelector("caffold-task-detail-summary");
    const github = [...summary.querySelectorAll(".task-brand-button")].at(-1);
    const summaryInfo = summary.querySelector(".task-detail-info-button");
    const visualBounds = (element, pseudo) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element, pseudo);
      return {
        left: rect.left + Number.parseFloat(style.left),
        right: rect.right - Number.parseFloat(style.right),
      };
    };
    const viewerInfoBounds = visualBounds(viewerInfo, "::after");
    const githubBounds = visualBounds(github, "::before");
    const summaryInfoBounds = visualBounds(summaryInfo, "::before");
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      overflow: review.scrollWidth > review.clientWidth,
      navigatorVisible: getComputedStyle(navigator).display !== "none",
      viewerVisible: getComputedStyle(viewer).display !== "none",
      lowerControlGap:
        viewerAxis.getBoundingClientRect().left - viewerInfoBounds.right,
      upperControlGap: summaryInfoBounds.left - githubBounds.right,
      upperControlsShareRow:
        Math.abs(
          summaryInfo.getBoundingClientRect().top - github.getBoundingClientRect().top,
        ) <= 1,
      expectedControlGap:
        Number.parseFloat(rootStyle.getPropertyValue("--interface-space-5")) *
        Number.parseFloat(rootStyle.fontSize),
    };
  });
  expect(after.overflow).toBe(false);
  expect(after.viewerVisible).toBe(true);
  expect(after.navigatorVisible).toBe(testInfo.project.name !== "phone");
  expect(
    Math.abs(after.lowerControlGap - after.expectedControlGap),
  ).toBeLessThanOrEqual(1);
  if (after.upperControlsShareRow) {
    expect(
      Math.abs(after.lowerControlGap - after.upperControlGap),
    ).toBeLessThanOrEqual(1);
  }
});

test("owns one collapsed Back across Conversation and Review modes", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "phone",
    "The Review back control belongs to the collapsed workspace.",
  );
  const { taskScenario, tasksPage } = await openCompletedTaskForReview(page);
  const workspace = page.locator("caffold-task-workspace");
  const masterPane = workspace.locator(".task-workspace-master-pane");
  const detailPane = workspace.locator(".task-workspace-detail-pane");
  const backToTasks = workspace.locator(".task-workspace-back");
  const newTaskClose = workspace.locator(".task-workspace-close");
  const routes = [
    {
      name: "Conversation",
      url: `/tasks/${taskScenario.threadId}`,
      detailView: "conversation",
    },
    {
      name: "Working Tree",
      url: `/tasks/${taskScenario.threadId}/review`,
      detailView: "review",
    },
    {
      name: "Branch vs default",
      url: `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
      detailView: "review",
    },
  ];

  for (const mode of routes) {
    await page.goto(mode.url);
    await expect(page).toHaveURL(mode.url);
    await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
    await expect(tasksPage).toHaveAttribute(
      "data-task-detail-view",
      mode.detailView,
    );
    await expect(backToTasks, mode.name).toBeVisible();
    await expect(backToTasks).toHaveAttribute("aria-label", "Back to tasks");
    await expect(backToTasks.locator(".sr-only")).toHaveText("Back to tasks");
    await expect(newTaskClose).toBeHidden();

    const historyLength = await page.evaluate(() => window.history.length);
    await backToTasks.click();
    await expect(page).toHaveURL("/");
    await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
    await expect(tasksPage).toHaveAttribute(
      "data-task-detail-view",
      "conversation",
    );
    await expect(workspace).not.toHaveAttribute(
      "data-workspace-route-control-visible",
      "",
    );
    await expect(masterPane).toBeVisible();
    await expect(detailPane).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.history.length))
      .toBe(historyLength);
  }
});

test("keeps one compact file-navigation header on phone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Phone owns the single-pane back control.");
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();

  const backButtons = taskReview.getByRole("button", { name: "Back to navigator" });
  await expect(backButtons).toHaveCount(1);
  await expect(backButtons).toHaveAttribute("data-close-mode", "back");
  await expect(taskReview.locator(".task-review-mobile-back")).toHaveCount(0);
  await expect(
    taskReview.locator("caffold-review-file-viewer .viewer-info-button"),
  ).toHaveCount(1);

  const geometry = await taskReview.evaluate((review) => {
    const viewerHeader = review.querySelector("caffold-review-file-viewer .viewer-header");
    const close = viewerHeader.querySelector(".viewer-close-button");
    const info = viewerHeader.querySelector(".viewer-info-button");
    const titleBlock = viewerHeader.querySelector(".viewer-title-block");
    const headerRect = viewerHeader.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const infoRect = info.getBoundingClientRect();
    const titleBlockRect = titleBlock.getBoundingClientRect();
    const closeInset = Number.parseFloat(
      getComputedStyle(close, "::before").top,
    );
    const infoInset = Number.parseFloat(
      getComputedStyle(info, "::after").top,
    );
    return {
      closeVisualHeight: closeRect.height - closeInset * 2,
      closeVisualWidth: closeRect.width - closeInset * 2,
      headerHeight: headerRect.height,
      hitHeight: closeRect.height,
      infoVisualHeight: infoRect.height - infoInset * 2,
      infoVisualWidth: infoRect.width - infoInset * 2,
      overflow: review.scrollWidth > review.clientWidth,
      titleCenter: titleBlockRect.top + titleBlockRect.height / 2,
      headerCenter: headerRect.top + headerRect.height / 2,
    };
  });

  expect(geometry.overflow).toBe(false);
  expect(geometry.closeVisualWidth).toBeLessThanOrEqual(36);
  expect(geometry.closeVisualHeight).toBeLessThanOrEqual(36);
  expect(geometry.infoVisualWidth).toBeCloseTo(geometry.closeVisualWidth, 1);
  expect(geometry.infoVisualHeight).toBeCloseTo(geometry.closeVisualHeight, 1);
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
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
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
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();

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
      const modeSwitch = document.querySelector(
        "caffold-task-detail-summary .task-mode-switch",
      );
      const viewer = review.querySelector(".task-review-viewer-pane");
      const code = review.querySelector(".diff-code");
      return {
        overflow: review.scrollWidth > review.clientWidth,
        modeSwitchOverflow: modeSwitch.scrollWidth > modeSwitch.clientWidth,
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
    expect(layout.modeSwitchOverflow).toBe(false);
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
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

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
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 400 });

  const layout = await taskReview.evaluate((review) => ({
    overflow: review.scrollWidth > review.clientWidth,
    modeSwitchOverflow: (() => {
      const modeSwitch = document.querySelector(
        "caffold-task-detail-summary .task-mode-switch",
      );
      return modeSwitch.scrollWidth > modeSwitch.clientWidth;
    })(),
    navigatorWidth: review
      .querySelector(".task-review-navigator-pane")
      .getBoundingClientRect().width,
    viewerWidth: review
      .querySelector(".task-review-viewer-pane")
      .getBoundingClientRect().width,
  }));
  expect(layout.overflow).toBe(false);
  expect(layout.modeSwitchOverflow).toBe(false);
  expect(layout.navigatorWidth).toBeGreaterThanOrEqual(220);
  expect(layout.viewerWidth).toBeGreaterThanOrEqual(360);
});
