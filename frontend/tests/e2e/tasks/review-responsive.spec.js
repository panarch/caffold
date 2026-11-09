import { expect, test } from "@playwright/test";
import { activateActionHint, enterActionHints } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { elementHandles } from "../support/element-handles.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps Task tool menus above active Review controls", { tag: "@all-viewports" }, async ({ page }) => {
  const { tasksPage } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const summary = tasksPage.locator(".detail-layout-summary");
  for (const [workspace, action] of [
    ["Git", "Compare"],
    ["GitHub", "Pull Requests"],
  ]) {
    const trigger = summary.getByRole("button", {
      name: `Open ${workspace} workspace`,
    });
    await trigger.click();
    const menuAction = summary.getByRole("button", { name: action, exact: true });
    const popover = menuAction.locator("..");
    await expect(menuAction).toBeVisible();
    await menuAction.click({ trial: true });
    const [triggerBox, popoverBox] = await Promise.all([
      trigger.boundingBox(),
      popover.boundingBox(),
    ]);
    expect(triggerBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox.x).toBeGreaterThanOrEqual(7);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
      page.viewportSize().width - 7,
    );
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  }
});

test("uses two panes off phone and a semantic navigator/viewer split on phone", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const before = await taskReview.evaluate((review, [
    modeSwitch,
    summary,
    summaryActions,
    summaryInfo,
    summaryTitle,
  ]) => {
    const summaryRect = summary.getBoundingClientRect();
    const actionsRect = summaryActions.getBoundingClientRect();
    const infoRect = summaryInfo.getBoundingClientRect();
    const infoVisualInset = Number.parseFloat(
      getComputedStyle(summaryInfo, "::before").right,
    );
    const navigator = review.shadowRoot.querySelector(".task-review-navigator-pane");
    const viewer = review.shadowRoot.querySelector(".task-review-viewer-pane");
    const visiblePaneControls = [...review.shadowRoot.querySelectorAll(
      ".task-review-pane-axis > caffold-segmented-control",
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
      navigatorVisible: navigator.getClientRects().length > 0,
      viewerVisible: viewer.getClientRects().length > 0,
      actionEdgeDelta: Math.abs(
        infoRect.right - infoVisualInset -
          rightmostPaneControl.getBoundingClientRect().right,
      ),
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      taskTitleFontSize: Number.parseFloat(getComputedStyle(summaryTitle).fontSize),
    };
  }, await elementHandles(page.locator("caffold-detail-layout"), [
    "caffold-segmented-control[data-detail-view-switch]",
    ".detail-layout-summary",
    ".detail-layout-actions",
    ".task-detail-info-button",
    ".task-detail-heading h2",
  ]));
  expect(before.overflow).toBe(false);
  expect(before.modeSwitchOverflow).toBe(false);
  expect(before.summaryActionsContained).toBe(true);
  expect(before.navigatorVisible).toBe(true);
  expect(before.viewerVisible).toBe(testInfo.project.name !== "phone");
  expect(before.actionEdgeDelta).toBeLessThanOrEqual(1);
  expect(before.taskTitleFontSize).toBeLessThan(before.rootFontSize);
  expect(before.taskTitleFontSize).toBeGreaterThanOrEqual(before.rootFontSize * 0.8);
  const reviewSeparator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  if (testInfo.project.name === "phone") {
    await expect(reviewSeparator).toBeHidden();
    await expect(taskReview.evaluate((review) =>
      review.actionHintScope().targets.map((target) => target.label)
    )).resolves.not.toContain("Resize review navigator");
  } else {
    await expect(reviewSeparator).toBeVisible();
  }

  const summaryClearance = await page.evaluate(([headingElement, closeButton]) => {
    const close = closeButton.getBoundingClientRect();
    const heading = headingElement.getBoundingClientRect();
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
  }, [
    await page.locator("caffold-task-detail-summary .task-detail-heading h2").elementHandle(),
    await page.locator(".task-workspace-back").elementHandle(),
  ]);
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
  await expect(taskReview.getByRole("button", { name: "Wrap code lines" })).toBeVisible();
  if (testInfo.project.name !== "desktop") {
    await expect(taskReview.locator(".task-review-navigator-pane")).toBeHidden();
  }
  const after = await taskReview.evaluate((review, [git, github]) => {
    const navigator = review.shadowRoot.querySelector(".task-review-navigator-pane");
    const viewer = review.shadowRoot.querySelector(".task-review-viewer-pane");
    const viewerHeader = review
      .shadowRoot.querySelector("caffold-review-selected-file")
      .shadowRoot.querySelector("caffold-review-file-viewer")
      .shadowRoot.querySelector(".viewer-header");
    const viewerTitle = viewerHeader.querySelector("h2");
    const viewerInfo = viewerHeader.querySelector(".viewer-info-button");
    const viewerWrap = viewerHeader.querySelector(".viewer-wrap-button");
    const viewerAxis = review.shadowRoot.querySelector(
      '.task-review-viewer-axis caffold-segmented-control[data-review-axis="viewer"]',
    );
    const visualBounds = (element, pseudo) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element, pseudo);
      return {
        left: rect.left + Number.parseFloat(style.left),
        right: rect.right - Number.parseFloat(style.right),
      };
    };
    const viewerInfoBounds = visualBounds(viewerInfo, "::after");
    const viewerWrapBounds = visualBounds(viewerWrap, "::before");
    return {
      overflow: review.scrollWidth > review.clientWidth,
      navigatorVisible: navigator.getClientRects().length > 0,
      viewerVisible: viewer.getClientRects().length > 0,
      titleClear:
        viewerTitle.getBoundingClientRect().right <=
          viewerInfo.getBoundingClientRect().left,
      wrapWidth: viewerWrapBounds.right - viewerWrapBounds.left,
      infoWidth: viewerInfoBounds.right - viewerInfoBounds.left,
      // The file header's buttons and the Review viewer axis after them
      // stand as far apart as the Detail header's Git and GitHub buttons.
      viewerButtonGap: viewerWrapBounds.left - viewerInfoBounds.right,
      viewerAxisGap:
        viewerAxis.getBoundingClientRect().left - viewerWrapBounds.right,
      headerButtonGap:
        visualBounds(github, "::before").left -
          visualBounds(git, "::before").right,
    };
  }, await elementHandles(page.locator("caffold-detail-layout"), [
    ".task-git-button",
    ".task-github-button",
  ]));
  expect(after.overflow).toBe(false);
  expect(after.viewerVisible).toBe(true);
  // An open file takes the width below a wide window: the phone shows it
  // alone and the foldable folds the navigator into its drawer.
  expect(after.navigatorVisible).toBe(testInfo.project.name === "desktop");
  expect(after.titleClear).toBe(true);
  expect(after.wrapWidth).toBeCloseTo(after.infoWidth, 1);
  expect(after.headerButtonGap).toBeGreaterThan(0);
  expect(Math.abs(after.viewerButtonGap - after.headerButtonGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.viewerAxisGap - after.headerButtonGap)).toBeLessThanOrEqual(1);
});

