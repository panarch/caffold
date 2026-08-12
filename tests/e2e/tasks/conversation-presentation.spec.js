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

test("preserves ordered-list starts through Task Markdown sanitization", async ({ page }) => {
  const completedAssistantResponse = [
    "1. First",
    "",
    "- detail",
    "",
    "2. Second",
    "",
    "- detail",
    "",
    "3. Third",
  ].join("\n");
  const scenario = await installTaskLoopFixture(page, {
    completedAssistantResponse,
    threadId: "thread_ordered_list_starts",
  });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);

  const tasksPage = page.locator("caffold-tasks-page");
  const assistantMarkdown = tasksPage.locator(
    '.task-message[data-message-role="assistant"] caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("ol")).toHaveCount(3);
  await expect(assistantMarkdown.locator("ul")).toHaveCount(2);
  expect(
    await assistantMarkdown.locator("ol").evaluateAll((lists) =>
      lists.map((list) => ({
        effectiveStart: list.start,
        start: list.getAttribute("start"),
        text: list.textContent.trim(),
      })),
    ),
  ).toEqual([
    { effectiveStart: 1, start: null, text: "First" },
    { effectiveStart: 2, start: "2", text: "Second" },
    { effectiveStart: 3, start: "3", text: "Third" },
  ]);

  await tasksPage.evaluate(() => {
    const probes = [
      {
        id: "fifth",
        markdown: "5. Fifth",
      },
      {
        id: "attributes",
        markdown: [
          '<ol start="7" class="discard" data-extra="discard" onclick="discard()"><li id="discard">Valid</li></ol>',
          "",
          '<ol start="not-an-integer"><li>Malformed</li></ol>',
          "",
          '<ol start="+8"><li>Plus-prefixed</li></ol>',
          "",
          '<ol start=" 9"><li>Whitespace-prefixed</li></ol>',
          "",
          '<ol start="-2" aria-label="discard"><li>Negative</li></ol>',
          "",
          '<ul start="4" data-extra="discard"><li>Wrong element</li></ul>',
        ].join("\n"),
      },
      {
        id: "list-features",
        markdown: [
          "1. One",
          "2. Two",
          "",
          "- Parent",
          "  - Nested detail",
          "",
          "- [x] Complete",
          "- [ ] Pending",
        ].join("\n"),
      },
    ];

    for (const { id, markdown } of probes) {
      const probe = document.createElement("caffold-task-markdown");
      probe.dataset.testProbe = id;
      probe.hidden = true;
      probe.textContent = markdown;
      document.body.append(probe);
    }
  });

  const fifth = page.locator('caffold-task-markdown[data-test-probe="fifth"]');
  await expect(fifth).toHaveAttribute("data-render-state", "markdown");
  await expect(fifth.locator("ol")).toHaveAttribute("start", "5");
  expect(await fifth.locator("ol").evaluate((list) => list.start)).toBe(5);

  const attributes = page.locator('caffold-task-markdown[data-test-probe="attributes"]');
  await expect(attributes).toHaveAttribute("data-render-state", "markdown");
  expect(
    await attributes.locator("ol").evaluateAll((lists) =>
      lists.map((list) => ({
        attributes: [...list.attributes].map((attribute) => attribute.name).sort(),
        effectiveStart: list.start,
        itemAttributes: [...list.querySelector("li").attributes].map(
          (attribute) => attribute.name,
        ),
        start: list.getAttribute("start"),
      })),
    ),
  ).toEqual([
    { attributes: ["start"], effectiveStart: 7, itemAttributes: [], start: "7" },
    { attributes: [], effectiveStart: 1, itemAttributes: [], start: null },
    { attributes: [], effectiveStart: 1, itemAttributes: [], start: null },
    { attributes: [], effectiveStart: 1, itemAttributes: [], start: null },
    { attributes: ["start"], effectiveStart: -2, itemAttributes: [], start: "-2" },
  ]);
  expect(
    await attributes.locator("ul").evaluate((list) =>
      [...list.attributes].map((attribute) => attribute.name),
    ),
  ).toEqual([]);

  const listFeatures = page.locator(
    'caffold-task-markdown[data-test-probe="list-features"]',
  );
  await expect(listFeatures).toHaveAttribute("data-render-state", "markdown");
  await expect(listFeatures.locator("ol > li")).toHaveCount(2);
  expect(await listFeatures.locator("ol").evaluate((list) => list.start)).toBe(1);
  await expect(listFeatures.locator("ul ul > li")).toHaveText("Nested detail");
  const checkboxes = listFeatures.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.first()).toBeChecked();
  await expect(checkboxes.last()).not.toBeChecked();
  await expect(checkboxes.first()).toBeDisabled();
  await expect(checkboxes.last()).toBeDisabled();
});

