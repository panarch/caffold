import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualAntigravity,
  installManualNotifications,
  installManualSettings,
  MANUAL_JEV_RULES,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installManualDefaults(page);
  await installManualSettings(page);
});

test("Codex Settings shows usage and reset credits", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/settings/codex");

  const codex = page.locator("caffold-settings-codex-page");
  await expect(codex.locator('[data-key="runtime-version"] dt')).toHaveText("App-server version");
  await expect(codex.locator('[data-key="cli-version"] dt')).toHaveText("CLI version");
  await expect(codex.getByRole("heading", { name: "CLI and diagnostics" })).toBeVisible();
  await expect(codex.locator("[data-codex-usage] dt")).toHaveText(["5 hours", "1 week"]);
  const credits = codex.locator(".settings-codex-reset-credits");
  await expect(credits.locator("[data-reset-credit-count]")).toHaveText("2 available");
  await expect(credits.getByRole("button", { name: "Use this reset" })).toHaveCount(2);
  await captureReviewScreenshot(page, testInfo, "settings-codex");
});

test("Appearance sets the theme, typefaces, and text sizes", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/settings/appearance");

  const appearance = page.locator("caffold-settings-appearance-page");
  await expect(appearance.getByRole("radio", { name: "Light" })).toBeChecked();
  await expect(appearance).toContainText("Interface");
  await expect(appearance).toContainText("Code");
  await captureReviewScreenshot(page, testInfo, "settings-appearance");
});

test("Jev Permissions keeps a saved key and extra rules", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/settings/jev");

  const jev = page.locator("caffold-settings-jev-page");
  await expect(page.getByRole("heading", { level: 1, name: "Jev Permissions" })).toBeVisible();
  await expect(
    jev.locator('caffold-settings-detail-list [data-key="api-key"] dd'),
  ).toHaveText("Saved");
  await expect(jev.getByLabel("Extra rules")).toHaveValue(MANUAL_JEV_RULES);
  await captureReviewScreenshot(page, testInfo, "settings-jev");
});

test("Notifications lists every subscribed browser", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await installManualNotifications(page);
  await page.goto("/settings/notifications");

  const notifications = page.locator("caffold-settings-notifications-page");
  await expect(notifications.locator(".settings-notification-status")).toHaveAttribute(
    "data-state",
    "subscribed",
  );
  await expect(notifications.getByRole("button", { name: "Disable" })).toBeVisible();
  await expect(notifications).toContainText("Chrome on Android · phone");
  await captureReviewScreenshot(page, testInfo, "settings-notifications");
});

test("Antigravity Settings shows the installed CLI and shared account",{tag:"@desktop"},async({page},testInfo)=>{
  await installManualAntigravity(page);
  await page.goto("/settings/antigravity");
  const owner=page.locator("caffold-settings-antigravity-page");
  await expect(owner).toContainText("1.5.1");
  await expect(owner).toContainText("/Users/alex/.local/bin/agy");
  await expect(owner.getByRole("button",{name:"Sign in",exact:true})).toHaveCount(0);
  await expect(owner).toContainText("Google AI Pro");
  await expect(owner).toContainText("Signed in");
  await expect(owner.getByRole("button",{name:"Refresh",exact:true})).toBeEnabled();
  await expect(owner).toContainText("9% used · resets");
  await expect(owner.getByRole("link", {name: "Service status"})).toHaveAttribute("href", "https://aistudio.google.com/status");
  await expect(owner).toContainText("Running · pid 4301");
  await expect(owner.getByRole("button", {name: "Restart runtime", exact: true})).toBeEnabled();
  await captureReviewScreenshot(page,testInfo,"settings-antigravity");
  await owner.locator("caffold-settings-runtime").scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page,testInfo,"settings-antigravity-runtime");
});
