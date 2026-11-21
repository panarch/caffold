import { expect, test } from "@playwright/test";
import { activateActionHint, workspaceTargets } from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { mockAgentModels } from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

function unsaved() {
  return { keyConfigured: false, lastCheck: null };
}

async function installDecisionModelSettings(page, overrides = {}) {
  const state = {
    selected: "jev",
    criteria: "",
    jev: unsaved(),
    openai: unsaved(),
    ...overrides,
  };
  const requests = [];
  const settings = () => structuredClone(state);
  await page.route("**/api/decision-model/settings", (route) =>
    route.fulfill({ json: settings() }),
  );
  await page.route("**/api/decision-model/provider", (route) => {
    const body = route.request().postDataJSON();
    requests.push(["provider", body]);
    state.selected = body.provider;
    return route.fulfill({ json: settings() });
  });
  await page.route("**/api/decision-model/criteria", (route) => {
    const body = route.request().postDataJSON();
    requests.push(["criteria", body]);
    state.criteria = body.criteria;
    return route.fulfill({ json: settings() });
  });
  await page.route("**/api/decision-model/keys/*", (route) => {
    const request = route.request();
    const provider = new URL(request.url()).pathname.split("/").at(-1);
    const saved = request.method() === "PUT";
    requests.push([request.method(), provider, saved ? request.postDataJSON() : null]);
    state[provider] = {
      keyConfigured: saved,
      lastCheck: saved ? { ok: true, message: null } : null,
    };
    return route.fulfill({ json: settings() });
  });
  return { state, requests };
}

function settingsPage(page) {
  return page.locator("caffold-settings-decision-model-page");
}

function providerSection(page, provider) {
  return settingsPage(page).locator(`section[data-provider="${provider}"]`);
}

function detailValue(scope, key) {
  return scope.locator(`caffold-settings-detail-list [data-key="${key}"] dd`);
}

test("chooses a model, keeps a key for each, and never shows a key again", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { requests } = await installDecisionModelSettings(page);

  await page.goto("/settings/decision-model");
  const decisionModel = settingsPage(page);
  const jev = providerSection(page, "jev");
  const openai = providerSection(page, "openai");
  await expect(
    page.getByRole("heading", { level: 1, name: "Decision Model" }),
  ).toBeVisible();
  await expect(
    decisionModel.getByRole("radio", { name: /Jev/ }),
  ).toBeChecked();
  for (const section of [jev, openai]) {
    await expect(detailValue(section, "api-key")).toHaveText("Not saved");
    await expect(detailValue(section, "check")).toHaveText("No key to check");
  }
  await expect(decisionModel.locator('[data-key="model"]')).toHaveCount(0);

  await decisionModel.getByRole("radio", { name: /OpenAI/ }).click();
  await expect(decisionModel.getByRole("radio", { name: /OpenAI/ })).toBeChecked();

  await openai.getByLabel("API key", { exact: true }).fill("sk-e2e-secret");
  await openai.getByRole("button", { name: "Save key" }).click();
  await expect(detailValue(openai, "api-key")).toHaveText("Saved");
  await expect(detailValue(openai, "check")).toHaveText("Answered by OpenAI");
  await expect(openai.getByLabel("Replace API key")).toHaveValue("");
  await expect(detailValue(jev, "api-key")).toHaveText("Not saved");

  await jev.getByLabel("API key", { exact: true }).fill("ts-e2e-secret");
  await jev.getByRole("button", { name: "Save key" }).click();
  await expect(detailValue(jev, "check")).toHaveText("Answered by Jev");
  await expect(decisionModel).not.toContainText("e2e-secret");

  await openai.getByRole("button", { name: "Remove key" }).click();
  await expect(detailValue(openai, "api-key")).toHaveText("Not saved");
  await expect(openai.getByRole("button", { name: "Remove key" })).toBeHidden();
  await expect(detailValue(jev, "api-key")).toHaveText("Saved");

  await decisionModel.getByLabel("Extra rules").fill("Reading inside the worktree is allowed.");
  await decisionModel.getByRole("button", { name: "Save extra rules" }).click();
  await expect(decisionModel.getByLabel("Extra rules")).toHaveValue(
    "Reading inside the worktree is allowed.",
  );
  expect(requests).toEqual([
    ["provider", { provider: "openai" }],
    ["PUT", "openai", { key: "sk-e2e-secret" }],
    ["PUT", "jev", { key: "ts-e2e-secret" }],
    ["DELETE", "openai", null],
    ["criteria", { criteria: "Reading inside the worktree is allowed." }],
  ]);
});

