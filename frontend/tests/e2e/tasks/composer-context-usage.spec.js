import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
} from "../support/task-fixtures.js";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const COUNTED = { usedTokens: 32_147, windowTokens: 200_000 };

test("sits just left of the microphone, the microphone's size", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { form } = await openTask(page);
  const pie = form.locator(".task-context-usage-button");
  await expect(pie).toBeVisible();
  await expect(pie).toHaveAccessibleName("Context usage: 16%");

  const layout = await form.evaluate((element) => {
    const box = (selector) =>
      element.querySelector(selector).getBoundingClientRect();
    const pie = box(".task-context-usage-button");
    const microphone = box(".task-voice-button");
    const send = box(".task-primary-action-button");
    const permission = box(".task-permission-button");
    const middle = (rect) => rect.top + rect.height / 2;
    return {
      pieToMicrophone: microphone.left - pie.right,
      microphoneToSend: send.left - microphone.right,
      width: pie.width - microphone.width,
      height: pie.height - microphone.height,
      middle: Math.abs(middle(pie) - middle(microphone)),
      clearOfPermission: pie.left >= permission.right,
    };
  });
  expect(layout.pieToMicrophone).toBeCloseTo(layout.microphoneToSend, 1);
  expect(layout).toEqual(
    expect.objectContaining({ width: 0, height: 0, clearOfPermission: true }),
  );
  expect(layout.middle).toBeLessThan(0.5);
  await captureReviewScreenshot(page, testInfo, "tasks-composer-context-usage");
});

test("opens the agent's numbers above the pie in the Task details form", { tag: ["@desktop", "@phone"] }, async ({
  page,
}, testInfo) => {
  const { form } = await openTask(page);
  const popover = form.locator(".task-context-usage-popover");

  await form.locator(".task-context-usage-button").click();

  await expect(popover).toBeVisible();
  await expect(popover.locator("dt")).toHaveText(["Used", "Window"]);
  await expect(popover.locator("dd")).toHaveText([
    "32,147 tokens (16%)",
    "200,000 tokens",
  ]);
  await captureReviewScreenshot(page, testInfo, "tasks-composer-context-usage-open");
  const opened = await form.evaluate((element) => {
    const pie = element
      .querySelector(".task-context-usage-button")
      .getBoundingClientRect();
    const panel = element
      .querySelector(".task-composer-panel")
      .getBoundingClientRect();
    const popover = element.querySelector(".task-context-usage-popover");
    const box = popover.getBoundingClientRect();
    return {
      phone: window.innerWidth <= 520,
      abovePie: box.bottom <= pie.top,
      rightEdgeToPie: Math.abs(box.right - pie.right),
      aboveComposer: panel.top - box.bottom,
      left: box.left,
      right: window.innerWidth - box.right,
      form: popoverForm(popover),
    };

    function popoverForm(node) {
      const style = getComputedStyle(node);
      const term = getComputedStyle(node.querySelector("dt"));
      const value = getComputedStyle(node.querySelector("dd"));
      return {
        border: style.borderTopWidth,
        borderColor: style.borderTopColor,
        radius: style.borderTopLeftRadius,
        padding: style.padding,
        background: style.backgroundColor,
        shadow: style.boxShadow,
        termSize: term.fontSize,
        termColor: term.color,
        valueSize: value.fontSize,
      };
    }
  });

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await page.locator("caffold-task-detail-info .task-detail-info-button").click();
  const reference = await page.evaluate(() => {
    const header = document
      .querySelector("caffold-task-detail-info")
      .closest(".detail-layout-summary")
      .getBoundingClientRect();
    const popover = document.querySelector(".task-detail-popover");
    const box = popover.getBoundingClientRect();
    const style = getComputedStyle(popover);
    const term = getComputedStyle(popover.querySelector("dt"));
    const value = getComputedStyle(popover.querySelector("dd"));
    return {
      belowHeader: box.top - header.bottom,
      left: box.left,
      right: window.innerWidth - box.right,
      form: {
        border: style.borderTopWidth,
        borderColor: style.borderTopColor,
        radius: style.borderTopLeftRadius,
        padding: style.padding,
        background: style.backgroundColor,
        shadow: style.boxShadow,
        termSize: term.fontSize,
        termColor: term.color,
        valueSize: value.fontSize,
      },
    };
  });

  expect(opened.form).toEqual(reference.form);
  if (opened.phone) {
    expect(opened.left).toBeCloseTo(reference.left, 1);
    expect(opened.right).toBeCloseTo(reference.right, 1);
    expect(opened.aboveComposer).toBeCloseTo(reference.belowHeader, 1);
  } else {
    expect(opened.abovePie).toBe(true);
    expect(opened.rightEdgeToPie).toBeLessThan(1);
  }
});

