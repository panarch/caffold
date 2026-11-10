import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualAntigravity,
  installManualNotifications,
  installManualServerName,
  installManualSettings,
  MANUAL_JEV_RULES,
  MANUAL_SERVER_NAME,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

for (const theme of ["light", "dark"]) {
  test.describe(`${theme} manual screenshots`, () => {
    test.beforeEach(async ({ page }) => {
      await installBrowserDefaults(page);
      await installManualDefaults(page, theme);
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
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-codex-${theme}`);
    });

    test("Appearance sets the theme, typefaces, and text sizes", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await page.goto("/settings/appearance");

      const appearance = page.locator("caffold-settings-appearance-page");
      await expect(appearance.getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })).toBeChecked();
      await expect(appearance).toContainText("Interface");
      await expect(appearance).toContainText("Code");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-appearance-${theme}`);
    });

    test("Jev Permissions keeps a saved key and extra rules", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await page.goto("/settings/jev");

      const jev = page.locator("caffold-settings-jev-page");
      await expect(page.getByRole("heading", { level: 1, name: "Jev Permissions" })).toBeVisible();
      await expect(
        jev.locator('caffold-settings-detail-list [data-key="api-key"] dd'),
      ).toHaveText("Saved");
      await expect(jev.getByLabel("Extra rules")).toHaveValue(MANUAL_JEV_RULES);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-jev-${theme}`);
    });

    test("Name & Icon names the host and picks its icon", { tag: "@desktop" }, async ({ page }, testInfo) => {
      await installManualServerName(page);
      await page.goto("/settings/name-and-icon");

      const nameAndIcon = page.locator("caffold-settings-name-and-icon-page");
      await expect(nameAndIcon.getByLabel("Name", { exact: true })).toHaveValue(MANUAL_SERVER_NAME);
      await expect(nameAndIcon.getByRole("radio")).toHaveCount(12);
      await expect(nameAndIcon.getByRole("radio", { name: "Default" })).not.toBeChecked();
      await expect(nameAndIcon.getByRole("radio", { name: "Blue" })).toBeChecked();
      await expect(
        page.locator("caffold-settings-navigator caffold-workspace-brand .workspace-brand-icon"),
      ).toHaveAttribute("src", "/icons/blue/favicon-32.png");
      await expect.poll(() =>
        page.locator("caffold-settings-navigator caffold-workspace-brand img, caffold-settings-name-and-icon-page img")
          .evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)),
      ).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-name-and-icon-${theme}`);
      await page.unrouteAll({ behavior: "wait" });
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
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-notifications-${theme}`);
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
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-antigravity-${theme}`);
      await owner.locator("caffold-settings-runtime").scrollIntoViewIfNeeded();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await captureReviewScreenshot(page, testInfo, `settings-antigravity-runtime-${theme}`);
    });
  });
}
