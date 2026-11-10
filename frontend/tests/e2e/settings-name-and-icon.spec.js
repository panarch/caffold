import { expect, test } from "@playwright/test";
import { activateActionHint, workspaceTargets } from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { mockAgentModels } from "./support/task-fixtures.js";

const ICONS = [
  ["default", "Default"],
  ["red", "Red"],
  ["orange", "Orange"],
  ["gold", "Gold"],
  ["lime", "Lime"],
  ["green", "Green"],
  ["teal", "Teal"],
  ["sky", "Sky"],
  ["blue", "Blue"],
  ["violet", "Violet"],
  ["purple", "Purple"],
  ["pink", "Pink"],
].map(([id, label]) => ({ id, label }));

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

// Health is answered from the server's own answer, which a handler may still be
// reading when a test ends.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

// Every browser test shares one server, so its name and icon are answered here
// instead of changed there. Health carries the same answer, as the server's
// does. The icon pictures still come from the server.
async function installServerSettings(page, { refuse = null, hold = null } = {}) {
  const state = { name: "Caffold", icon: "default" };
  const sent = [];
  const settings = () => ({ ...state, icons: ICONS });
  await page.route("**/api/server/settings", async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") {
      return route.fulfill({ json: settings() });
    }
    const changes = request.postDataJSON();
    sent.push(changes);
    await hold?.promise;
    if (refuse) {
      return route.fulfill({ status: 400, json: { error: refuse } });
    }
    Object.assign(state, changes);
    return route.fulfill({ json: settings() });
  });
  await page.route(/\/api\/health(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    return route.fulfill({
      response,
      json: { ...health, serverName: state.name, serverIcon: state.icon },
    });
  });
  return { state, sent };
}

function iconChoices(page) {
  return page
    .locator("caffold-settings-name-and-icon-page")
    .getByRole("group", { name: "Icon" })
    .getByRole("radio");
}

test("names this host and picks its icon, and this window shows both", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { sent } = await installServerSettings(page);

  await page.goto("/settings/name-and-icon");
  const settingsPage = page.locator("caffold-settings-name-and-icon-page");
  await expect(
    page.getByRole("heading", { level: 1, name: "Name & Icon" }),
  ).toBeVisible();
  await expect(iconChoices(page)).toHaveCount(12);
  expect(
    await iconChoices(page).evaluateAll((choices) =>
      choices.map((choice) => choice.getAttribute("aria-label")),
    ),
  ).toEqual(ICONS.map(({ label }) => label));
  await expect(settingsPage.getByRole("radio", { name: "Default" })).toBeChecked();
  await expect(
    settingsPage.locator('label:has(input[value="teal"]) img'),
  ).toHaveAttribute("src", "/icons/teal/icon-192.png");
  await expect(settingsPage.locator('label:has(input[value="teal"])')).toHaveAttribute(
    "title",
    "Teal",
  );

  await settingsPage.locator('label:has(input[value="blue"])').click();
  await expect(settingsPage.getByRole("radio", { name: "Blue" })).toBeChecked();
  await expect(settingsPage.getByRole("radio", { name: "Default" })).not.toBeChecked();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/icons/blue/favicon-32.png",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/blue/apple-touch-icon.png",
  );
  await expect(
    page.locator("caffold-settings-navigator caffold-workspace-brand .workspace-brand-icon"),
  ).toHaveAttribute("src", "/icons/blue/favicon-32.png");
  await expect(page).toHaveTitle("Caffold");

  const name = settingsPage.getByLabel("Name", { exact: true });
  const save = settingsPage.getByRole("button", { name: "Save", exact: true });
  await expect(name).toHaveValue("Caffold");
  await expect(save).toBeDisabled();
  for (const unchanged of ["   ", " Caffold "]) {
    await name.fill(unchanged);
    await expect(save).toBeDisabled();
  }
  await name.fill("Caffold Linux");
  await save.click();
  await expect(page).toHaveTitle("Caffold Linux");
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    "content",
    "Caffold Linux",
  );
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute(
    "content",
    "Caffold Linux",
  );
  await expect(save).toBeDisabled();

  await name.fill("Caffold Studio");
  await name.press("Enter");
  await expect(page).toHaveTitle("Caffold Studio");
  await expect(name).toHaveValue("Caffold Studio");
  expect(sent).toEqual([
    { icon: "blue" },
    { name: "Caffold Linux" },
    { name: "Caffold Studio" },
  ]);

  await page.getByRole("button", { name: "About Caffold" }).click();
  await expect(
    page.locator("caffold-settings-about-page .settings-about-heading img"),
  ).toHaveAttribute("src", "/icons/blue/caffold.png");
  await expect(page).toHaveTitle("Caffold Studio");
});