test("opens from Action Hints like the Composer's other buttons", { tag: "@desktop" }, async ({
  page,
}) => {
  const { form } = await openTask(page);

  await activateActionHint(page, /Context usage: 16%$/);

  await expect(form.locator(".task-context-usage-popover")).toBeVisible();
});

test("takes a new count while its numbers are open", { tag: "@desktop" }, async ({
  page,
}) => {
  const { detail, form } = await openTask(page);
  const pie = form.locator(".task-context-usage-button");
  const popover = form.locator(".task-context-usage-popover");
  await pie.click();
  await expect(popover).toBeVisible();

  await page.evaluate((next) => {
    window.__caffoldTaskSse.source(next.threadId).emit("task-sync", {
      threadId: next.threadId,
      revision: next.revision,
      detail: next,
      reason: "app-server-notification",
    });
  }, { ...detail, revision: detail.revision + 1, context: { usedTokens: 50_000, windowTokens: 200_000 } });

  await expect(pie).toHaveAccessibleName("Context usage: 25%");
  await expect(popover.locator("dd").first()).toHaveText("50,000 tokens (25%)");
  await expect(popover).toBeVisible();
});

test("says so when the agent has not counted yet", { tag: "@desktop" }, async ({
  page,
}) => {
  const { form } = await openTask(page, null);
  const pie = form.locator(".task-context-usage-button");
  await expect(pie).toHaveAccessibleName("Context usage: not reported yet");

  await pie.click();

  await expect(form.locator(".task-context-usage-popover")).toHaveText(
    "Not reported yet.",
  );
});

test("has no pie before a Task has a conversation", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${scenario.contextPath}`);
  const form = page.locator(
    'caffold-task-new caffold-task-composer form[data-task-form="create"]',
  );
  await expect(form.locator(".task-voice-button")).toBeVisible();

  await expect(form.locator("caffold-task-context-usage")).toBeHidden();
});

test("steps aside while recording on a phone", { tag: "@phone" }, async ({
  page,
}) => {
  const { form } = await openTask(page);
  const pie = form.locator("caffold-task-context-usage");
  await expect(pie).toBeVisible();

  await form.getByRole("button", { name: "Start voice input" }).click();

  await expect(form).toHaveAttribute("data-voice-state", "recording");
  await expect(pie).toBeHidden();
  await expect(form.locator(".task-composer-attach-button")).toBeHidden();
  await form.getByRole("button", { name: "Cancel voice input" }).click();
  await expect(form).toHaveAttribute("data-voice-state", "idle");
  await expect(pie).toBeVisible();
});

async function openTask(page, context = COUNTED) {
  await installTaskApiFixture(page);
  await page.route("**/api/voice/status", (route) =>
    route.fulfill({
      json: { provider: "whisper", ready: true, maxRecordingSeconds: 300 },
    }),
  );
  const detail = { ...taskDetailFixture(), context };
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const form = page.locator(
    'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden]) form[data-task-form="follow-up"]',
  );
  await expect(form).toBeVisible();
  return { detail, form };
}
