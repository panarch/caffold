import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { activateActionHint } from "./support/action-hints.js";

test("Copilot settings show the signed-in account, available models and a fresh sign-in check", { tag: "@all-viewports" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let authenticated = true;
  await page.route("**/api/copilot/status", route => route.fulfill({ json: {
    installation: { state: "ready", version: "1.0.114" },
    protocolVersion: 4,
    authenticated,
    login: authenticated ? "octocat" : null,
    models: authenticated ? [{ model: "mai-code-2", displayName: "MAI Code 2" }] : [],
    error: authenticated ? null : "Sign in to GitHub with copilot login.",
  }}));
  await page.goto("/settings/copilot");
  const settings = page.locator("caffold-settings-copilot-page");
  await expect(settings).toBeVisible();
  for (const text of ["octocat", "MAI Code 2", "1.0.114"]) await expect(settings).toContainText(text);
  authenticated = false;
  await activateActionHint(page, "Refresh");
  await expect(settings).toContainText("Signed out");
  await expect(settings.getByRole("status")).toContainText("copilot login");
  await expect(settings).not.toContainText("octocat");
});
