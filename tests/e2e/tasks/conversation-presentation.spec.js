import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("presents a completed canonical turn without duplicate or unsafe content", async ({
  page,
}, testInfo) => {
  const scenario = await installTaskLoopFixture(page);
  const { threadId } = scenario;
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toContainText(
    "The planner changes are ready to review.",
  );
  const assistantMarkdown = tasksPage.locator(
    '.task-message[data-message-role="assistant"] caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("h2")).toHaveText("Review ready");
  await expect(assistantMarkdown.locator("strong")).toHaveText("ready");
  await expect(assistantMarkdown.locator("li")).toHaveCount(2);
  await expect(assistantMarkdown.locator("pre code")).toHaveText("cargo test");
  await expect(assistantMarkdown.getByRole("link", { name: "Planner notes" })).toHaveAttribute(
    "href",
    "https://example.com/planner",
  );
  await expect(assistantMarkdown.locator("table")).toContainText("Planner");
  await expect(assistantMarkdown).toContainText("Malformed **marker stays readable.");
  await expect
    .poll(() =>
      assistantMarkdown.evaluate((element) => {
        const body = element.shadowRoot.querySelector(".markdown-body");
        return body.scrollWidth <= body.clientWidth;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(() => {
        const probe = document.createElement("caffold-task-markdown");
        probe.textContent = "Fallback content";
        document.body.append(probe);
        const fallback = probe.shadowRoot.querySelector(".markdown-fallback");
        const style = getComputedStyle(fallback);
        const result = {
          backgroundColor: style.backgroundColor,
          borderWidth: style.borderWidth,
          margin: style.margin,
          padding: style.padding,
        };
        probe.remove();
        return result;
      }),
    )
    .toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      margin: "0px",
      padding: "0px",
    });
  await tasksPage.evaluate(() => {
    const probe = document.createElement("caffold-task-markdown");
    probe.hidden = true;
    probe.textContent = "[unsafe](javascript:alert(1))";
    document.body.append(probe);
  });
  await expect(page.locator("caffold-task-markdown").last()).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  await expect(page.locator("caffold-task-markdown").last().locator("a")).toHaveCount(0);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toHaveCount(1);
  await expect(
    tasksPage.locator(
      '.task-message[data-message-role="assistant"][data-message-phase="final"]',
    ),
  ).toHaveCount(1);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).not.toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator(".task-turn-work")).toContainText("Worked for");
  await expect(tasksPage.locator(".task-turn-work")).toContainText("6 updates");
  await expect(tasksPage.locator(".task-turn-work > details")).not.toHaveAttribute("open", "");
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const work = element.querySelector(".task-turn-work");
        const assistant = element.querySelector('.task-message[data-message-role="assistant"]');
        const position = work && assistant ? work.compareDocumentPosition(assistant) : 0;
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-work-item")).toHaveCount(6);
  await expect(tasksPage.locator(".task-work-item").first()).not.toBeVisible();
  await tasksPage.locator(".task-turn-work > details > summary").click();
  await expect(
    tasksPage.locator('.task-work-item[data-event-type="assistant_message"]'),
  ).toContainText("I am checking the planner diff");
  await expect(tasksPage.locator('.task-work-item[data-event-type="reasoning"]')).toContainText(
    "Checked the planner diff.",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="plan"]')).toContainText(
    "Run focused tests",
  );
  const completedCommand = tasksPage.locator(
    '.task-work-item[data-event-type="command_execution"]',
  );
  await expect(tasksPage.locator(".task-turn-work").last()).toContainText("Command");
  await expect(completedCommand.locator("details")).not.toHaveAttribute("open", "");
  await completedCommand.locator("summary").click();
  await expect(completedCommand).toContainText("cargo test");
  await expect(completedCommand).toContainText("cwd: src");
  await expect(completedCommand).toContainText("completed");
  await expect(completedCommand).toContainText(
    "test result: ok",
  );
  const completedCommandOutput = completedCommand.locator("pre");
  await expect
    .poll(() =>
      completedCommandOutput.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(
        (element) =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  const workItemOrder = await tasksPage.locator(".task-work-item").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-event-type")),
  );
  expect(workItemOrder).toEqual([
    "approval_resolved",
    "reasoning",
    "plan",
    "command_execution",
    "file_change",
    "assistant_message",
  ]);
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "2 file change updates",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "tests/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/lib.rs",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-work-details");
  await tasksPage.locator(".task-turn-work > details > summary").click();
  await expect(tasksPage.locator(".task-turn-work > details")).not.toHaveAttribute("open", "");
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  await expect(tasksPage.locator(".task-follow-up-form")).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-scroll")).toHaveCSS("overflow-y", "auto");
  await expect(tasksPage).not.toContainText("assistant message");
  await expect(tasksPage).not.toContainText("user message");
  await expect(tasksPage).not.toContainText("turn started");
  const taskDetailsButton = tasksPage.getByRole("button", { name: /Task details/ });
  await expect(taskDetailsButton).toBeVisible();
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: idle");
  await taskDetailsButton.click();
  const taskDetailsPopover = tasksPage.locator(".task-detail-popover");
  await expect(taskDetailsPopover).toBeVisible();
  await expect(taskDetailsPopover).toContainText("idle");
  await expect(taskDetailsPopover).toContainText(threadId);
  await expect(taskDetailsPopover).toContainText("src");
  await expect(taskDetailsPopover).toContainText("Worktree");
  await expect(taskDetailsPopover).toContainText("Branch");
  await expect(taskDetailsPopover).toContainText("main");
  const detailActionGeometry = await tasksPage
    .locator(
      ".task-detail-actions > button, .task-detail-actions > details > summary, .task-detail-info-button",
    )
    .evaluateAll((controls) =>
      controls.map((control) => {
        const icon = control.querySelector("svg, img");
        const controlBox = control.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        return {
          iconOnly:
            control.matches(".task-brand-button, .task-detail-info-button") ||
            control.classList.contains("task-icon-button"),
          iconWidth: iconBox.width,
          iconHeight: iconBox.height,
          centerDeltaX: Math.abs(
            controlBox.left + controlBox.width / 2 -
              (iconBox.left + iconBox.width / 2),
          ),
          centerDeltaY: Math.abs(
            controlBox.top + controlBox.height / 2 -
              (iconBox.top + iconBox.height / 2),
          ),
          width: controlBox.width,
          height: controlBox.height,
        };
      }),
    );
  expect(detailActionGeometry.length).toBeGreaterThan(2);
  for (const geometry of detailActionGeometry) {
    expect(geometry.iconWidth).toBeCloseTo(geometry.iconHeight, 1);
    if (geometry.iconOnly) {
      expect(geometry.centerDeltaX).toBeLessThanOrEqual(0.5);
    }
    expect(geometry.centerDeltaY).toBeLessThanOrEqual(0.5);
  }
  expect(new Set(detailActionGeometry.map(({ iconWidth }) => iconWidth)).size).toBe(1);
  const contextualControlGeometry = await tasksPage.evaluate((element) => {
    const modeSwitch = element.querySelector(".task-mode-switch");
    const controls = [
      modeSwitch,
      ...element.querySelectorAll(
        ".task-detail-actions > button, .task-detail-actions > details > summary, .task-detail-info-button",
      ),
    ];
    const modeButtons = [...modeSwitch.querySelectorAll("button")];
    const expandedTouchControls = [
      ...element.querySelectorAll(
        ".task-detail-actions > button, .task-detail-actions > details > summary, .task-detail-info-button",
      ),
    ];
    return {
      heights: controls.map((control) => control.getBoundingClientRect().height),
      modeButtonHeights: modeButtons.map(
        (control) => control.getBoundingClientRect().height,
      ),
      selectedInset: (() => {
        const selected = modeSwitch.querySelector('button[aria-pressed="true"] > span');
        const group = modeSwitch.getBoundingClientRect();
        const visual = selected.getBoundingClientRect();
        return {
          bottom: group.bottom - visual.bottom,
          top: visual.top - group.top,
        };
      })(),
      expandedTouchHits: expandedTouchControls.map((control) => {
        const bounds = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top - 3,
        );
        return hit === control || control.contains(hit);
      }),
    };
  });
  expect(
    Math.max(...contextualControlGeometry.heights) -
      Math.min(...contextualControlGeometry.heights),
  ).toBeLessThanOrEqual(1);
  expect(contextualControlGeometry.selectedInset.top).toBeGreaterThanOrEqual(0);
  expect(contextualControlGeometry.selectedInset.bottom).toBeGreaterThanOrEqual(0);
  expect(contextualControlGeometry.selectedInset.top).toBeLessThanOrEqual(2);
  expect(contextualControlGeometry.selectedInset.bottom).toBeLessThanOrEqual(2);
  if (testInfo.project.name !== "desktop") {
    expect(Math.max(...contextualControlGeometry.heights)).toBeLessThanOrEqual(34);
    expect(Math.min(...contextualControlGeometry.modeButtonHeights)).toBeGreaterThanOrEqual(40);
    expect(contextualControlGeometry.expandedTouchHits.every(Boolean)).toBe(true);
  }
  const workspaceHeaderMetrics = await tasksPage.evaluate((element) => {
    const appHeader = element.querySelector(".tasks-header");
    const close = document.querySelector(".codex-workspace-close");
    const summary = element.querySelector(".task-detail-summary");
    const summaryBounds = summary.getBoundingClientRect();
    const headingBounds = summary
      .querySelector(".task-detail-heading")
      .getBoundingClientRect();
    const actionBounds = summary
      .querySelector(".task-detail-actions")
      .getBoundingClientRect();
    const closeBounds = close.getBoundingClientRect();
    const titleBounds = summary.querySelector("h2").getBoundingClientRect();
    return {
      appHeaderVisible:
        getComputedStyle(appHeader).display !== "none" &&
        appHeader.getBoundingClientRect().height > 0,
      closeSize: closeBounds.width,
      closeTitleCenterDelta: Math.abs(
        closeBounds.top + closeBounds.height / 2 -
          (titleBounds.top + titleBounds.height / 2),
      ),
      closeVisible:
        getComputedStyle(close).display !== "none" &&
        close.getBoundingClientRect().width > 0,
      overflow: element.scrollWidth > element.clientWidth,
      sameRow:
        Math.abs(
          headingBounds.top + headingBounds.height / 2 -
            (actionBounds.top + actionBounds.height / 2),
        ) <= 1,
      summaryHeight: summaryBounds.height,
      summaryTop: Math.round(summaryBounds.top),
      surfaceTop: Math.round(element.getBoundingClientRect().top),
    };
  });
  expect(workspaceHeaderMetrics.appHeaderVisible).toBe(false);
  expect(workspaceHeaderMetrics.summaryTop).toBe(workspaceHeaderMetrics.surfaceTop);
  expect(workspaceHeaderMetrics.overflow).toBe(false);
  if (testInfo.project.name !== "phone") {
    const navigatorClearance = await tasksPage.evaluate((element) => {
      const sectionTitle = element
        .querySelector(".task-list-section:first-child h2")
        .getBoundingClientRect();
      const sectionHeader = element
        .querySelector(".task-list-section:first-child .task-list-section-header")
        .getBoundingClientRect();
      const summary = element
        .querySelector(".task-detail-summary")
        .getBoundingClientRect();
      return {
        headerBottomDelta: Math.abs(sectionHeader.bottom - summary.bottom),
        sectionTitleInset: sectionTitle.left - sectionHeader.left,
      };
    });
    expect(workspaceHeaderMetrics.closeVisible).toBe(false);
    expect(navigatorClearance.sectionTitleInset).toBeLessThanOrEqual(16);
    expect(navigatorClearance.headerBottomDelta).toBeLessThanOrEqual(1);
  } else {
    expect(workspaceHeaderMetrics.closeVisible).toBe(true);
    expect(workspaceHeaderMetrics.closeSize).toBeGreaterThanOrEqual(40);
    expect(workspaceHeaderMetrics.closeTitleCenterDelta).toBeLessThanOrEqual(2);
  }
  if (testInfo.project.name === "phone") {
    expect(workspaceHeaderMetrics.sameRow).toBe(false);
    expect(workspaceHeaderMetrics.summaryHeight).toBeLessThanOrEqual(112);
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-mobile-header-details");
  } else {
    expect(workspaceHeaderMetrics.sameRow).toBe(true);
    expect(workspaceHeaderMetrics.summaryHeight).toBeLessThanOrEqual(64);
  }
  if (testInfo.project.name === "foldable") {
    await page.setViewportSize({ width: 800, height: 1100 });
    const compactFoldableHeader = await tasksPage.evaluate((element) => {
      const summary = element.querySelector(".task-detail-summary");
      const heading = summary
        .querySelector(".task-detail-heading")
        .getBoundingClientRect();
      const actions = summary
        .querySelector(".task-detail-actions")
        .getBoundingClientRect();
      return {
        closeVisible:
          getComputedStyle(document.querySelector(".codex-workspace-close"))
            .display !== "none",
        sameRow:
          Math.abs(
            heading.top + heading.height / 2 -
              (actions.top + actions.height / 2),
          ) <= 1,
        summaryHeight: summary.getBoundingClientRect().height,
      };
    });
    expect(compactFoldableHeader.closeVisible).toBe(true);
    expect(compactFoldableHeader.sameRow).toBe(true);
    expect(compactFoldableHeader.summaryHeight).toBeLessThanOrEqual(64);
  }
  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeHidden();
  await stabilizeDynamicText(page);
  if (testInfo.project.name === "foldable") {
    await captureReviewScreenshot(page, testInfo, "tasks-foldable-compact-header");
  }
  await captureReviewScreenshot(page, testInfo, "tasks-conversation");
});
