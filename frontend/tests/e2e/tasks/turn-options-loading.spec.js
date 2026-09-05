import { expect, test } from "@playwright/test";
import {
  TASK_PERMISSION_FIXTURE,
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  AGENT_MODELS_FIXTURE,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
} from "../support/task-fixtures.js";

// A closed picker shows a spinner only for a list still pending after this
// long; a quicker list is never seen loading.
const LOADING_DELAY_MS = 180;
const INSTALLED_AT = new Date("2026-01-01T00:00:00Z");
const PAUSED_AT = new Date("2026-01-01T00:01:00Z");

test("a model list that arrives before the delay is never seen loading", { tag: "@desktop" }, async ({
  page,
}) => {
  const { models } = await installGatedTurnOptions(page);
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const { modelButton, spinner } = pickerLocators(form);
  await expect(modelButton).toHaveAttribute("aria-busy", "true");
  await expect(spinner).toHaveCount(1);
  await expect(spinner).toBeHidden();
  await expect(modelButton.locator(".task-model-name")).toHaveCount(0);

  models.resolve();
  await expect(modelButton).toContainText("5.6 Sol");
  await expect(modelButton).toContainText("low");
  await expect(modelButton).not.toHaveAttribute("aria-busy");

  await page.clock.runFor(LOADING_DELAY_MS);
  await expect(spinner).toHaveCount(0);
  await expect(modelButton).not.toHaveAttribute("aria-busy");
  await expect
    .poll(() => turnOptionsState(form))
    .toEqual(
      expect.objectContaining({
        modelLoaded: true,
        modelFeedback: { timer: null, visible: false },
      }),
    );
});

test("a model list still pending after the delay earns a spinner without moving anything", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { models } = await installGatedTurnOptions(page);
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const { modelButton, spinner, permissionPicker, permissionButton, send } =
    pickerLocators(form);
  await expect(spinner).toHaveCount(1);
  await expect(spinner).toBeHidden();
  await expect(modelButton).toHaveAccessibleDescription("Loading models");
  await expect(permissionPicker).toHaveAttribute("hidden", "");
  await expect(permissionPicker).toBeHidden();
  const deferred = {
    model: await modelButton.boundingBox(),
    send: await send.boundingBox(),
  };

  await page.clock.runFor(LOADING_DELAY_MS - 1);
  await expect(spinner).toBeHidden();
  await page.clock.runFor(1);
  await expect(spinner).toBeVisible();
  await expect(modelButton).toHaveAttribute("aria-busy", "true");
  await expect(modelButton).toHaveAttribute("aria-label", "Choose model");
  await expect(modelButton.locator(".task-model-name")).toHaveCount(0);
  await expect(permissionPicker).toBeHidden();
  expect(await modelButton.boundingBox()).toEqual(deferred.model);
  await captureReviewScreenshot(page, testInfo, "turn-options-model-loading");

  models.resolve();
  await expect(modelButton).toContainText("5.6 Sol");
  await expect(modelButton).toContainText("low");
  await expect(spinner).toHaveCount(0);
  await expect(modelButton).not.toHaveAttribute("aria-busy");
  await expect(modelButton).toHaveAttribute(
    "aria-label",
    "Choose model, reasoning, and speed",
  );
  await expect(permissionPicker).toBeVisible();
  await expect(permissionButton).toContainText("Auto review");
  await captureReviewScreenshot(page, testInfo, "turn-options-model-loaded");
  const settled = {
    model: await modelButton.boundingBox(),
    send: await send.boundingBox(),
  };
  expect(settled.model.x).toBe(deferred.model.x);
  expect(settled.model.height).toBe(deferred.model.height);
  expect(settled.model.width).toBeGreaterThan(deferred.model.width);
  expect(settled.send).toEqual(deferred.send);
});

test("a first follow-up composer keeps its model spinner while the permission list lands first", { tag: "@desktop" }, async ({
  page,
}) => {
  const { models, permissions } = await installGatedTurnOptions(page, {
    gatePermissions: true,
  });
  const detail = await installFollowUpTask(page);
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const form = followUpForm(page);
  const { modelButton, spinner, permissionPicker, permissionButton } =
    pickerLocators(form);
  await expect(spinner).toHaveCount(1);
  await expect(permissionPicker).toBeHidden();
  await page.clock.runFor(LOADING_DELAY_MS);
  await expect(spinner).toBeVisible();
  const turning = await spinner.elementHandle();

  permissions.resolve();
  await expect
    .poll(() => turnOptionsState(form))
    .toEqual(
      expect.objectContaining({ modelLoaded: false, permissionLoaded: true }),
    );
  await expect(permissionPicker).toBeHidden();
  expect(
    await spinner.evaluate((node, previous) => node === previous, turning),
  ).toBe(true);
  await expect(spinner).toBeVisible();

  models.resolve();
  await expect(modelButton).toContainText("5.6 Sol");
  await expect(modelButton).toContainText("low");
  await expect(spinner).toHaveCount(0);
  await expect(permissionPicker).toBeVisible();
  await expect(permissionButton).toContainText("Auto review");
});