test("owns one collapsed Back across Conversation and Review modes", { tag: "@phone" }, async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage } = await openCompletedTaskForReview(page);
  const workspace = page.locator("caffold-task-workspace");
  const masterPane = workspace.locator(".task-workspace-master-pane");
  const detailPane = workspace.locator(".task-workspace-detail-pane");
  const backToTasks = workspace.locator(".task-workspace-back");
  // A full navigation may finish before async components apply the initial
  // route. Let that owner initialize history before loading another address.
  await expect.poll(() => page.evaluate(() => {
    const snapshot = document.querySelector("caffold-app-shell")?.foregroundRecoverySnapshot;
    return snapshot?.lastTrigger === "bootstrap" ? snapshot.generation : 0;
  })).toBeGreaterThan(0);
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
      name: "Branch",
      url: `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
      detailView: "review",
    },
  ];

  for (const mode of routes) {
    await page.goto(mode.url);
    await expect.poll(() => page.evaluate(() => {
      const snapshot = document.querySelector("caffold-app-shell")?.foregroundRecoverySnapshot;
      return snapshot?.lastTrigger === "bootstrap" ? snapshot.generation : 0;
    })).toBeGreaterThan(0);
    await expect(page).toHaveURL(mode.url);
    await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
    await expect(tasksPage).toHaveAttribute(
      "data-task-detail-view",
      mode.detailView,
    );
    await expect(backToTasks, mode.name).toBeVisible();
    await expect(backToTasks).toHaveAttribute("aria-label", "Back to tasks");
    await expect(backToTasks.locator(".sr-only")).toHaveText("Back to tasks");

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

test("keeps one compact file-navigation header on phone", { tag: "@phone" }, async ({
  page,
}, testInfo) => {
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
    const viewerHeader = review
      .shadowRoot.querySelector("caffold-review-selected-file")
      .shadowRoot.querySelector("caffold-review-file-viewer")
      .shadowRoot.querySelector(".viewer-header");
    const close = viewerHeader.querySelector(".viewer-close-button");
    const info = viewerHeader.querySelector(".viewer-info-button");
    const wrap = viewerHeader.querySelector(".viewer-wrap-button");
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
    const wrapRect = wrap.getBoundingClientRect();
    const wrapInset = Number.parseFloat(
      getComputedStyle(wrap, "::before").top,
    );
    return {
      closeVisualHeight: closeRect.height - closeInset * 2,
      closeVisualWidth: closeRect.width - closeInset * 2,
      headerHeight: headerRect.height,
      hitHeight: closeRect.height,
      infoVisualHeight: infoRect.height - infoInset * 2,
      infoVisualWidth: infoRect.width - infoInset * 2,
      wrapHitHeight: wrapRect.height,
      wrapVisualHeight: wrapRect.height - wrapInset * 2,
      wrapVisualWidth: wrapRect.width - wrapInset * 2,
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
  expect(geometry.wrapVisualWidth).toBeCloseTo(geometry.closeVisualWidth, 1);
  expect(geometry.wrapVisualHeight).toBeCloseTo(geometry.closeVisualHeight, 1);
  expect(geometry.wrapHitHeight).toBe(geometry.hitHeight);
  expect(geometry.hitHeight).toBeGreaterThanOrEqual(40);
  expect(geometry.headerHeight).toBeLessThanOrEqual(42);
  expect(Math.abs(geometry.titleCenter - geometry.headerCenter)).toBeLessThanOrEqual(1);

  await captureReviewScreenshot(page, testInfo, "tasks-review-phone-file");
  await backButtons.click();
  await expect(taskReview).not.toHaveAttribute("data-file-selected", "");
});

test("clamps the navigator so the shared viewer keeps its minimum width", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  const before = Number(await separator.getAttribute("aria-valuenow"));
  await activateActionHint(page, "Resize review navigator");
  await expect(separator).toBeFocused();
  await separator.press("ArrowRight");
  await expect.poll(async () =>
    Number(await separator.getAttribute("aria-valuenow"))
  ).toBeGreaterThan(before);
  await separator.press("End");
  const widths = await taskReview.evaluate((review) => ({
    navigator: review.shadowRoot.querySelector(".task-review-navigator-pane").getBoundingClientRect().width,
    viewer: review.shadowRoot.querySelector(".task-review-viewer-pane").getBoundingClientRect().width,
  }));
  expect(widths.navigator).toBeGreaterThanOrEqual(220);
  expect(widths.viewer).toBeGreaterThanOrEqual(360);
});

test("remembers the review navigator width across reloads", { tag: "@desktop" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  await expect(separator).toHaveAttribute("aria-valuenow", "320");
  await separator.focus();
  await separator.press("ArrowRight");
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "368");

  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", "368");
  await expect
    .poll(() =>
      taskReview.evaluate((review) =>
        Math.round(
          review.shadowRoot.querySelector(".task-review-navigator-pane").getBoundingClientRect().width,
        ),
      ),
    )
    .toBe(368);
});

test("collapses the review navigator from the corner toggle only while a file is open", { tag: "@desktop" }, async ({
  page,
}) => {
  const { tasksPage, taskReview, taskScenario } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const toggle = page.locator("caffold-task-workspace .task-workspace-side-pane-toggle");
  const navigator = taskReview.locator(".task-review-navigator-pane");
  const viewer = taskReview.locator(".task-review-viewer-pane");
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  const title = page.locator("caffold-task-detail-summary .task-detail-heading h2");
  const stored = (kind) =>
    page.evaluate(
      (key) => window.localStorage.getItem(key),
      `caffold:pane-collapsed:${kind}`,
    );

  await expect(navigator).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAccessibleName("Hide review navigator");
  const toggleBox = await toggle.boundingBox();
  const titleLeft = (await title.boundingBox()).x;
  expect(titleLeft).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width);

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(taskReview).toHaveAttribute("data-file-selected", "");
  await expect(toggle).toBeEnabled();
  expect((await title.boundingBox()).x).toBe(titleLeft);
  const chosenWidth = await separator.getAttribute("aria-valuenow");
  const fileUrl = page.url();

  await toggle.click();
  await expect(navigator).toBeHidden();
  await expect(separator).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Show review navigator");
  const [reviewBox, viewerBox] = await Promise.all([
    taskReview.locator(".task-review-layout").boundingBox(),
    viewer.boundingBox(),
  ]);
  expect(Math.abs(viewerBox.x - reviewBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewerBox.width - reviewBox.width)).toBeLessThanOrEqual(1);
  expect((await title.boundingBox()).x).toBe(titleLeft);
  expect(await stored("task-review")).toBe("true");
  expect(await stored("task-workspace")).toBeNull();
  await expect(taskReview.evaluate((review) =>
    review.actionHintScope().targets.map((target) => target.label)
  )).resolves.not.toContain("Resize review navigator");

  await page.reload();
  await expect(taskReview).toHaveAttribute("data-file-selected", "");
  await expect(navigator).toBeHidden();

  await page.goto(`/tasks/${taskScenario.threadId}/review`);
  await expect(navigator).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await page.goto(fileUrl);
  await expect(taskReview).toHaveAttribute("data-file-selected", "");
  await expect(navigator).toBeHidden();
  await toggle.click();
  await expect(navigator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuenow", chosenWidth);
  expect(await stored("task-review")).toBe("false");
});

test("shows one pane on a phone, the drawer up to 1,060px, and both panes wider", { tag: "@desktop" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const workspace = page.locator("caffold-task-workspace");
  const toggle = workspace.locator(".task-workspace-side-pane-toggle");
  const back = workspace.locator(".task-workspace-back");
  const navigator = taskReview.locator(".task-review-navigator-pane");
  const viewer = taskReview.locator(".task-review-viewer-pane");
  const strip = taskReview.locator("caffold-split-view .split-view-strip");

  await page.setViewportSize({ width: 700, height: 800 });
  await expect(navigator).toBeVisible();
  await expect(viewer).toBeVisible();
  await expect(strip).toBeHidden();
  await expect(back).toBeVisible();
  await expect(toggle).toBeHidden();

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(taskReview).toHaveAttribute("data-file-selected", "");
  await expect(back).toBeHidden();
  await expect(navigator).toBeHidden();
  await expect(strip).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(navigator).toBeVisible();
  await expect(viewer).toBeVisible();

  await page.setViewportSize({ width: 560, height: 800 });
  await expect(toggle).toBeHidden();
  await expect(strip).toBeHidden();
  await expect(navigator).toBeHidden();
  await expect(viewer).toBeVisible();

  await page.setViewportSize({ width: 561, height: 800 });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(navigator).toBeHidden();
  await expect(strip).toBeVisible();

  await page.setViewportSize({ width: 1060, height: 800 });
  await expect(strip).toBeVisible();
  await expect(navigator).toBeHidden();

  await page.setViewportSize({ width: 1061, height: 800 });
  await expect(strip).toBeHidden();
  await expect(navigator).toBeVisible();
  await expect(toggle).toHaveAccessibleName("Hide review navigator");
});

test("folds the review navigator into a strip under the corner toggle while a file is open", { tag: "@foldable" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const toggle = page.locator("caffold-task-workspace .task-workspace-side-pane-toggle");
  const navigator = taskReview.locator(".task-review-navigator-pane");
  const strip = taskReview.locator("caffold-split-view .split-view-strip");

  await expect(navigator).toBeVisible();
  await expect(strip).toBeHidden();
  await expect(toggle).toBeDisabled();
  await expect(taskReview.locator(".change-count")).toHaveText(/^\d+ changes$/);
  const changes = Number.parseInt(
    await taskReview.locator(".change-count").textContent(),
    10,
  );

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(taskReview).toHaveAttribute("data-file-selected", "");
  await expect(navigator).toBeHidden();
  await expect(strip).toBeVisible();
  await expect(strip).toHaveText(`Changes ${changes}`);
  await expect(strip).toHaveAccessibleName(
    `Show review navigator, Changes ${changes}`,
  );
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Show review navigator");
  await expect(taskReview.getByRole("button", { name: "Back to navigator" })).toBeHidden();

  const box = (locator) => locator.boundingBox();
  const [stripBox, chevronBox, toggleBox, titleBox, viewerBox, layoutBox, drawerBox] =
    await Promise.all([
      box(strip),
      box(taskReview.locator("caffold-split-view .split-view-strip-icon")),
      box(toggle),
      box(page.locator("caffold-task-detail-summary .task-detail-heading h2")),
      box(taskReview.locator(".task-review-viewer-pane")),
      box(taskReview.locator("caffold-split-view")),
      box(taskReview.locator("caffold-split-view .split-view-list")),
    ]);
  // The strip is the column the corner toggle stands in: its edge meets the
  // Task title above, and its chevron sits under the toggle. It is the edge
  // of the folded drawer.
  expect(Math.abs(stripBox.x + stripBox.width - titleBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(
    drawerBox.x + drawerBox.width - (stripBox.x + stripBox.width),
  )).toBeLessThanOrEqual(1);
  expect(Math.abs(
    chevronBox.x + chevronBox.width / 2 - (toggleBox.x + toggleBox.width / 2),
  )).toBeLessThanOrEqual(1);
  expect(Math.abs(viewerBox.x - (stripBox.x + stripBox.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(
    viewerBox.x + viewerBox.width - (layoutBox.x + layoutBox.width),
  )).toBeLessThanOrEqual(1);

  await strip.click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await expect(taskReview.locator(".task-review-navigator-pane")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(strip).toHaveText("Files");
  await expect(strip).toHaveAccessibleName("Show review navigator, Files");
});

test("opens the folded review navigator over the file and closes it after a choice", { tag: "@foldable" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const toggle = page.locator("caffold-task-workspace .task-workspace-side-pane-toggle");
  const navigator = taskReview.locator(".task-review-navigator-pane");
  const viewer = taskReview.locator(".task-review-viewer-pane");
  const strip = taskReview.locator("caffold-split-view .split-view-strip");
  const drawer = taskReview.locator("caffold-split-view .split-view-list");
  const dim = taskReview.locator("caffold-split-view .split-view-dim");
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(strip).toBeVisible();
  const closedViewer = await viewer.boundingBox();

  await strip.click();
  await expect(navigator).toBeVisible();
  await expect(dim).toBeVisible();
  await expect(separator).toBeVisible();
  await expect(drawer).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Hide review navigator");
  // The drawer covers the file; the file keeps its place and its lines.
  expect(await viewer.boundingBox()).toEqual(closedViewer);

  await page.keyboard.press("Escape");
  await expect(navigator).toBeHidden();
  await expect(strip).toBeFocused();

  await toggle.click();
  await expect(navigator).toBeVisible();
  const dimBox = await dim.boundingBox();
  await dim.click({ position: { x: dimBox.width - 24, y: dimBox.height / 2 } });
  await expect(navigator).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(navigator).toBeVisible();
  await taskReview.locator('button[data-file-tree-relative-path="lib.rs"]').click();
  await expect(navigator).toBeHidden();
  await expect(taskReview.locator('button[data-file-tree-relative-path="lib.rs"]'))
    .toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/lib\.rs/);

  await strip.click();
  await expect(navigator).toBeVisible();
  await page.reload();
  await expect(taskReview).toHaveAttribute("data-file-selected", "");
  await expect(strip).toBeVisible();
  await expect(navigator).toBeHidden();

  await toggle.click();
  await expect(navigator).toBeVisible();
  await page.setViewportSize({ width: 1100, height: page.viewportSize().height });
  await expect(strip).toBeHidden();
  await expect(navigator).toBeVisible();
  await expect(dim).toBeHidden();
  await expect(toggle).toHaveAccessibleName("Hide review navigator");
});

test("keeps the drawer between 320px and 70% of Review and the chosen width for side by side", { tag: "@foldable" }, async ({
  page,
}) => {
  const { tasksPage, taskReview, taskScenario } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const navigator = taskReview.locator(".task-review-navigator-pane");
  const strip = taskReview.locator("caffold-split-view .split-view-strip");
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  const openDrawer = async () => {
    await strip.click();
    await expect(navigator).toBeVisible();
  };

  await separator.focus();
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "220");

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(page).toHaveURL(/planner\.rs/);
  const fileUrl = page.url();
  await openDrawer();
  await expect(separator).toHaveAttribute("aria-valuemin", "320");
  await expect(separator).toHaveAttribute("aria-valuenow", "320");

  await page.goto(`/tasks/${taskScenario.threadId}/review`);
  await expect(navigator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuemin", "220");
  await expect(separator).toHaveAttribute("aria-valuenow", "220");

  await page.goto(fileUrl);
  await openDrawer();
  const reviewWidth = (await taskReview.locator("caffold-split-view").boundingBox()).width;
  await separator.focus();
  await separator.press("End");
  await expect(separator).toHaveAttribute(
    "aria-valuenow",
    `${Math.round(reviewWidth * 0.7)}`,
  );
  await expect.poll(async () => Math.round((await navigator.boundingBox()).width))
    .toBe(Math.round(reviewWidth * 0.7));
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "320");
  await expect(navigator).toBeVisible();
});

test("offers the folded strip as an Action Hint on its chevron and only the drawer while it is open", { tag: "@foldable" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const navigator = taskReview.locator(".task-review-navigator-pane");
  await expect(taskReview.locator(".change-count")).toHaveText(/^\d+ changes$/);
  const changes = Number.parseInt(
    await taskReview.locator(".change-count").textContent(),
    10,
  );
  const stripName = `Show review navigator, Changes ${changes}`;
  const labels = () =>
    taskReview.evaluate((review) =>
      review.actionHintScope().targets.map((target) => target.label)
    );

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(taskReview.getByRole("button", { name: "Wrap code lines" })).toBeVisible();
  await expect.poll(labels).toContain(stripName);
  expect(await labels()).toContain("Wrap code lines");
  expect(await labels()).not.toContain("Resize review navigator");

  const dialog = await enterActionHints(page);
  const badge = dialog.getByLabel(stripName);
  await expect(badge).toBeVisible();
  const [badgeBox, chevronBox] = await Promise.all([
    badge.boundingBox(),
    taskReview.locator("caffold-split-view .split-view-strip-icon").boundingBox(),
  ]);
  expect(Math.abs(badgeBox.y - chevronBox.y)).toBeLessThanOrEqual(1);
  await page.keyboard.type(
    (await badge.getAttribute("data-action-hint-code")).toLowerCase(),
  );
  await expect(navigator).toBeVisible();

  await expect.poll(labels).toContain("Resize review navigator");
  const open = await labels();
  expect(open).not.toContain(stripName);
  expect(open).not.toContain("Wrap code lines");
});

test("slides the drawer out from the strip unless the person asked for less motion", { tag: "@foldable" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const navigator = taskReview.locator(".task-review-navigator-pane");
  const toggle = page.locator("caffold-task-workspace .task-workspace-side-pane-toggle");
  const strip = taskReview.locator("caffold-split-view .split-view-strip");
  // The press sets the motion at once, so it is read in the same task.
  const open = (point = null) =>
    taskReview.locator("caffold-split-view").evaluate((split, point) => {
      const root = split.shadowRoot;
      root.querySelector(".split-view-strip").click();
      const drawer = getComputedStyle(root.querySelector(".split-view-list"));
      const strip = getComputedStyle(root.querySelector(".split-view-strip"));
      return {
        drawer: drawer.transitionDuration,
        strip: strip.transitionDuration,
        stripDelay: strip.transitionDelay,
        ...(point && {
          stripOnTop: Boolean(
            root.elementFromPoint(point.x, point.y)?.closest(".split-view-strip"),
          ),
        }),
      };
    }, point);

  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  const stripBox = await strip.boundingBox();
  // The drawer moves for 0.15s; the strip fades in its first half, still
  // covering the list's header controls as the drawer starts out.
  expect(await open({ x: stripBox.x + stripBox.width / 2, y: stripBox.y + 16 }))
    .toEqual({
      drawer: "0.15s",
      strip: "0.075s, 0s",
      stripDelay: "0s, 0.075s",
      stripOnTop: true,
    });
  await expect(navigator).toBeVisible();
  await toggle.click();
  await expect(navigator).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await open()).toEqual({
    drawer: "0s",
    strip: "0s, 0s",
    stripDelay: "0s, 0s",
  });
});

test("shades the whole file beside the folded strip and dims all of it under the open drawer", { tag: "@foldable" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  const strip = taskReview.locator("caffold-split-view .split-view-strip");
  const lineNumbers = taskReview.locator("caffold-diff-viewer .diff-gutter").first();
  const diff = taskReview.getByRole("button", { name: "Diff", exact: true });
  await expect(lineNumbers).toBeVisible();
  const colors = async (points) => {
    const screenshot = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    return page.evaluate(async ({ base64, points }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))]),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return points.map(([x, y]) => [
        ...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3),
      ]);
    }, { base64: screenshot.toString("base64"), points });
  };
  const darkening = (shaded, plain) =>
    plain.reduce((sum, channel, index) => sum + channel - shaded[index], 0);

  // The strip's shadow falls on a line's numbers as on the space below them.
  const [stripBox, lineBox, diffBox] = await Promise.all([
    strip.boundingBox(),
    lineNumbers.boundingBox(),
    diff.boundingBox(),
  ]);
  const edge = stripBox.x + stripBox.width;
  const inDiff = [diffBox.x + 6, diffBox.y + diffBox.height / 2];
  const [besideStrip, awayFromStrip, closed] = await colors([
    [edge + 2, lineBox.y + 1],
    [edge + 24, lineBox.y + 1],
    inDiff,
  ]);
  expect(darkening(besideStrip, awayFromStrip)).toBeGreaterThan(9);

  // The open drawer's dim covers the file's own controls as well.
  await strip.click();
  await expect(taskReview.locator(".task-review-navigator-pane")).toBeVisible();
  const [dimmed] = await colors([inDiff]);
  expect(darkening(dimmed, closed)).toBeGreaterThan(20);
});

test("draws the shared separator as the pane line with a centered handle and a 3px highlight", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  await expect(separator).toBeVisible();

  const split = await taskReview.evaluate((review) => {
    const layout = review.shadowRoot.querySelector(".task-review-layout").getBoundingClientRect();
    const navigator = review.shadowRoot.querySelector(".task-review-navigator-pane").getBoundingClientRect();
    const viewer = review.shadowRoot.querySelector(".task-review-viewer-pane").getBoundingClientRect();
    const resizer = review.shadowRoot
      .querySelector("caffold-split-view")
      .shadowRoot.querySelector("caffold-pane-resizer");
    const bounds = resizer.getBoundingClientRect();
    const center = bounds.left + bounds.width / 2;
    const middle = bounds.top + bounds.height / 2;
    const handle = resizer.shadowRoot.querySelector(".pane-resizer-handle");
    const handleBounds = handle.getBoundingClientRect();
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = "var(--border-strong)";
    const idleHandleExpected = getComputedStyle(probe).color;
    probe.remove();
    return {
      layoutWidth: layout.width,
      panesWidth: navigator.width + viewer.width,
      navigatorEnd: navigator.right,
      separatorCenter: center,
      separatorMiddle: middle,
      hitsSeparator: resizer.contains(
        resizer.getRootNode().elementFromPoint(center, middle),
      ),
      idleHighlight: getComputedStyle(resizer, "::after").backgroundColor,
      handleCenterX: handleBounds.left + handleBounds.width / 2,
      handleCenterY: handleBounds.top + handleBounds.height / 2,
      handleWidth: handleBounds.width,
      handleHeight: handleBounds.height,
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      idleHandle: getComputedStyle(handle).backgroundColor,
      idleHandleExpected,
    };
  });
  expect(split.panesWidth).toBeCloseTo(split.layoutWidth, 0);
  expect(split.separatorCenter).toBeCloseTo(split.navigatorEnd, 0);
  expect(split.hitsSeparator).toBe(true);
  expect(split.idleHighlight).toBe("rgba(0, 0, 0, 0)");
  expect(split.handleWidth).toBe(5);
  expect(split.handleHeight).toBeCloseTo(split.rootFontSize * 1.5, 1);
  expect(split.handleCenterX).toBeCloseTo(split.navigatorEnd - 0.5, 1);
  expect(split.handleCenterY).toBeCloseTo(split.separatorMiddle, 0);
  expect(split.idleHandle).toBe(split.idleHandleExpected);

  await separator.hover();
  const highlight = await separator.evaluate((resizer) => {
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = "var(--resizer-hover-bg)";
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const line = getComputedStyle(resizer, "::after");
    const handle = getComputedStyle(resizer.shadowRoot.querySelector(".pane-resizer-handle"));
    return {
      width: line.width,
      color: line.backgroundColor,
      handleColor: handle.backgroundColor,
      expected,
    };
  });
  expect(highlight.width).toBe("3px");
  expect(highlight.color).toBe(highlight.expected);
  expect(highlight.handleColor).toBe(highlight.expected);
  await captureReviewScreenshot(page, testInfo, "tasks-review-separator-highlight");
});

test("gives the shared separator handle the Interface touch target", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(taskReview.getByRole("separator", {
    name: "Resize review navigator",
  })).toBeVisible();

  const touch = await taskReview.evaluate((review) => {
    const resizer = review.shadowRoot
      .querySelector("caffold-split-view")
      .shadowRoot.querySelector("caffold-pane-resizer");
    const handle = resizer.shadowRoot.querySelector(".pane-resizer-handle").getBoundingClientRect();
    const centerX = handle.left + handle.width / 2;
    const centerY = handle.top + handle.height / 2;
    const hits = (dx, dy) =>
      resizer.contains(
        resizer.getRootNode().elementFromPoint(centerX + dx, centerY + dy),
      );
    return {
      targetFloor: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--interface-target-floor"),
      ) || 0,
      withinTouchFloor: [hits(-18, 0), hits(18, 0), hits(-18, -18), hits(18, 18)],
      beyondTouchFloor: [hits(-18, -22), hits(18, 22)],
    };
  });
  expect(touch.targetFloor).toBe(testInfo.project.name === "desktop" ? 0 : 40);
  expect(touch.withinTouchFloor).toEqual(Array(4).fill(touch.targetFloor === 40));
  expect(touch.beyondTouchFloor).toEqual([false, false]);
  await captureReviewScreenshot(page, testInfo, "tasks-review-separator-handle");
});

test("keeps the shared separator unlit on touch unless a drag holds it", { tag: "@foldable" }, async ({
  page,
  context,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const separator = taskReview.getByRole("separator", {
    name: "Resize review navigator",
  });
  await expect(separator).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);

  const colors = await separator.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = "var(--resizer-hover-bg)";
    const active = getComputedStyle(probe).color;
    probe.style.color = "var(--border-strong)";
    const idle = getComputedStyle(probe).color;
    probe.remove();
    return { active, idle };
  });
  const lit = { line: colors.active, handle: colors.active };
  const unlit = { line: "rgba(0, 0, 0, 0)", handle: colors.idle };
  const highlight = () =>
    separator.evaluate((resizer) => ({
      line: getComputedStyle(resizer, "::after").backgroundColor,
      handle: getComputedStyle(
        resizer.shadowRoot.querySelector(".pane-resizer-handle"),
      ).backgroundColor,
    }));

  const handle = await separator.locator(":scope > .pane-resizer-handle").boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;

  // A touch screen keeps :hover on whatever a tap landed on; the mouse sets that
  // state directly instead of depending on how a browser synthesizes a tap.
  await page.mouse.move(x, y);
  await expect
    .poll(() => separator.evaluate((resizer) => resizer.matches(":hover")))
    .toBe(true);
  expect(await highlight()).toEqual(unlit);

  const devtools = await context.newCDPSession(page);
  const touch = (type, touchPoints) =>
    devtools.send("Input.dispatchTouchEvent", { type, touchPoints });
  await touch("touchStart", [{ x, y }]);
  await touch("touchMove", [{ x: x + 24, y }]);
  await expect.poll(highlight).toEqual(lit);
  await touch("touchEnd", []);
  await expect.poll(highlight).toEqual(unlit);
});

test("keeps Review reflowed at the appearance extremes", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();

  for (const settings of [
    { interfaceScalePercent: 90, conversationTextPx: 11, codeTextPx: 8 },
    { interfaceScalePercent: 120, conversationTextPx: 24, codeTextPx: 24 },
  ]) {
    await page.evaluate(async (appearance) => {
      const { setAppearanceRangeSetting } = await import("/assets/settings.js");
      for (const [name, value] of Object.entries(appearance)) {
        setAppearanceRangeSetting(name, value);
      }
    }, settings);
    const layout = await taskReview.evaluate((review, modeSwitch) => {
      const viewer = review.shadowRoot.querySelector(".task-review-viewer-pane");
      const code = review
        .shadowRoot.querySelector("caffold-review-selected-file")
        .shadowRoot.querySelector("caffold-review-file-viewer")
        ?.shadowRoot.querySelector("caffold-diff-viewer")
        ?.shadowRoot.querySelector(".diff-code");
      return {
        overflow: review.scrollWidth > review.clientWidth,
        modeSwitchOverflow: modeSwitch.scrollWidth > modeSwitch.clientWidth,
        viewerOverflow: viewer.scrollWidth > viewer.clientWidth,
        codeFontSize: code ? getComputedStyle(code).fontSize : null,
        selectedInsets: [...review.shadowRoot.querySelectorAll(
          ".task-review-pane-axis > caffold-segmented-control",
        )].flatMap((control) => [
          ...control.shadowRoot.querySelectorAll('button[aria-pressed="true"] > span'),
        ].map((selected) => {
          const group = control.getBoundingClientRect();
          const visual = selected.getBoundingClientRect();
          return {
            bottom: group.bottom - visual.bottom,
            top: visual.top - group.top,
          };
        })),
        truncatedAxisLabels: [...review.shadowRoot.querySelectorAll(
          ".task-review-pane-axis > caffold-segmented-control",
        )]
          .flatMap((control) => [...control.shadowRoot.querySelectorAll("button > span")])
          .filter((label) => label.scrollWidth > label.clientWidth)
          .map((label) => label.textContent.trim()),
      };
    }, await page.locator("caffold-segmented-control[data-detail-view-switch]").elementHandle());
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

test("keeps compact Task segments pixel-aligned on Retina displays", { tag: "@all-viewports" }, async ({
  baseURL,
  browser,
}, testInfo) => {
  const viewportByProject = {
    desktop: { width: 1280, height: 800 },
    foldable: { width: 933, height: 704 },
    phone: { width: 390, height: 844 },
  };
  const isMobile = testInfo.project.name !== "desktop";
  const context = await browser.newContext({
    baseURL,
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
        const { setAppearanceRangeSetting } = await import("/assets/settings.js");
        setAppearanceRangeSetting("interfaceScalePercent", value);
      }, interfaceScalePercent);
      // The switches sit in the roots of the screens that draw them.
      const { devicePixelRatio, segments } = await page.locator("caffold-segmented-control").evaluateAll((groups) => ({
        devicePixelRatio: window.devicePixelRatio,
        segments: groups
          .filter((group) => group.getClientRects().length > 0)
          .map((group) => {
            const button = group.shadowRoot.querySelector('button[aria-pressed="true"]');
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

test("reflows Review at a desktop 200 percent effective viewport", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 400 });

  const layout = await taskReview.evaluate((review, modeSwitch) => ({
    overflow: review.scrollWidth > review.clientWidth,
    modeSwitchOverflow: modeSwitch.scrollWidth > modeSwitch.clientWidth,
    navigatorWidth: review
      .shadowRoot.querySelector(".task-review-navigator-pane")
      .getBoundingClientRect().width,
    viewerWidth: review
      .shadowRoot.querySelector(".task-review-viewer-pane")
      .getBoundingClientRect().width,
  }), await page.locator("caffold-segmented-control[data-detail-view-switch]").elementHandle());
  expect(layout.overflow).toBe(false);
  expect(layout.modeSwitchOverflow).toBe(false);
  expect(layout.navigatorWidth).toBeGreaterThanOrEqual(220);
  expect(layout.viewerWidth).toBeGreaterThanOrEqual(360);
});
