import { expect, test } from "@playwright/test";
import { installTaskApiFixture, taskDetailFixture } from "../support/task-api-fixture.js";
import { captureReviewScreenshot, emitTaskDetailBootstrap } from "../support/task-fixtures.js";

test("browses providers without changing the selected model or requesting its permissions", { tag: "@desktop" }, async ({ page }) => {
  const requests = await installCatalog(page);
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator(".task-new-form");
  const picker = form.locator("caffold-task-turn-options");
  const menu = picker.locator(".task-model-popover");
  const trigger = picker.locator(".task-model-button");
  await expect(form.locator(".task-permission-button")).toContainText("Auto review");
  const initialRequests = requests.length;
  await trigger.click();
  await menu.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(menu.locator('[data-model="shared"]')).toContainText("Claude Shared");
  await expect(menu.locator('[data-model][aria-pressed="true"]')).toHaveCount(0);
  await expect(menu.locator(".task-model-settings")).toBeEmpty();
  expect(await picker.evaluate((element) => element.submissionOptions())).toMatchObject({
    provider: "codex", model: "shared", effort: "xhigh", fastMode: false,
  });
  expect(requests).toHaveLength(initialRequests);

  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu.getByRole("button", { name: "Codex", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(menu.locator('[data-model="shared"]')).toBeFocused();
});

test("chooses a model before exposing only that model's settings", { tag: "@desktop" }, async ({ page }) => {
  const requests = await installCatalog(page);
  await page.goto("/tasks/new?cwd=src");
  const picker = page.locator(".task-new-form caffold-task-turn-options");
  const menu = picker.locator(".task-model-popover");
  const trigger = picker.locator(".task-model-button");
  await trigger.click();
  await menu.locator('[data-fast-mode="true"]').click();
  await trigger.click();
  await menu.getByRole("button", { name: "Claude", exact: true }).click();
  await menu.locator('[data-model="shared"]').click();
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-model][aria-pressed="true"]')).toHaveCount(1);
  await expect(menu.locator(".task-model-settings")).not.toContainText("Claude Shared");
  await expect(menu.locator('[data-effort="high"]')).toHaveAttribute("aria-pressed", "true");
  await expect(menu.locator('[data-effort="xhigh"]')).toHaveAttribute("aria-pressed", "false");
  await expect(menu.locator('[data-fast-mode="false"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => requests.at(-1)).toEqual({ provider: "claude", model: "shared" });

  await menu.getByRole("button", { name: "gemini", exact: true }).click();
  await menu.locator('[data-model="budget-model"]').click();
  await expect(menu.locator('[data-effort]')).toHaveCount(2);
  await expect(menu.locator('[data-effort="adaptive"]')).toHaveAttribute("aria-pressed", "true");
  await expect(menu.locator('[data-fast-mode]')).toHaveCount(0);
  expect(await picker.evaluate((element) => element.submissionOptions())).toMatchObject({
    provider: "gemini", model: "budget-model", effort: "adaptive", fastMode: false,
  });

  await menu.getByRole("button", { name: "grok", exact: true }).click();
  await menu.locator('[data-model="plain-model"]').click();
  await expect(menu.locator(".task-model-settings")).toBeEmpty();
  const options = await picker.evaluate((element) => element.submissionOptions());
  expect(options).toMatchObject({ provider: "grok", model: "plain-model", fastMode: false });
  expect(options).not.toHaveProperty("effort");
});

test("retains two readable columns and model-specific controls at each viewport", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await installCatalog(page, visualCatalog());
  await page.goto("/tasks/new?cwd=src");
  const menu = page.locator(".task-new-form .task-model-popover");
  await page.locator(".task-new-form .task-model-button").click();
  await expect(menu).toBeVisible();
  const layout = await menu.evaluate((element) => {
    const left = element.querySelector(".task-provider-options").getBoundingClientRect();
    const right = element.querySelector(".task-provider-models").getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      separated: left.right <= right.left,
      aligned: Math.abs(left.top - right.top) < 1,
      widerModels: right.width > left.width,
      contained: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
  expect(layout).toEqual({ separated: true, aligned: true, widerModels: true, contained: true, overflow: false });
  const reasoning = menu.getByRole("region", { name: "Reasoning level", exact: true });
  const cells = await reasoning.locator("[data-effort]").evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width } = element.getBoundingClientRect();
      return { x, y, width };
    })
  );
  const firstColumn = cells.filter((cell) => Math.abs(cell.x - cells[0].x) < 1);
  expect(cells[1].x).toBeGreaterThan(cells[0].x);
  expect(firstColumn.length).toBeGreaterThan(1);
  expect(firstColumn[1].y).toBeGreaterThan(firstColumn[0].y);
  expect(Math.max(...cells.map((cell) => cell.width)) - Math.min(...cells.map((cell) => cell.width))).toBeLessThan(1);
  await expect(menu.locator(".task-model-settings")).not.toContainText("GPT-6-Astra");
  await captureReviewScreenshot(page, testInfo, "model-picker-columns");
  await menu.getByRole("button", { name: "grok", exact: true }).click();
  await menu.locator('[data-model="plain-model"]').click();
  await expect(menu.locator(".task-model-settings")).toBeEmpty();
  await captureReviewScreenshot(page, testInfo, "model-picker-short");
});

