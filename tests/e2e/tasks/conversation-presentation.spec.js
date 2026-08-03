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
  const contextualControlSize = await tasksPage.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;height:var(--interface-compact-control-size)";
    document.body.append(probe);
    const value = probe.getBoundingClientRect().height;
    probe.remove();
    return value;
  });
  for (const geometry of detailActionGeometry) {
    expect(geometry.height).toBeCloseTo(contextualControlSize, 1);
    if (geometry.iconOnly) {
      expect(geometry.width).toBeCloseTo(contextualControlSize, 1);
    }
  }
  if (testInfo.project.name === "phone") {
    const mobileHeaderMetrics = await tasksPage.evaluate((element) => {
      const header = element.querySelector(".tasks-header").getBoundingClientRect();
      const summary = element.querySelector(".task-detail-summary").getBoundingClientRect();
      const actions = [
        ...element.querySelectorAll(
          ".task-detail-actions > button, .task-detail-actions > details > summary",
        ),
      ].map((control) => control.getBoundingClientRect());
      const details = element
        .querySelector(".task-detail-info-button")
        .getBoundingClientRect();
      return {
        headerHeight: header.height,
        summaryHeight: summary.height,
        overflow: element.scrollWidth > element.clientWidth,
        actionSizes: [...actions, details].map((box) => ({
          height: box.height,
          width: box.width,
        })),
      };
    });
    expect(mobileHeaderMetrics.headerHeight).toBeLessThanOrEqual(64);
    expect(mobileHeaderMetrics.summaryHeight).toBeLessThanOrEqual(64);
    expect(mobileHeaderMetrics.overflow).toBe(false);
    for (const size of mobileHeaderMetrics.actionSizes) {
      expect(Math.round(size.width)).toBe(40);
      expect(Math.round(size.height)).toBe(40);
    }
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-mobile-header-details");
  }
  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-conversation");
});
