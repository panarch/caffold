import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  activateActionHintIntoPopover,
  popoverActionHintDialog,
} from "../support/action-hints.js";
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

/** A Task whose turns run under the mode that keeps what its prompts settle. */
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

test("a Task's kept permission instructions are read and forgotten from its details", { tag: "@server-steady" }, async ({
  page,
}) => {
  let instructions = "[2026-09-21 03:14 UTC]\ntarget 밑은 지워도 돼";
  const requests = [];
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  const detail = reviewedTaskDetail();
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/permission-instructions", (route) => {
    const method = route.request().method();
    requests.push(method);
    if (method === "DELETE") {
      instructions = null;
    }
    return route.fulfill({ json: { instructions } });
  });
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);

  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const settled = summary.locator('[data-task-info-action="permission-instructions"]');
  await expect(settled).toBeVisible();
  await expect(settled.locator(".task-detail-action-label")).toHaveText(
    "What your prompts settled",
  );
  // What the Lucide stub in browser-defaults draws for ShieldCheck.
  await expect(settled.locator('svg path[d="m9 12 2 2 4-4"]')).toHaveCount(1);

  await settled.click();
  const dialog = page.locator("caffold-task-permission-instructions-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".task-permission-instructions-text")).toContainText(
    "target 밑은 지워도 돼",
  );
  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  await expect(
    hint.getByRole("button", { name: / — Close what this Task settled$/ }),
  ).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Forget what this Task settled$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Forget these" }).click();

  await expect(dialog.locator(".task-permission-instructions-text")).toContainText(
    "Nothing yet.",
  );
  await expect(dialog.getByRole("button", { name: "Forget these" })).toBeDisabled();
  // The details read nothing to decide what to offer, so the record is asked
  // for once: when the person opens it.
  expect(requests).toEqual(["GET", "DELETE"]);
});

test("offers what the prompts settled to Action Hints as the details open", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  const detail = reviewedTaskDetail();
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  // The Composer answers which mode the next turn runs under, so the details
  // offer the record once that list has settled.
  await expect(
    page
      .locator("caffold-task-composer")
      .getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Caffold decides");

  await activateActionHintIntoPopover(page, /Task details, idle$/);

  await expect(
    popoverActionHintDialog(page).getByRole("button", {
      name: / — What your prompts settled$/,
    }),
  ).toBeVisible();
});

test("a Task under another approval mode offers nothing to read", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  const detail = taskDetailFixture();
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  // The mode this Task would send has settled, so nothing is still on its way
  // that could offer the record.
  await expect(
    page
      .locator("caffold-task-composer")
      .getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Auto review");

  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();

  await expect(summary.locator(".task-detail-popover")).toBeVisible();
  await expect(
    summary.locator('[data-task-info-action="permission-instructions"]'),
  ).toHaveCount(0);
});