test("a first follow-up permission pill appears where it will stay, already turning", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { models, permissions } = await installGatedTurnOptions(page, {
    gatePermissions: true,
  });
  const detail = await installFollowUpTask(page);
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const form = followUpForm(page);
  const {
    modelButton,
    permissionPicker,
    permissionButton,
    permissionSpinner,
    send,
  } = pickerLocators(form);
  await expect(permissionPicker).toBeHidden();
  // The permission list has been pending as long as the model list. When the
  // model lands and asks for the list again, that wait carries over.
  await page.clock.runFor(LOADING_DELAY_MS);

  models.resolve();
  await expect(modelButton).toContainText("5.6 Sol");
  await expect(permissionPicker).toBeVisible();
  await expect(permissionSpinner).toBeVisible();
  await expect(permissionButton).not.toHaveClass(/is-deferred/);
  await expect(permissionButton).toHaveAttribute("aria-busy", "true");
  await expect(permissionButton).toHaveAccessibleDescription(
    "Loading permission modes",
  );
  const appeared = {
    model: await modelButton.boundingBox(),
    permission: await permissionButton.boundingBox(),
    send: await send.boundingBox(),
  };
  await captureReviewScreenshot(
    page,
    testInfo,
    "turn-options-permission-loading",
  );

  permissions.resolve();
  await expect(permissionButton).toContainText("Auto review");
  await expect(permissionSpinner).toHaveCount(0);
  await expect(permissionButton).not.toHaveAttribute("aria-busy");
  const settled = {
    model: await modelButton.boundingBox(),
    permission: await permissionButton.boundingBox(),
    send: await send.boundingBox(),
  };
  expect(settled.model).toEqual(appeared.model);
  expect(settled.permission.x).toBe(appeared.permission.x);
  expect(settled.permission.height).toBe(appeared.permission.height);
  expect(settled.send).toEqual(appeared.send);
});

// The clock is paused before navigation so that the delay is measured from a
// request that starts while the composer mounts; pausing later would let the
// real clock pass the threshold first.
async function installGatedTurnOptions(page, { gatePermissions = false } = {}) {
  await page.clock.install({ time: INSTALLED_AT });
  await page.clock.pauseAt(PAUSED_AT);
  await installTaskApiFixture(page);
  const models = Promise.withResolvers();
  await page.unroute("**/api/agent/models");
  await page.route("**/api/agent/models", async (route) => {
    await models.promise;
    return route.fulfill({ json: AGENT_MODELS_FIXTURE });
  });
  const permissions = Promise.withResolvers();
  if (gatePermissions) {
    await page.unroute("**/api/agent/permissions*");
    await page.route("**/api/agent/permissions*", async (route) => {
      await permissions.promise;
      return route.fulfill({ json: TASK_PERMISSION_FIXTURE });
    });
  }
  return { models, permissions };
}

async function installFollowUpTask(page) {
  const detail = taskDetailFixture({
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  });
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" }),
  );
  return detail;
}

function followUpForm(page) {
  return page.locator(
    'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden]) .task-follow-up-form[data-task-form="follow-up"]',
  );
}

function pickerLocators(form) {
  const modelButton = form.getByRole("button", { name: /Choose model/ });
  const permissionButton = form.getByRole("button", {
    name: "Choose approval mode",
  });
  return {
    modelButton,
    spinner: modelButton.locator(".task-picker-spinner"),
    permissionPicker: form.locator(".task-permission-picker"),
    permissionButton,
    permissionSpinner: permissionButton.locator(".task-picker-spinner"),
    send: form.locator(".task-primary-action-button"),
  };
}

function turnOptionsState(form) {
  return form.evaluate((element) => {
    const turnOptions = element.querySelector("caffold-task-turn-options");
    return {
      modelLoaded: turnOptions.modelLoaded,
      permissionLoaded: turnOptions.permissionLoaded,
      modelFeedback: { ...turnOptions.modelLoadingFeedback },
    };
  });
}