test("keeps long names readable and selection stable while scrolling a long model list", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const longName = "Model-with-an-unusually-long-unbroken-name-for-inspection";
  const models = Array.from({ length: 22 }, (_, index) => ({
    ...catalog()[0], model: `long-${index}`, displayName: `${longName}-${index}`, isDefault: index === 0,
  }));
  models.push({ ...catalog()[3], provider: "provider-with-an-unusually-long-name" });
  await installCatalog(page, models);
  await page.goto("/tasks/new?cwd=src");
  const picker = page.locator(".task-new-form caffold-task-turn-options");
  const menu = picker.locator(".task-model-popover");
  await picker.locator(".task-model-button").click();
  await expect(menu).toBeVisible();
  await menu.locator('[data-model="long-21"]').click();
  await expect(menu.locator('[data-model="long-21"]')).toHaveAttribute("aria-pressed", "true");
  const before = await menu.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  const after = await picker.evaluate((element) => {
    const popover = element.modelPopover();
    const providers = popover.querySelector(".task-provider-options");
    const selected = popover.querySelector('[data-model][aria-pressed="true"]');
    element.render();
    return {
      scroll: popover.scrollTop,
      retainedProvider: providers === popover.querySelector(".task-provider-options"),
      retainedModel: selected === popover.querySelector('[data-model][aria-pressed="true"]'),
      overflow: [...popover.querySelectorAll("button, strong")].some((node) => node.scrollWidth > node.clientWidth + 1),
      outerOverflow: popover.scrollWidth > popover.clientWidth,
    };
  });
  expect(after).toEqual({ scroll: before, retainedProvider: true, retainedModel: true, overflow: false, outerOverflow: false });
  await captureReviewScreenshot(page, testInfo, "model-picker-long");
});

test("fits a narrow phone with enlarged Interface text", { tag: "@phone" }, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    localStorage.setItem("caffold:settings", JSON.stringify({ interfaceScalePercent: 120 }));
  });
  await installCatalog(page);
  await page.goto("/tasks/new?cwd=src");
  const menu = page.locator(".task-new-form .task-model-popover");
  await page.locator(".task-new-form .task-model-button").click();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => ({
    contained: element.getBoundingClientRect().right <= innerWidth,
    overflow: element.scrollWidth > element.clientWidth,
    labelsClipped: [...element.querySelectorAll("button strong")].some((node) => node.scrollWidth > node.clientWidth + 1),
  }))).toEqual({ contained: true, overflow: false, labelsClipped: false });
  await captureReviewScreenshot(page, testInfo, "model-picker-narrow-large");
});

test("offers only the existing Task's provider", { tag: "@desktop" }, async ({ page }) => {
  await installCatalog(page);
  const detail = taskDetailFixture({ model: "shared", reasoningEffort: "xhigh" });
  await page.route("**/api/tasks/thread-1", (route) => route.fulfill({ json: detail }));
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const picker = page.locator(".task-follow-up-form caffold-task-turn-options");
  await picker.locator(".task-model-button").click();
  await expect(picker.locator(".task-provider-option")).toHaveCount(1);
  await expect(picker.locator(".task-provider-option")).toHaveText("Codex");
  await expect(picker.locator('[data-model="shared"]')).toContainText("Codex Shared");
});

// Additional agents are API fixtures; this frontend change does not add drivers.
function catalog() {
  return [
    { provider: "codex", model: "shared", displayName: "Codex Shared", isDefault: true, defaultEffort: "xhigh", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], supportsFastMode: true },
    { provider: "claude", model: "shared", displayName: "Claude Shared", defaultEffort: "high", efforts: ["high", "xhigh"], supportsFastMode: true },
    { provider: "gemini", model: "budget-model", displayName: "Adaptive Model", defaultEffort: "adaptive", efforts: ["adaptive", "budgeted"], supportsFastMode: false },
    { provider: "grok", model: "plain-model", displayName: "Plain Model", efforts: [], supportsFastMode: false },
  ];
}

function visualCatalog() {
  const models = catalog();
  models[0].displayName = "GPT-6-Astra";
  models.splice(1, 0, ...[
    "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna", "GPT-5.5", "GPT-5.3-Codex-Spark",
  ].map((displayName) => ({ ...models[0], model: displayName, displayName, isDefault: false })));
  return models;
}

async function installCatalog(page, models = catalog()) {
  await installTaskApiFixture(page);
  await page.unroute("**/api/agent/models");
  await page.route("**/api/agent/models", (route) => route.fulfill({ json: { models, unavailable: [] } }));
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/agent/permissions") {
      requests.push({ provider: url.searchParams.get("provider"), model: url.searchParams.get("model") });
    }
  });
  return requests;
}