test("presents a completed canonical turn without duplicate or unsafe content", async ({
  page,
}, testInfo) => {
  const contextPath = "Users/taehoon/Workspace/rust/codger";
  const scenario = await installTaskLoopFixture(page, {
    contextPath,
    threadId: "019fd747-1247-7bb0-998b-9aec53bdf7f2",
  });
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
  await expect(tasksPage.locator(".task-turn-work")).toContainText("7 updates");
  await expect(
    tasksPage.locator("caffold-task-work-details > details"),
  ).not.toHaveAttribute("open", "");
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
  await expect(tasksPage.locator(".task-work-details-item")).toHaveCount(7);
  await expect(tasksPage.locator(".task-work-details-item").first()).not.toBeVisible();
  const workDetails = tasksPage.locator("caffold-task-work-details > details");
  const workSummary = workDetails.locator(":scope > summary");
  await workSummary.scrollIntoViewIfNeeded();
  const workSummaryOffset = await workSummary.evaluate((summary) => {
    const scroller = summary.closest(".task-conversation-scroll");
    return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  await workSummary.click();
  await expect(workDetails).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      workSummary.evaluate((summary) => {
        const scroller = summary.closest(".task-conversation-scroll");
        return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }),
    )
    .toBeCloseTo(workSummaryOffset, 1);
  await expect(
    tasksPage.locator('.task-work-details-item[data-event-type="assistant_message"]'),
  ).toContainText("I am checking the planner diff");
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="reasoning"]')).toContainText(
    "Checked the planner diff.",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="plan"]')).toContainText(
    "Run focused tests",
  );
  const completedCommand = tasksPage.locator(
    '.task-work-details-item[data-event-type="command_execution"][data-command-status="completed"]',
  );
  const completedCommandButton = completedCommand.locator(".task-work-details-command-summary");
  await expect(completedCommand.locator("details")).toHaveCount(0);
  await expect(completedCommandButton).toContainText("Completed");
  await expect(completedCommandButton).toContainText("cargo test");
  await expect(completedCommandButton).toContainText("1s");
  await expect(completedCommandButton).not.toContainText("test result: ok");
  await completedCommandButton.scrollIntoViewIfNeeded();
  const conversationScrollBeforeDialog = await tasksPage
    .locator(".task-conversation-scroll")
    .evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
  const commandRowHeight = await completedCommand.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await completedCommandButton.click();
  const commandDialog = tasksPage.locator("caffold-task-command-dialog dialog");
  const commandDialogClose = commandDialog.getByRole("button", {
    name: "Close command output",
  });
  await expect(commandDialog).toHaveAttribute("open", "");
  await expect(
    commandDialogClose.locator(".task-command-dialog-close-icon"),
  ).toBeVisible();
  await expect
    .poll(() =>
      commandDialogClose.evaluate((button) => {
        const { width, height } = button.getBoundingClientRect();
        return Math.abs(width - height);
      }),
    )
    .toBeLessThan(1);
  await expect(commandDialog).toContainText("cargo test");
  await expect(commandDialog).toContainText("Working directory");
  await expect(commandDialog).toContainText("src");
  await expect(commandDialog).toContainText("Completed");
  await expect(commandDialog).toContainText("1s");
  await expect(commandDialog).toContainText("Exit code");
  await expect(commandDialog).toContainText("test result: ok");
  const completedCommandOutput = commandDialog.locator(".task-command-dialog-output pre");
  await expect
    .poll(() =>
      completedCommandOutput.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      commandDialog.locator(".task-command-dialog-body").evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  const commandDialogBody = commandDialog.locator(".task-command-dialog-body");
  await expect
    .poll(() =>
      commandDialogBody.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      }),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      })),
    )
    .toEqual(conversationScrollBeforeDialog);
  await captureReviewScreenshot(page, testInfo, "tasks-command-output");
  await commandDialogClose.click();
  await expect(commandDialog).not.toHaveAttribute("open", "");
  await expect
    .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(completedCommandButton).toBeFocused();
  await expect
    .poll(() => completedCommand.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(commandRowHeight, 1);

  await test.step("resets after opening when a hidden scroller ignores reset", async () => {
    await completedCommandButton.click();
    await commandDialogBody.evaluate((element) => {
      let prototype = Object.getPrototypeOf(element);
      let descriptor = null;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
        prototype = Object.getPrototypeOf(prototype);
      }
      if (!descriptor?.get || !descriptor?.set) {
        throw new Error("scrollTop accessors are unavailable");
      }
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          if (Number(value) === 0 && !this.closest("dialog")?.open) {
            return;
          }
          descriptor.set.call(this, value);
        },
      });
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await commandDialogClose.click();
    await completedCommandButton.click();
    await expect
      .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
      .toBe(0);
    await commandDialogBody.evaluate((element) => {
      delete element.scrollTop;
    });
    await commandDialogClose.click();
  });

  const failedCommand = tasksPage.locator(
    '.task-work-details-item[data-event-type="command_execution"][data-command-status="failed"]',
  );
  const failedCommandButton = failedCommand.locator(".task-work-details-command-summary");
  await expect(failedCommandButton).toContainText("Failed");
  await expect(failedCommandButton).toContainText("Exit 101");
  await failedCommandButton.click();
  await expect(commandDialog).toHaveAttribute("data-command-status", "failed");
  await expect
    .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(commandDialog).toContainText("cargo test --package missing");
  await expect(commandDialog).toContainText("2s");
  await expect(commandDialog).toContainText("101");
  await expect(commandDialog).toContainText("package `missing` was not found");
  await page.keyboard.press("Escape");
  await expect(commandDialog).not.toHaveAttribute("open", "");
  await expect(failedCommandButton).toBeFocused();

  await failedCommandButton.click();
  await expect(commandDialog).toHaveAttribute("open", "");
  await page.mouse.click(1, 1);
  await expect(commandDialog).not.toHaveAttribute("open", "");
  await expect(failedCommandButton).toBeFocused();
  await expect
    .poll(() =>
      tasksPage.evaluate(
        (element) =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  const workItemOrder = await tasksPage.locator(".task-work-details-item").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-event-type")),
  );
  expect(workItemOrder).toEqual([
    "approval_resolved",
    "reasoning",
    "plan",
    "command_execution",
    "command_execution",
    "file_change",
    "assistant_message",
  ]);
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "2 file change updates",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "src/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "tests/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "src/lib.rs",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-work-details");
  await tasksPage.locator("caffold-task-work-details > details > summary").click();
  await expect(
    tasksPage.locator("caffold-task-work-details > details"),
  ).not.toHaveAttribute("open", "");
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
  await expect(taskDetailsPopover).toContainText(contextPath);
  await expect(taskDetailsPopover).toContainText("Worktree");
  await expect(taskDetailsPopover).toContainText("Branch");
  await expect(taskDetailsPopover).toContainText("main");
  if (testInfo.project.name !== "phone") {
    const metadataLayout = await taskDetailsPopover.evaluate((popover) => {
      const values = new Map(
        [...popover.querySelectorAll("dl > div")].map((row) => [
          row.querySelector("dt").textContent,
          row.querySelector("dd"),
        ]),
      );
      const lineCount = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].filter(({ width, height }) => width > 0 && height > 0)
          .length;
      };
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      return {
        maxWidth: Math.min(42 * rootFontSize, innerWidth - 1.5 * rootFontSize),
        threadLines: lineCount(values.get("Thread")),
        workingDirectoryLines: lineCount(values.get("Working directory")),
        worktreeLines: lineCount(values.get("Worktree")),
        width: popover.getBoundingClientRect().width,
      };
    });
    expect(metadataLayout.width).toBeLessThan(metadataLayout.maxWidth);
    expect(metadataLayout.threadLines).toBe(1);
    expect(metadataLayout.workingDirectoryLines).toBe(1);
    expect(metadataLayout.worktreeLines).toBe(1);
  }
  const [taskDetailsButtonBox, taskDetailsPopoverBox] = await Promise.all([
    taskDetailsButton.boundingBox(),
    taskDetailsPopover.boundingBox(),
  ]);
  expect(taskDetailsButtonBox).not.toBeNull();
  expect(taskDetailsPopoverBox).not.toBeNull();
  expect(taskDetailsPopoverBox.x).toBeGreaterThanOrEqual(7);
  expect(
    taskDetailsPopoverBox.x + taskDetailsPopoverBox.width,
  ).toBeLessThanOrEqual(page.viewportSize().width - 7);
  expect(taskDetailsPopoverBox.y).toBeGreaterThanOrEqual(
    taskDetailsButtonBox.y + taskDetailsButtonBox.height + 4,
  );
  expect(taskDetailsButtonBox.x + taskDetailsButtonBox.width / 2).toBeGreaterThanOrEqual(
    taskDetailsPopoverBox.x - 1,
  );
  expect(taskDetailsButtonBox.x + taskDetailsButtonBox.width / 2).toBeLessThanOrEqual(
    taskDetailsPopoverBox.x + taskDetailsPopoverBox.width + 1,
  );
  const detailActionGeometry = await tasksPage
    .locator(
      ".task-detail-actions > caffold-task-detail-git > .task-git-button, .task-detail-actions > caffold-task-detail-github > .task-github-button, .task-detail-info-button",
    )
    .evaluateAll((controls) =>
      controls.map((control) => {
        const icon = control.querySelector(
          "svg, img, .task-git-icon, .task-github-icon",
        );
        const chip = control.querySelector(".task-status-chip");
        const controlBox = control.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        const chipBox = chip?.getBoundingClientRect();
        return {
          label:
            control.getAttribute("aria-label") ||
            control.getAttribute("title") ||
            control.className,
          iconOnly:
            control.matches(
              ".task-git-button, .task-github-button, .task-detail-info-button",
            ) ||
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
          controlTop: controlBox.top,
          iconTop: iconBox.top,
          chipTop: chipBox?.top ?? null,
          chipHeight: chipBox?.height ?? null,
        };
      }),
    );
  expect(detailActionGeometry.length).toBeGreaterThan(2);
  for (const geometry of detailActionGeometry) {
    expect(geometry.iconWidth).toBeCloseTo(geometry.iconHeight, 1);
    if (geometry.iconOnly) {
      expect(geometry.centerDeltaX).toBeLessThanOrEqual(0.5);
    }
    expect(
      geometry.centerDeltaY,
      `${geometry.label} icon must stay vertically centered: ${JSON.stringify(geometry)}`,
    ).toBeLessThanOrEqual(0.5);
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
    ].filter((control) => !control.matches(":disabled"));
    return {
      visualHeights: controls.map((control) => {
        const bounds = control.getBoundingClientRect();
        if (control === modeSwitch) {
          return bounds.height;
        }
        const visual = getComputedStyle(control, "::before");
        const top = Number.parseFloat(visual.top) || 0;
        const bottom = Number.parseFloat(visual.bottom) || 0;
        return Math.min(bounds.height, bounds.height - top - bottom);
      }),
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
        const hitEdgeY = bounds.height >= 39 ? bounds.top + 1 : bounds.top - 3;
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          hitEdgeY,
        );
        return {
          label:
            control.getAttribute("aria-label") ||
            control.getAttribute("title") ||
            control.className,
          hit: hit === control || control.contains(hit),
          hitLabel:
            hit?.getAttribute?.("aria-label") ||
            hit?.getAttribute?.("title") ||
            hit?.className ||
            hit?.tagName ||
            null,
        };
      }),
    };
  });
  expect(
    Math.max(...contextualControlGeometry.visualHeights) -
      Math.min(...contextualControlGeometry.visualHeights),
  ).toBeLessThanOrEqual(1);
  expect(contextualControlGeometry.selectedInset.top).toBeGreaterThanOrEqual(0);
  expect(contextualControlGeometry.selectedInset.bottom).toBeGreaterThanOrEqual(0);
  expect(contextualControlGeometry.selectedInset.top).toBeLessThanOrEqual(2);
  expect(contextualControlGeometry.selectedInset.bottom).toBeLessThanOrEqual(2);
  if (testInfo.project.name !== "desktop") {
    expect(Math.max(...contextualControlGeometry.visualHeights)).toBeLessThanOrEqual(34);
    expect(Math.min(...contextualControlGeometry.modeButtonHeights)).toBeGreaterThanOrEqual(40);
    expect(
      contextualControlGeometry.expandedTouchHits.every(({ hit }) => hit),
      JSON.stringify(contextualControlGeometry.expandedTouchHits),
    ).toBe(true);
  }
  const workspaceHeaderMetrics = await tasksPage.evaluate((element) => {
    const close = document.querySelector(".task-workspace-back");
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
      appHeaderCount: element.querySelectorAll(".tasks-header").length,
      closeSize: closeBounds.width,
      closeTitleCenterDelta: Math.abs(
        closeBounds.top + closeBounds.height / 2 -
          (titleBounds.top + titleBounds.height / 2),
      ),
      closeVisible:
        getComputedStyle(close).display !== "none" &&
        close.getBoundingClientRect().width > 0,
      overflow: element.scrollWidth > element.clientWidth,
      actionHeight: actionBounds.height,
      actionChildren: [...summary.querySelectorAll(
        ".task-detail-actions > *, .task-detail-info-button",
      )].map((control) => ({
        className: control.className,
        height: control.getBoundingClientRect().height,
      })),
      paddingBlock: getComputedStyle(summary).paddingBlock,
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
  expect(workspaceHeaderMetrics.appHeaderCount).toBe(0);
  expect(workspaceHeaderMetrics.summaryTop).toBe(workspaceHeaderMetrics.surfaceTop);
  expect(workspaceHeaderMetrics.overflow).toBe(false);
  if (testInfo.project.name !== "phone") {
    const navigatorClearance = await page
      .locator("caffold-task-workspace")
      .evaluate((element) => {
        const sectionHeader = element
          .querySelector(".task-list-primary-header")
          .getBoundingClientRect();
        const summary = element
          .querySelector(".task-detail-summary")
          .getBoundingClientRect();
        return {
          headerBottomDelta: Math.abs(sectionHeader.bottom - summary.bottom),
        };
      });
    expect(workspaceHeaderMetrics.closeVisible).toBe(false);
    expect(
      navigatorClearance.headerBottomDelta,
      JSON.stringify({ navigatorClearance, workspaceHeaderMetrics }),
    ).toBeLessThanOrEqual(1);
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
          getComputedStyle(document.querySelector(".task-workspace-back"))
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
