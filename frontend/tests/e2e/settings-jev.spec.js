import { expect, test } from "@playwright/test";
import { activateActionHint, workspaceTargets } from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { mockAgentModels } from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

async function installJevSettings(page, overrides = {}) {
  const state = {
    keyConfigured: false,
    criteria: "",
    lastCheck: null,
    ...overrides,
  };
  const requests = [];
  const settings = () => ({
    model: "jev-1.13.0",
    keyConfigured: state.keyConfigured,
    criteria: state.criteria,
    lastCheck: state.lastCheck,
  });
  await page.route("**/api/jev/settings", (route) =>
    route.fulfill({ json: settings() }),
  );
  await page.route("**/api/jev/criteria", (route) => {
    const body = route.request().postDataJSON();
    requests.push(["criteria", body]);
    state.criteria = body.criteria;
    return route.fulfill({ json: settings() });
  });
  await page.route("**/api/jev/key", (route) => {
    const request = route.request();
    requests.push([
      request.method(),
      request.method() === "PUT" ? request.postDataJSON() : null,
    ]);
    state.keyConfigured = request.method() === "PUT";
    state.lastCheck = state.keyConfigured
      ? { ok: true, message: null, model: "jev-1.13.0" }
      : null;
    return route.fulfill({ json: settings() });
  });
  return { state, requests };
}

function detailValue(page, key) {
  return page.locator(
    `caffold-settings-detail-list [data-key="${key}"] dd`,
  );
}

test("saves rules and a key, and never shows the key again", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { requests } = await installJevSettings(page);

  await page.goto("/settings/jev");
  const jevPage = page.locator("caffold-settings-jev-page");
  await expect(
    page.getByRole("heading", { level: 1, name: "Jev Permissions" }),
  ).toBeVisible();
  await expect(detailValue(jevPage, "model")).toHaveText("jev-1.13.0");
  await expect(detailValue(jevPage, "api-key")).toHaveText("Not saved");
  await expect(detailValue(jevPage, "check")).toHaveText("No key to check");

  await jevPage.getByLabel("Extra rules").fill("Reading inside the worktree is allowed.");
  await jevPage.getByRole("button", { name: "Save extra rules" }).click();
  await expect(jevPage.getByLabel("Extra rules")).toHaveValue(
    "Reading inside the worktree is allowed.",
  );

  await jevPage.getByLabel("API key", { exact: true }).fill("ts-e2e-secret");
  await jevPage.getByRole("button", { name: "Save key" }).click();
  await expect(detailValue(jevPage, "api-key")).toHaveText("Saved");
  await expect(detailValue(jevPage, "check")).toHaveText("Answered by jev-1.13.0");
  const replacement = jevPage.getByLabel("Replace API key");
  await expect(replacement).toHaveValue("");
  await expect(jevPage).not.toContainText("ts-e2e");

  await jevPage.getByRole("button", { name: "Remove key" }).click();
  await expect(detailValue(jevPage, "api-key")).toHaveText("Not saved");
  await expect(
    jevPage.getByRole("button", { name: "Remove key" }),
  ).toBeHidden();
  expect(requests).toEqual([
    ["criteria", { criteria: "Reading inside the worktree is allowed." }],
    ["PUT", { key: "ts-e2e-secret" }],
    ["DELETE", null],
  ]);
});

test("Action Hints focus the rules and key fields, and Escape leaves them", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installJevSettings(page, { keyConfigured: true });

  await page.goto("/settings/jev");
  const jevPage = page.locator("caffold-settings-jev-page");
  await expect(detailValue(jevPage, "api-key")).toHaveText("Saved");
  const rules = jevPage.getByLabel("Extra rules");
  await expect(rules).toBeEnabled();

  await activateActionHint(page, /Focus Extra rules$/);
  await expect(rules).toBeFocused();
  await page.keyboard.type("Allow reads.");
  await expect(rules).toHaveValue("Allow reads.");
  await page.keyboard.press("Escape");
  const pane = page.locator(".settings-workspace-detail-pane");
  await expect(pane).toBeFocused();
  expect(await pane.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(pane).toHaveCSS("outline-style", "none");
  await expect(rules).toHaveValue("Allow reads.");

  await activateActionHint(page, /Focus Replace API key$/);
  await expect(jevPage.getByLabel("Replace API key")).toBeFocused();
});

test("a key that did not work says so instead of looking configured", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installJevSettings(page, {
    keyConfigured: true,
    criteria: "Allow reads.",
    lastCheck: {
      ok: false,
      message: "TypeSafe rejected the API key.",
      model: null,
    },
  });

  await page.goto("/settings/jev");
  const jevPage = page.locator("caffold-settings-jev-page");

  await expect(detailValue(jevPage, "api-key")).toHaveText("Saved");
  await expect(detailValue(jevPage, "check")).toHaveText(
    "TypeSafe rejected the API key.",
  );
});

test("rules the server refuses are reported without losing what was typed", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installJevSettings(page);
  await page.route("**/api/jev/criteria", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: "jev_criteria_too_long",
          message: "The rules are too long.",
        },
      },
    }),
  );

  await page.goto("/settings/jev");
  const jevPage = page.locator("caffold-settings-jev-page");
  const rules = jevPage.getByLabel("Extra rules");
  await rules.fill("Far too much judgement.");
  await jevPage.getByRole("button", { name: "Save extra rules" }).click();

  await expect(jevPage.locator(".settings-jev-message")).toHaveText(
    "The rules are too long.",
  );
  await expect(rules).toHaveValue("Far too much judgement.");
  await expect(jevPage.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("unreadable settings offer a retry instead of an empty page", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/jev/settings", (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: "jev_settings_unavailable",
            message: "Caffold could not read its Jev settings.",
          },
        },
      });
    }
    return route.fulfill({
      json: {
        model: "jev-1.13.0",
        keyConfigured: false,
        criteria: "Allow reads.",
            lastCheck: null,
      },
    });
  });

  await page.goto("/settings/jev");
  const jevPage = page.locator("caffold-settings-jev-page");
  const retry = jevPage.getByRole("button", { name: "Retry" });
  await expect(jevPage.locator(".settings-jev-message")).toHaveText(
    "Caffold could not read its Jev settings.",
  );
  await expect(retry).toBeVisible();

  await retry.click();

  await expect(retry).toBeHidden();
  await expect(jevPage.getByLabel("Extra rules")).toHaveValue("Allow reads.");
});

test("the page holds its own width on a phone", { tag: "@phone" }, async ({
  page,
}) => {
  await installJevSettings(page, {
    keyConfigured: true,
    criteria: "A fairly long rule that a person wrote about what an agent may do.",
    lastCheck: { ok: true, message: null, model: "jev-1.13.0" },
  });

  await page.goto("/settings/jev");
  const jevPage = page.locator("caffold-settings-jev-page");
  await expect(detailValue(jevPage, "model")).toHaveText("jev-1.13.0");

  const overflow = await jevPage
    .locator(".settings-content-scroll")
    .evaluate((scrollport) => scrollport.scrollWidth - scrollport.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("offers the rules and key controls it shows as Action Hints", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installJevSettings(page, { keyConfigured: true });

  await page.goto("/settings/jev");
  await expect(page.locator("caffold-settings-jev-page").getByLabel("Replace API key")).toBeVisible();

  await expect.poll(() => workspaceTargets(page, "settings:jev:")).toEqual([
    ["criteria", "Focus Extra rules"],
    ["save-criteria", "Save the extra rules"],
    ["key", "Focus Replace API key"],
    ["save-key", "Save the Jev API key"],
    ["remove-key", "Remove the Jev API key"],
  ]);
});