test("a name the server refuses is reported and stays as typed", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installServerSettings(page, {
    refuse: {
      code: "invalid_server_name",
      message: "server name cannot exceed 64 characters",
    },
  });

  await page.goto("/settings/name-and-icon");
  const settingsPage = page.locator("caffold-settings-name-and-icon-page");
  const name = settingsPage.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue("Caffold");
  const typed = "x".repeat(65);
  await name.fill(typed);
  await settingsPage.getByRole("button", { name: "Save", exact: true }).click();

  await expect(settingsPage.getByRole("alert")).toHaveText(
    "server name cannot exceed 64 characters",
  );
  await expect(name).toHaveValue(typed);
  await expect(name).toBeEnabled();
  await expect(settingsPage.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(page).toHaveTitle("Caffold");
});

test("every control waits while a change is being saved", { tag: "@server-changes" }, async ({
  page,
}) => {
  let release = () => {};
  const hold = { promise: new Promise((resolve) => { release = resolve; }) };
  const { sent } = await installServerSettings(page, { hold });

  await page.goto("/settings/name-and-icon");
  const settingsPage = page.locator("caffold-settings-name-and-icon-page");
  const name = settingsPage.getByLabel("Name", { exact: true });
  await expect(name).toBeEnabled();
  await name.fill("Caffold Linux");

  await settingsPage.locator('label:has(input[value="red"])').click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(name).toBeDisabled();
  await expect(settingsPage.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  for (const choice of await iconChoices(page).all()) {
    await expect(choice).toBeDisabled();
  }
  await expect(settingsPage.locator(".settings-content-section")).toHaveAttribute(
    "aria-busy",
    "true",
  );

  release();
  await expect(settingsPage.getByRole("radio", { name: "Red" })).toBeChecked();
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue("Caffold Linux");
  await expect(settingsPage.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(sent).toEqual([{ icon: "red" }]);
});

test("settings that could not be read offer a retry", { tag: "@server-changes" }, async ({
  page,
}) => {
  await installServerSettings(page);
  let failures = 1;
  await page.route("**/api/server/settings", (route) => {
    if (failures > 0) {
      failures -= 1;
      return route.fulfill({
        status: 500,
        json: { error: { code: "internal", message: "Caffold could not read its settings." } },
      });
    }
    return route.fallback();
  });

  await page.goto("/settings/name-and-icon");
  const settingsPage = page.locator("caffold-settings-name-and-icon-page");
  await expect(settingsPage.getByRole("alert")).toHaveText(
    "Caffold could not read its settings.",
  );
  await expect(settingsPage.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(iconChoices(page)).toHaveCount(0);

  await settingsPage.getByRole("button", { name: "Retry" }).click();
  await expect(iconChoices(page)).toHaveCount(12);
  await expect(settingsPage.getByLabel("Name", { exact: true })).toHaveValue("Caffold");
  await expect(settingsPage.getByRole("alert")).toBeHidden();
  await expect(settingsPage.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("keeps twelve touchable icons in six columns and the name inside the page", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServerSettings(page);

  await page.goto("/settings/name-and-icon");
  const settingsPage = page.locator("caffold-settings-name-and-icon-page");
  await expect(iconChoices(page)).toHaveCount(12);
  await settingsPage.getByLabel("Name", { exact: true }).fill("W".repeat(64));

  const boxes = await settingsPage
    .locator(".settings-icon-choices label")
    .evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().toJSON()));
  const rows = [...new Set(boxes.map((box) => Math.round(box.top)))];
  const columns = [...new Set(boxes.map((box) => Math.round(box.left)))];
  expect(rows).toHaveLength(2);
  expect(columns).toHaveLength(6);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
  }

  const save = await settingsPage
    .getByRole("button", { name: "Save", exact: true })
    .evaluate((button) => button.getBoundingClientRect().toJSON());
  const name = await settingsPage
    .getByLabel("Name", { exact: true })
    .evaluate((input) => input.getBoundingClientRect().toJSON());
  expect(Math.round(save.top)).toBe(Math.round(name.top));
  const overflow = await settingsPage
    .locator(".settings-content-scroll")
    .evaluate((scrollport) => ({
      width: scrollport.scrollWidth - scrollport.clientWidth,
      right: scrollport.getBoundingClientRect().right,
    }));
  expect(overflow.width).toBeLessThanOrEqual(0);
  expect(save.right).toBeLessThanOrEqual(overflow.right);
});

test("offers the name, Save, and every other icon as Action Hints", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { sent } = await installServerSettings(page);

  await page.goto("/settings/name-and-icon");
  const settingsPage = page.locator("caffold-settings-name-and-icon-page");
  await expect(iconChoices(page)).toHaveCount(12);

  await expect.poll(() => workspaceTargets(page, "settings:name-and-icon:")).toEqual([
    ["name", "Focus Name"],
    ...ICONS.slice(1).map(({ id, label }) => [`icon:${id}`, `Use the ${label} icon`]),
  ]);

  await activateActionHint(page, /Focus Name$/);
  const name = settingsPage.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Caffold Linux");
  await page.keyboard.press("Escape");
  await expect.poll(() => workspaceTargets(page, "settings:name-and-icon:")).toContainEqual([
    "save-name",
    "Save the name",
  ]);

  await activateActionHint(page, /Use the Violet icon$/);
  await expect(settingsPage.getByRole("radio", { name: "Violet" })).toBeChecked();
  expect(sent).toEqual([{ icon: "violet" }]);
});
