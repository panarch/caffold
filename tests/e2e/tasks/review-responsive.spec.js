import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

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
    const close = document.querySelector(".codex-workspace-close").getBoundingClientRect();
    const heading = document
      .querySelector("caffold-task-detail-summary .task-detail-heading")
      .getBoundingClientRect();
    return {
      closeRight: close.right,
      headingLeft: heading.left,
      headingWidth: heading.width,
    };
  });
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

test("keeps Review reflowed at the appearance extremes", async ({ page }) => {
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
      };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.toolbarOverflow).toBe(false);
    expect(layout.viewerOverflow).toBe(false);
    expect(layout.codeFontSize).toBe(`${settings.codeTextPx}px`);
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