test("the extra rules come after every model's section", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installDecisionModelSettings(page);

  await page.goto("/settings/decision-model");
  const rules = settingsPage(page).getByLabel("Extra rules");
  await expect(rules).toBeVisible();

  const order = await settingsPage(page)
    .locator(".settings-content-section")
    .evaluate((section) =>
      Array.from(
        section.querySelectorAll(
          ".settings-decision-model-options, section[data-provider], .settings-decision-model-criteria",
        ),
        (element) => element.dataset.provider ?? element.className,
      ),
    );
  expect(order).toEqual([
    "settings-decision-model-options",
    "jev",
    "openai",
    "settings-decision-model-criteria",
  ]);
});

test("Action Hints focus the rules and key fields, and Escape leaves them", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installDecisionModelSettings(page, {
    jev: { keyConfigured: true, lastCheck: null },
  });

  await page.goto("/settings/decision-model");
  const rules = settingsPage(page).getByLabel("Extra rules");
  await expect(rules).toBeEnabled();
  // The rules sit below every model's section, so they are scrolled to first.
  await rules.scrollIntoViewIfNeeded();

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

  const openaiKey = providerSection(page, "openai").getByLabel("API key", { exact: true });
  await openaiKey.scrollIntoViewIfNeeded();
  await activateActionHint(page, /Focus OpenAI API key$/);
  await expect(openaiKey).toBeFocused();
});

test("a key that did not work says so instead of looking configured", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installDecisionModelSettings(page, {
    selected: "openai",
    openai: {
      keyConfigured: true,
      lastCheck: { ok: false, message: "OpenAI rejected the API key." },
    },
  });

  await page.goto("/settings/decision-model");
  const openai = providerSection(page, "openai");

  await expect(detailValue(openai, "api-key")).toHaveText("Saved");
  await expect(detailValue(openai, "check")).toHaveText("OpenAI rejected the API key.");
  await expect(detailValue(providerSection(page, "jev"), "check")).toHaveText(
    "No key to check",
  );
});

test("rules the server refuses are reported without losing what was typed", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installDecisionModelSettings(page);
  await page.route("**/api/decision-model/criteria", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: "decision_model_criteria_too_long",
          message: "The rules are too long.",
        },
      },
    }),
  );

  await page.goto("/settings/decision-model");
  const decisionModel = settingsPage(page);
  const rules = decisionModel.getByLabel("Extra rules");
  await rules.fill("Far too much judgement.");
  await decisionModel.getByRole("button", { name: "Save extra rules" }).click();

  await expect(decisionModel.locator(".settings-decision-model-message")).toHaveText(
    "The rules are too long.",
  );
  await expect(rules).toHaveValue("Far too much judgement.");
  await expect(decisionModel.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("unreadable settings offer a retry instead of an empty page", { tag: "@server-changes" }, async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/decision-model/settings", (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: "decision_model_settings_unavailable",
            message: "Caffold could not read its decision model settings.",
          },
        },
      });
    }
    return route.fulfill({
      json: {
        selected: "jev",
        criteria: "Allow reads.",
        jev: unsaved(),
        openai: unsaved(),
      },
    });
  });

  await page.goto("/settings/decision-model");
  const decisionModel = settingsPage(page);
  const retry = decisionModel.getByRole("button", { name: "Retry" });
  await expect(decisionModel.locator(".settings-decision-model-message")).toHaveText(
    "Caffold could not read its decision model settings.",
  );
  await expect(retry).toBeVisible();

  await retry.click();

  await expect(retry).toBeHidden();
  await expect(decisionModel.getByLabel("Extra rules")).toHaveValue("Allow reads.");
});

test("the page holds its own width on a phone", { tag: "@phone" }, async ({
  page,
}) => {
  await installDecisionModelSettings(page, {
    criteria: "A fairly long rule that a person wrote about what an agent may do.",
    jev: { keyConfigured: true, lastCheck: { ok: true, message: null } },
  });

  await page.goto("/settings/decision-model");
  await expect(detailValue(providerSection(page, "jev"), "check")).toHaveText(
    "Answered by Jev",
  );

  const overflow = await settingsPage(page)
    .locator(".settings-content-scroll")
    .evaluate((scrollport) => scrollport.scrollWidth - scrollport.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("offers the choice, key, and rules controls it shows as Action Hints", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installDecisionModelSettings(page, {
    jev: { keyConfigured: true, lastCheck: null },
  });

  await page.goto("/settings/decision-model");
  await expect(
    providerSection(page, "jev").getByLabel("Replace API key"),
  ).toBeVisible();

  await expect.poll(() => workspaceTargets(page, "settings:decision-model:")).toEqual([
    ["provider:openai", "Use OpenAI for permission decisions"],
    ["key:jev", "Focus Jev API key"],
    ["save-key:jev", "Save the Jev API key"],
    ["remove-key:jev", "Remove the Jev API key"],
    ["key:openai", "Focus OpenAI API key"],
    ["save-key:openai", "Save the OpenAI API key"],
    ["criteria", "Focus Extra rules"],
    ["save-criteria", "Save the extra rules"],
  ]);
});
