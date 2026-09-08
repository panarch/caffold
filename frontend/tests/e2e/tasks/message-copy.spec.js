import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
} from "../support/task-fixtures.js";

// The leading zero-width space is dropped when the Markdown is drawn, so a
// copy that keeps it is copying the text the conversation holds.
const FINAL_RESPONSE = [
  "\u200B## Planner review",
  "",
  "Inline `planner.rs` stays inline.",
  "",
  "```sh",
  "printf '<user>&'",
  "```",
  "",
  "- first",
  "- second",
].join("\n");
const FOLDED_RESPONSE =
  "I am checking the planner diff before the final answer.";
const INLINE_RESPONSE = "Interim output\n\n```text\ninterim-only\n```";

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installBrowserDefaults(page);
});

test("offers Copy beside every agent message time without growing the meta line", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedMessageCopyTask(
    page,
    "thread_message_copy_layout_" + testInfo.project.name,
    { activeTurn: true },
  );
  const tasksPage = page.locator("caffold-tasks-page");
  const finalMessage = tasksPage.locator(
    'caffold-task-assistant-message[data-message-phase="final"]',
  );
  const inlineMessage = tasksPage.locator(
    '.task-assistant-message > caffold-task-assistant-message[data-message-phase="progress"]',
  );
  const workDetails = tasksPage.locator("caffold-task-work-details");
  const foldedMessage = workDetails.locator(
    ".task-work-details-message > caffold-task-assistant-message",
  );
  const copyButtons = (message) =>
    message.getByRole("button", { name: "Copy message" });

  const copyComponents = (message) =>
    message.locator("caffold-task-assistant-message-copy-button");

  for (const message of [finalMessage, inlineMessage]) {
    await expect(copyComponents(message)).toHaveCount(1);
    await expect(copyButtons(message)).toHaveCount(1);
    await expect(
      message.locator(
        ":scope > .task-assistant-message-header > caffold-task-assistant-message-copy-button",
      ),
    ).toHaveCount(1);
  }
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]')
      .getByRole("button", { name: /Copy/ }),
  ).toHaveCount(0);
  await expect(
    tasksPage.locator(".task-thinking").getByRole("button", { name: /Copy/ }),
  ).toHaveCount(0);

  const summary = workDetails.locator(":scope > details > summary");
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await expect(workDetails.locator(":scope > details")).toHaveAttribute("open", "");
  await expect(copyComponents(foldedMessage)).toHaveCount(1);
  await expect(copyButtons(foldedMessage)).toHaveCount(1);
  await expect(copyButtons(foldedMessage)).toBeVisible();

  const expectedTarget = testInfo.project.name === "desktop" ? 30 : 40;
  for (const message of [finalMessage, inlineMessage, foldedMessage]) {
    await message.scrollIntoViewIfNeeded();
    const geometry = await message.evaluate((element) => {
      const header = element.querySelector(":scope > .task-assistant-message-header");
      const time = header.querySelector(":scope > time");
      const button = header.querySelector(
        "caffold-task-assistant-message-copy-button > button",
      );
      const icon = button.querySelector("svg");
      const body = element.querySelector(":scope > .task-assistant-message-body");
      const headerBox = header.getBoundingClientRect();
      const timeBox = time.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const center = (box) => box.top + box.height / 2;
      return {
        buttonSize: {
          height: Math.round(buttonBox.height),
          width: Math.round(buttonBox.width),
        },
        headerHeight: Math.round(headerBox.height),
        iconCenterDelta: Math.abs(center(iconBox) - center(headerBox)),
        iconFollowsTime: timeBox.width > 0 && iconBox.left > timeBox.right,
        iconInsideHeader:
          iconBox.top >= headerBox.top - 0.5 &&
          iconBox.bottom <= headerBox.bottom + 0.5,
        bodyBelowHeader: bodyBox.top >= headerBox.bottom - 0.5,
      };
    });
    expect(geometry.buttonSize).toEqual({
      height: expectedTarget,
      width: expectedTarget,
    });
    expect(geometry.headerHeight).toBeLessThan(expectedTarget);
    expect(geometry.iconInsideHeader).toBe(true);
    expect(geometry.iconCenterDelta).toBeLessThanOrEqual(1);
    expect(geometry.iconFollowsTime).toBe(true);
    expect(geometry.bodyBelowHeader).toBe(true);
  }

  await finalMessage.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, testInfo, "task-message-copy-header");
  expect(scenario.pageErrors).toEqual([]);
});

