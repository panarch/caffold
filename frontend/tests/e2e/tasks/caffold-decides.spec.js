import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./../support/browser-defaults.js";
import {
  TASK_PERMISSION_FIXTURE,
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import { emitTaskDetailBootstrap } from "../support/task-fixtures.js";

const REVIEWED_MODE = "caffold:decides";
const WITHHELD_REASON = "Add a key in Settings → Decision Model.";

function reviewedOption(allowed, reviewer) {
  return {
    mode: REVIEWED_MODE,
    label: "Caffold decides",
    description: `Asks about everything. ${reviewer} allows the routine ones.`,
    allowed,
    ...(allowed ? {} : { unavailableReason: WITHHELD_REASON }),
    dangerous: false,
  };
}

/** The list Codex answers, with Caffold's own mode among the safe ones. */
function permissionsOffering(allowed, reviewer = "Jev") {
  const options = [...TASK_PERMISSION_FIXTURE.options];
  const dangerous = options.findIndex((option) => option.dangerous);
  options.splice(dangerous, 0, reviewedOption(allowed, reviewer));
  return { ...TASK_PERMISSION_FIXTURE, options };
}

/** A Task whose turns run under Caffold decides. */
function reviewedTaskDetail() {
  return { ...taskDetailFixture(), permissionMode: REVIEWED_MODE };
}

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("the reviewed mode is offered and withheld with its reason until the chosen model has a key", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(false) });
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');

  await form.getByRole("button", { name: "Choose approval mode" }).click();
  const option = form.locator(
    `.task-permission-option[data-permission-mode="${REVIEWED_MODE}"]`,
  );

  await expect(option).toBeVisible();
  await expect(option).toBeDisabled();
  await expect(option).toContainText("Caffold decides");
  await expect(option).toContainText("Jev allows the routine ones.");
  await expect(option).toContainText(WITHHELD_REASON);
  // It keeps the modes that give up a protection last.
  await expect(
    form.locator(".task-permission-option").last(),
  ).toHaveAttribute("data-permission-mode", "fullAccess");
});

test("the reviewed mode can be chosen once the chosen model has a key", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });

  await picker.click();
  const option = form.locator(
    `.task-permission-option[data-permission-mode="${REVIEWED_MODE}"]`,
  );
  await expect(option).toBeEnabled();
  await expect(option).not.toContainText(WITHHELD_REASON);

  await option.click();

  await expect(picker).toContainText("Caffold decides");
});

test("choosing a model and saving its key in Settings offers the mode under that model without reloading the page", { tag: "@server-steady" }, async ({
  page,
}) => {
  const state = {
    selected: "jev",
    criteria: "",
    jev: { keyConfigured: false, lastCheck: null },
    openai: { keyConfigured: false, lastCheck: null },
  };
  const reviewer = () => (state.selected === "openai" ? "OpenAI" : "Jev");
  await installTaskApiFixture(page);
  await page.unroute("**/api/agent/permissions*");
  await page.route("**/api/agent/permissions*", (route) =>
    route.fulfill({
      json: permissionsOffering(state[state.selected].keyConfigured, reviewer()),
    }),
  );
  await page.route("**/api/decision-model/settings", (route) =>
    route.fulfill({ json: structuredClone(state) }),
  );
  await page.route("**/api/decision-model/provider", (route) => {
    state.selected = route.request().postDataJSON().provider;
    return route.fulfill({ json: structuredClone(state) });
  });
  await page.route("**/api/decision-model/keys/openai", (route) => {
    state.openai = { keyConfigured: true, lastCheck: { ok: true, message: null } };
    return route.fulfill({ json: structuredClone(state) });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  const option = form.locator(
    `.task-permission-option[data-permission-mode="${REVIEWED_MODE}"]`,
  );
  await picker.click();
  await expect(option).toBeDisabled();
  await expect(option).toContainText("Jev allows the routine ones.");
  await page.keyboard.press("Escape");

  // The composer stays mounted while Settings is open, so nothing reloads it.
  await page.locator('button[data-workspace-mode="settings"]').click();
  await page
    .locator('caffold-settings-navigator button[data-settings-section="decision-model"]')
    .click();
  const decisionModel = page.locator("caffold-settings-decision-model-page");
  await expect(decisionModel.getByRole("radio", { name: /Jev/ })).toBeChecked();
  await decisionModel.getByRole("radio", { name: /OpenAI/ }).click();
  await expect(decisionModel.getByRole("radio", { name: /OpenAI/ })).toBeChecked();
  const openai = decisionModel.locator('section[data-provider="openai"]');
  await openai.getByLabel("API key", { exact: true }).fill("sk-e2e-secret");
  await openai.getByRole("button", { name: "Save key" }).click();
  await expect(openai.getByRole("button", { name: "Remove key" })).toBeVisible();

  await page.locator('button[data-workspace-mode="tasks"]').click();

  await picker.click();
  await expect(option).toBeEnabled();
  await expect(option).toContainText("OpenAI allows the routine ones.");
  await option.click();
  await expect(picker).toContainText("Caffold decides");
});

test("a Task under Caffold decides keeps no record to read from its details", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  const detail = reviewedTaskDetail();
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  // The mode this Task would send has settled, so nothing is still on its way
  // that could change what the details offer.
  await expect(
    page
      .locator("caffold-task-composer")
      .getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Caffold decides");

  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();

  await expect(summary.locator(".task-detail-popover")).toBeVisible();
  await expect(summary.locator(".task-detail-popover")).toContainText("Fork task");
  await expect(summary.getByText("What your prompts settled")).toHaveCount(0);
});
