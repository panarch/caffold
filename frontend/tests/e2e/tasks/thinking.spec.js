import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  activateActionHint,
  enterActionHints,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("owns Thinking disclosure state, anchor, and exact target boundary", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedActiveThinkingTask(page);
  const thinkingDisclosure = page.locator(".task-thinking > details");
  const thinkingSummary = thinkingDisclosure.locator(":scope > summary");
  const thinking = thinkingDisclosure.locator(
    ":scope > .task-thinking-content > caffold-task-markdown",
  );

  await expect(thinkingDisclosure).toHaveAttribute("open", "");
  await thinkingSummary.scrollIntoViewIfNeeded();
  await nextPaint(page);
  const thinkingHints = await enterActionHints(page);
  await expect(thinkingHints.getByLabel(/Collapse Thinking$/)).toBeVisible();
  await captureReviewScreenshot(
    page,
    testInfo,
    "task-thinking-disclosure-hints",
  );
  await page.keyboard.press("Escape");

  const conversationScroll = page.locator(
    "caffold-task-conversation > .task-conversation-scroll",
  );
  const collapseHeight = await thinkingDisclosure.evaluate((element) =>
    element.getBoundingClientRect().height -
    element.querySelector(":scope > summary").getBoundingClientRect().height
  );
  const anchorSlack = await conversationScroll.evaluate(
    (element, requiredSlack) => {
      const maxScrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight,
      );
      element.scrollTop = Math.max(0, maxScrollTop - requiredSlack);
      return maxScrollTop - element.scrollTop;
    },
    collapseHeight + 32,
  );
  expect(anchorSlack).toBeGreaterThan(collapseHeight);
  await nextPaint(page);
  const thinkingTop = await thinkingSummary.evaluate(
    (element) => element.getBoundingClientRect().top,
  );

  await activateActionHint(page, /Collapse Thinking$/);
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(thinkingDisclosure).not.toHaveAttribute("open", "");
  await expect(thinking).not.toBeVisible();
  await expect
    .poll(() =>
      thinkingSummary.evaluate((element) => document.activeElement === element)
    )
    .toBe(true);
  await expect
    .poll(() =>
      thinkingSummary.evaluate((element) => element.getBoundingClientRect().top)
    )
    .toBeCloseTo(thinkingTop, 1);

  await thinkingSummary.scrollIntoViewIfNeeded();
  await nextPaint(page);
  await activateActionHint(page, /Expand Thinking$/);
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(thinkingDisclosure).toHaveAttribute("open", "");
  await expect(thinking).toBeVisible();
  await expect
    .poll(() =>
      thinkingSummary.evaluate((element) => element.getBoundingClientRect().top)
    )
    .toBeCloseTo(thinkingTop, 1);

  await thinkingDisclosure.evaluate((element) => {
    window.__thinkingDisclosureOwner = element;
  });
  scenario.updateTask({ lastEventSummary: "Reasoning summary updated" });
  await page.evaluate(
    ({ detail, threadId }) => {
      const source = window.__caffoldMockEventSources.find(
        (candidate) =>
          candidate.url === `/api/tasks/${threadId}/stream` &&
          candidate.readyState !== 2,
      );
      if (!source) {
        throw new Error(`Task detail stream not found for ${threadId}`);
      }
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        reason: "canonical-sync",
        detail,
      });
    },
    {
      threadId: scenario.threadId,
      detail: scenario.detailResponse({ revision: 2 }),
    },
  );
  await expect
    .poll(() =>
      thinkingDisclosure.evaluate(
        (element) => element === window.__thinkingDisclosureOwner,
      )
    )
    .toBe(true);
  await expect(thinkingDisclosure).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      thinkingSummary.evaluate((element) => element.getBoundingClientRect().top)
    )
    .toBeCloseTo(thinkingTop, 1);

  await thinking.evaluate((markdown) => {
    const unrelated = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Unrelated Markdown disclosure";
    unrelated.append(summary, "Third-party content");
    markdown.append(unrelated);
  });
  const unrelatedHints = await enterActionHints(page);
  await expect(
    unrelatedHints.getByLabel(/Unrelated Markdown disclosure$/),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expect(thinking).toHaveAttribute("data-render-state", "markdown");
  await expect(thinking).not.toHaveAttribute("code-block-controls", "");
  await expect(thinking.locator("pre > code")).toHaveText("thinking-only\n");
  await expect(
    thinking.locator("caffold-task-markdown-code-block"),
  ).toHaveCount(0);
  await expect(thinking.locator("[data-code-action]")).toHaveCount(0);
  expect(scenario.pageErrors).toEqual([]);
});

async function seedActiveThinkingTask(page) {
  const scenario = await installTaskLoopFixture(page, {
    threadId: "thread_thinking_disclosure",
  });
  await scenario.seedCompletedTask();
  scenario.events = [
    ...scenario.events,
    scenario.eventRecord(
      "turn_2_started",
      "turn_started",
      "Turn started",
      { turnId: "turn_2" },
      20,
    ),
    scenario.eventRecord(
      "turn_2_reasoning",
      "reasoning",
      "Reasoning summary",
      {
        turnId: "turn_2",
        summary: ["Thinking details\n\n```text\nthinking-only\n```"],
      },
      21,
    ),
  ];
  scenario.updateTask({
    ...canonicalTaskState("active", {
      turnId: "turn_2",
      latestTurnStatus: "inProgress",
    }),
    lastEventSummary: "Reasoning summary",
  });
  await page.goto(`/tasks/${scenario.threadId}`);
  return scenario;
}

async function nextPaint(page) {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
}