test("copies each message's Markdown source exactly with bounded success and retryable failure", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await seedMessageCopyTask(page, "thread_message_copy");
  const finalMessage = page.locator(
    'caffold-task-assistant-message[data-message-phase="final"]',
  );
  const finalCopy = finalMessage.locator('button[data-message-action="copy"]');
  const finalStatus = finalMessage.locator(".task-assistant-message-copy-status");
  const workDetails = page.locator("caffold-task-work-details");
  const foldedMessage = workDetails.locator(
    ".task-work-details-message > caffold-task-assistant-message",
  );
  const foldedCopy = foldedMessage.locator('button[data-message-action="copy"]');

  await page.clock.install();
  const pausedAt = await page.evaluate(() => Date.now() + 60_000);
  await page.clock.pauseAt(pausedAt);
  await expect(finalMessage.locator("h2")).toHaveText("Planner review");

  // Copying is clipboard-only; a request seen from here on would be its own.
  const requests = [];
  page.on("request", (request) => {
    if (["fetch", "xhr"].includes(request.resourceType())) {
      requests.push(request.url());
    }
  });
  await finalCopy.focus();
  await page.keyboard.press("Enter");
  await expect(finalCopy).toHaveAttribute("aria-label", "Copied");
  await expect(finalCopy).toHaveAttribute("data-copy-state", "copied");
  await expect(finalStatus).toHaveAttribute("role", "status");
  await expect(finalStatus).toHaveAttribute("aria-live", "polite");
  await expect(finalStatus).toHaveText("Copied");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(FINAL_RESPONSE);
  expect(
    await finalCopy.evaluate((button) => document.activeElement === button),
  ).toBe(true);
  expect(requests).toEqual([]);

  const summary = workDetails.locator(":scope > details > summary");
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await expect(foldedCopy).toBeVisible();
  await foldedMessage.scrollIntoViewIfNeeded();
  await activateActionHint(page, /Copy message$/);
  await expect(foldedCopy).toHaveAttribute("aria-label", "Copied");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(FOLDED_RESPONSE);
  await expect(finalCopy).toHaveAttribute("aria-label", "Copied");
  await page.clock.fastForward(1_799);
  await expect(finalCopy).toHaveAttribute("aria-label", "Copied");
  await expect(foldedCopy).toHaveAttribute("aria-label", "Copied");
  await page.clock.fastForward(1);
  await expect(finalCopy).toHaveAttribute("aria-label", "Copy message");
  await expect(foldedCopy).toHaveAttribute("aria-label", "Copy message");
  await expect(finalStatus).toBeEmpty();
  await expect(foldedMessage.locator(".task-assistant-message-copy-status")).toBeEmpty();

  await page.evaluate(() => {
    window.__messageCopyAttempts = [];
    window.__failNextMessageCopy = true;
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text) => {
        window.__messageCopyAttempts.push(text);
        if (window.__failNextMessageCopy) {
          window.__failNextMessageCopy = false;
          throw new Error("fixture clipboard failure");
        }
      },
    });
  });
  await finalCopy.click();
  await expect(finalCopy).toHaveAttribute(
    "aria-label",
    "Copy failed. Retry copy message",
  );
  await expect(finalCopy).toHaveAttribute("data-copy-state", "failed");
  await expect(finalStatus).toHaveText("Copy failed — retry");
  await expect(finalCopy).toBeEnabled();
  await finalCopy.click();
  await expect(finalCopy).toHaveAttribute("aria-label", "Copied");
  await expect
    .poll(() => page.evaluate(() => window.__messageCopyAttempts))
    .toEqual([FINAL_RESPONSE, FINAL_RESPONSE]);
  await page.clock.fastForward(1_800);
  await expect(finalCopy).toHaveAttribute("aria-label", "Copy message");
  await expect(finalStatus).toBeEmpty();
  expect(scenario.pageErrors).toEqual([]);
});

