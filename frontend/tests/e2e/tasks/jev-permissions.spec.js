import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./../support/browser-defaults.js";
import {
  TASK_PERMISSION_FIXTURE,
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import { emitTaskDetailBootstrap } from "../support/task-fixtures.js";

const REVIEWED_MODE = "caffold:ask-jev-first";
const WITHHELD_REASON = "Add a Jev API key in Settings → Jev Permissions.";

function reviewedOption(allowed) {
  return {
    mode: REVIEWED_MODE,
    label: "Ask Jev first",
    description:
      "Asks about everything. Jev answers what an automatic mode would run on its own, plus whatever your extra rules cover.",
    allowed,
    ...(allowed ? {} : { unavailableReason: WITHHELD_REASON }),
    dangerous: false,
  };
}

/** The list Codex answers, with Caffold's own mode among the safe ones. */
function permissionsOffering(allowed) {
  const options = [...TASK_PERMISSION_FIXTURE.options];
  const dangerous = options.findIndex((option) => option.dangerous);
  options.splice(dangerous, 0, reviewedOption(allowed));
  return { ...TASK_PERMISSION_FIXTURE, options };
}

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("the reviewed mode is offered and withheld with its reason until Jev is set up", { tag: "@desktop" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(false) });
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');

  await form.getByRole("button", { name: "Choose approval mode" }).click();
  const option = page.locator(
    `.task-permission-option[data-permission-mode="${REVIEWED_MODE}"]`,
  );

  await expect(option).toBeVisible();
  await expect(option).toBeDisabled();
  await expect(option).toContainText("Ask Jev first");
  await expect(option).toContainText(WITHHELD_REASON);
  // It keeps the modes that give up a protection last.
  await expect(
    page.locator(".task-permission-option").last(),
  ).toHaveAttribute("data-permission-mode", "fullAccess");
});

test("the reviewed mode can be chosen once Jev is set up", { tag: "@desktop" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });

  await picker.click();
  const option = page.locator(
    `.task-permission-option[data-permission-mode="${REVIEWED_MODE}"]`,
  );
  await expect(option).toBeEnabled();
  await expect(option).not.toContainText(WITHHELD_REASON);

  await option.click();

  await expect(picker).toContainText("Ask Jev first");
});

test("saving Jev settings offers the mode without reloading the page", { tag: "@desktop" }, async ({
  page,
}) => {
  let available = false;
  await installTaskApiFixture(page);
  await page.unroute("**/api/agent/permissions*");
  await page.route("**/api/agent/permissions*", (route) =>
    route.fulfill({ json: permissionsOffering(available) }),
  );
  await page.route("**/api/jev/settings", (route) =>
    route.fulfill({
      json: {
        model: "jev-1.13.0",
        keyConfigured: available,
        criteria: "",
        lastCheck: null,
      },
    }),
  );
  await page.route("**/api/jev/key", (route) => {
    available = true;
    return route.fulfill({
      json: {
        model: "jev-1.13.0",
        keyConfigured: true,
        criteria: "Allow reads.",
        lastCheck: { ok: true, message: null, model: "jev-1.13.0" },
      },
    });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  const option = page.locator(
    `.task-permission-option[data-permission-mode="${REVIEWED_MODE}"]`,
  );
  await picker.click();
  await expect(option).toBeDisabled();
  await page.keyboard.press("Escape");

  // The composer stays mounted while Settings is open, so nothing reloads it.
  await page.locator('button[data-workspace-mode="settings"]').click();
  await page
    .locator('caffold-settings-navigator button[data-settings-section="jev"]')
    .click();
  const jevPage = page.locator("caffold-settings-jev-page");
  await jevPage.getByLabel("API key", { exact: true }).fill("ts-e2e-secret");
  await jevPage.getByRole("button", { name: "Save key" }).click();
  await expect(jevPage.getByRole("button", { name: "Remove key" })).toBeVisible();

  await page.locator('button[data-workspace-mode="tasks"]').click();

  await picker.click();
  await expect(option).toBeEnabled();
  await option.click();
  await expect(picker).toContainText("Ask Jev first");
});

test("a Task's kept permission instructions are read and forgotten from its details", { tag: "@desktop" }, async ({
  page,
}) => {
  let instructions = "[2026-09-21 03:14 UTC]\ntarget 밑은 지워도 돼";
  const requests = [];
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  const detail = taskDetailFixture();
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
  const action = summary.locator("[data-task-info-permission-instructions]");
  await expect(action).toBeVisible();

  await action.getByRole("button", { name: "What your prompts permitted" }).click();
  const dialog = page.locator("caffold-task-permission-instructions-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".task-permission-instructions-text")).toContainText(
    "target 밑은 지워도 돼",
  );

  await dialog.getByRole("button", { name: "Forget these" }).click();

  await expect(dialog.locator(".task-permission-instructions-text")).toContainText(
    "Nothing yet.",
  );
  await expect(dialog.getByRole("button", { name: "Forget these" })).toBeDisabled();
  expect(requests).toEqual(["GET", "GET", "DELETE"]);
});

test("a Task with nothing kept offers nothing to read", { tag: "@desktop" }, async ({
  page,
}) => {
  await installTaskApiFixture(page, { permissions: permissionsOffering(true) });
  const detail = taskDetailFixture();
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/permission-instructions", (route) =>
    route.fulfill({ json: { instructions: null } }),
  );
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);

  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();

  await expect(summary.locator(".task-detail-popover")).toBeVisible();
  await expect(
    summary.locator("[data-task-info-permission-instructions]"),
  ).toBeHidden();
});
