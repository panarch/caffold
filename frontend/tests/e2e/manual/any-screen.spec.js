import { expect, test } from "@playwright/test";
import { enterActionHints } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualRepository,
  installManualSettings,
  installManualTasks,
  MANUAL_TAILNET_URL,
  MANUAL_TASKS,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installManualDefaults(page);
  await installManualTasks(page);
  await installManualRepository(page);
  await installManualSettings(page);
});

test("F puts a code on every action", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
  await expect(page.locator("caffold-task-conversation")).toContainText(
    "Dark theme is ready to review",
  );

  const hints = await enterActionHints(page);
  await expect(hints.getByLabel(/ — Open Working Tree$/)).toBeVisible();
  await expect(hints.locator('[data-action-hint-code="P"]')).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "action-hints");
});

test("T opens the Task Switcher, most recently finished first", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
  await expect(page.locator("caffold-task-conversation")).toContainText(
    "Dark theme is ready to review",
  );

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("t");
  const dialog = page.locator("caffold-task-switcher-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".task-switcher-row-title").first()).toHaveText(
    MANUAL_TASKS.darkTheme.title,
  );
  await expect(
    dialog.locator("caffold-action-hint-dialog button[data-action-hint-code]").first(),
  ).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "task-switcher");
});

test("? lists the keyboard shortcuts", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);
  await expect(page.locator("caffold-task-conversation")).toContainText(
    "Dark theme is ready to review",
  );

  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("?");
  const help = page.locator("caffold-keyboard-shortcut-dialog > dialog:modal");
  await expect(help.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(help).toContainText("Select a scroll area");
  await expect(help).toContainText("Switch to a recently active task");
  await captureReviewScreenshot(page, testInfo, "keyboard-shortcuts");
});

test("Remote Access shows the private address and its QR code", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/settings/remote-access");

  const remoteAccess = page.locator("caffold-settings-remote-access-page");
  await expect(
    remoteAccess.getByRole("heading", { name: "Private access is ready" }),
  ).toBeVisible();
  await expect(remoteAccess.locator("[data-tailnet-address]")).toHaveText(MANUAL_TAILNET_URL);
  await expect(remoteAccess.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(remoteAccess.getByRole("link", { name: "Open link" })).toBeVisible();
  const qr = remoteAccess.locator("img[data-qr-code]");
  await expect.poll(() => qr.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await captureReviewScreenshot(page, testInfo, "settings-remote-access");
});

test("Voice Input chooses how speech becomes text", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/settings/voice");

  const voice = page.locator("caffold-settings-voice-page");
  await expect(page.getByRole("heading", { level: 1, name: "Voice Input" })).toBeVisible();
  await expect(voice.getByRole("radio", { name: /^Whisper/ })).toBeChecked();
  await expect(voice.getByRole("radio", { name: /^OpenAI/ })).toBeVisible();
  await expect(voice.getByRole("radio", { name: /^Gemini/ })).toBeVisible();
  await expect(voice.getByRole("radio", { name: /^Grok/ })).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "settings-voice-input");
});