test("drops a copy of text the message no longer holds", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await seedMessageCopyTask(page, "thread_message_copy_stale");
  await page.evaluate(() => {
    let release;
    window.__pendingMessageCopy = new Promise((resolve) => {
      release = resolve;
    });
    window.__releaseMessageCopy = release;
    window.__messageCopyCalls = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text) => {
        window.__messageCopyCalls.push(text);
        await window.__pendingMessageCopy;
      },
    });
    const shell = document.createElement("div");
    shell.style.cssText = "position:fixed;left:-1000px;top:0;width:320px";
    const message = document.createElement("caffold-task-assistant-message");
    message.id = "standalone-message-probe";
    shell.append(message);
    document.body.append(shell);
    message.setSnapshot({ event: { payload: { text: "older text" } } });
  });
  const probe = page.locator("#standalone-message-probe");
  const copy = probe.locator('button[data-message-action="copy"]');
  const status = probe.locator(".task-assistant-message-copy-status");

  await expect(copy).toHaveAttribute("aria-label", "Copy message");
  // Without an observed time the header holds only Copy, at the same height.
  expect(
    await probe.evaluate((element) => {
      const header = element.querySelector(":scope > .task-assistant-message-header");
      const button = header.querySelector(
        "caffold-task-assistant-message-copy-button > button",
      );
      const headerBox = header.getBoundingClientRect();
      const iconBox = button.querySelector("svg").getBoundingClientRect();
      return {
        buttonHeight: Math.round(button.getBoundingClientRect().height),
        headerHeight: Math.round(headerBox.height),
        iconAtStart: Math.abs(iconBox.left - headerBox.left) <= 0.5,
        timeText: header.querySelector(":scope > time").textContent,
      };
    }),
  ).toEqual({
    buttonHeight: 30,
    headerHeight: 16,
    iconAtStart: true,
    timeText: "",
  });
  await copy.evaluate((button) => button.click());
  await expect(copy).toHaveAttribute("aria-label", "Copying message");
  await expect(copy).toHaveAttribute("aria-disabled", "true");
  await probe.evaluate((message) => {
    message.setSnapshot({ event: { payload: { text: "current text" } } });
  });
  await expect(copy).toHaveAttribute("aria-label", "Copy message");
  await expect(copy).toHaveAttribute("aria-disabled", "false");
  await page.evaluate(async () => {
    window.__releaseMessageCopy();
    await window.__pendingMessageCopy;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(copy).toHaveAttribute("aria-label", "Copy message");
  await expect(status).toBeEmpty();
  expect(await page.evaluate(() => window.__messageCopyCalls)).toEqual([
    "older text",
  ]);

  await copy.evaluate((button) => button.click());
  await expect(copy).toHaveAttribute("aria-label", "Copied");
  expect(await page.evaluate(() => window.__messageCopyCalls)).toEqual([
    "older text",
    "current text",
  ]);
  expect(scenario.pageErrors).toEqual([]);
});

async function seedMessageCopyTask(page, threadId, { activeTurn = false } = {}) {
  const scenario = await installTaskLoopFixture(page, {
    threadId,
    completedAssistantResponse: FINAL_RESPONSE,
  });
  await scenario.seedCompletedTask();

  if (activeTurn) {
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
      scenario.eventRecord(
        "turn_2_commentary",
        "assistant_message",
        "Interim output",
        {
          turnId: "turn_2",
          phase: "progress",
          text: INLINE_RESPONSE,
        },
        22,
      ),
    ];
    scenario.updateTask({
      ...canonicalTaskState("active", {
        turnId: "turn_2",
        latestTurnStatus: "inProgress",
      }),
      lastEventSummary: "Reasoning summary",
    });
  }

  // The fixture carries no observed times; the header draws one only when the
  // event does, and the layout under review is the time with Copy beside it.
  scenario.events = scenario.events.map((event) =>
    event.type === "assistant_message"
      ? { ...event, observedMs: event.position.anchorMs }
      : event
  );

  await page.goto("/tasks/" + scenario.threadId);
  await expect(
    page.locator(
      'caffold-task-assistant-message[data-message-phase="final"] caffold-task-markdown',
    ),
  ).toHaveAttribute("data-render-state", "markdown");
  return scenario;
}
