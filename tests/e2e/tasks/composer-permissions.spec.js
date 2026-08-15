import { expect, test } from "@playwright/test";
import {
  installTaskApiFixture,
  TASK_PERMISSION_FIXTURE,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  pasteImage,
} from "../support/task-fixtures.js";

async function switchWorkspaceMode(page, mode) {
  const button = page.locator(
    `caffold-task-workspace-navigation button[data-workspace-mode="${mode}"]`,
  );
  if (await button.isVisible()) {
    await button.click();
  } else {
    await button.evaluate((element) => element.click());
  }
}

test("composer exposes Codex approval modes and confirms full access", async ({
  page,
}, testInfo) => {
  await installTaskApiFixture(page);
  await page.goto("/tasks/new?cwd=src");

  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Auto review");
  await expect
    .poll(() =>
      form
        .locator(".task-composer-toolbar")
        .evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth + 1),
    )
    .toBe(true);

  await picker.click();
  const permissionPopover = form.getByRole("menu", { name: "Approval modes" });
  await expect(permissionPopover).toBeVisible();
  const permissionPopoverBounds = await permissionPopover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const paneRect = element
      .closest(".tasks-detail-pane")
      .getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      paneLeft: paneRect.left,
      paneRight: paneRect.right,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(permissionPopoverBounds.left).toBeGreaterThanOrEqual(0);
  expect(permissionPopoverBounds.right).toBeLessThanOrEqual(
    permissionPopoverBounds.viewportWidth,
  );
  expect(permissionPopoverBounds.left).toBeGreaterThanOrEqual(
    permissionPopoverBounds.paneLeft,
  );
  expect(permissionPopoverBounds.right).toBeLessThanOrEqual(
    permissionPopoverBounds.paneRight,
  );
  await captureReviewScreenshot(page, testInfo, "tasks-permission-popover");
  await form.getByRole("button", { name: /^Ask for approval/ }).click();
  await expect(form.locator('input[name="permissionMode"]')).toHaveValue(
    "askForApproval",
  );
  await expect(picker).toContainText("Ask approval");

  await picker.click();
  page.once("dialog", (dialog) => dialog.accept());
  await form.getByRole("button", { name: /^Full access/ }).click();
  await expect(form.locator('input[name="permissionMode"]')).toHaveValue("fullAccess");
  await expect(picker).toContainText("Full access");
});

test("model options use native popover dismissal and return focus to their trigger", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.goto("/tasks/new?cwd=src");

  const form = page.locator('.task-new-form[data-task-form="create"]');
  const trigger = form.getByRole("button", { name: /Choose model/ });
  const popover = form.getByRole("menu", { name: /Model.*options/ });
  await trigger.click();
  await expect(popover).toBeVisible();
  expect(
    await popover.evaluate((element) => ({
      mode: element.getAttribute("popover"),
      open: element.matches(":popover-open"),
      target: element.id,
    })),
  ).toEqual({
    mode: "auto",
    open: true,
    target: await trigger.getAttribute("popovertarget"),
  });

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await form.getByRole("textbox", { name: "New task prompt" }).click();
  await expect(popover).toBeHidden();
});

test("untouched approval mode preserves the effective Codex default", async ({ page }) => {
  await installTaskApiFixture(page);
  await page.unroute("**/api/tasks");
  let submittedBody = null;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({ json: taskDetailFixture() });
    }
    return route.fulfill({ json: activeTaskProjection() });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  await expect(
    form.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Auto review");
  await form.getByRole("textbox", { name: "New task prompt" }).fill("Inspect the task");
  await form.getByRole("textbox", { name: "New task prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).not.toHaveProperty("permissionMode");
  expect(submittedBody.fastMode).toBe(false);
});

test("explicit approval mode is sent with a new task prompt", async ({ page }) => {
  await installTaskApiFixture(page);
  await page.unroute("**/api/codex/permissions*");
  await page.route("**/api/codex/permissions*", (route) =>
    route.fulfill({
      json: {
        ...TASK_PERMISSION_FIXTURE,
        defaultMode: "askForApproval",
      },
    }),
  );
  await page.unroute("**/api/tasks");
  let submittedBody = null;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({ json: taskDetailFixture() });
    }
    return route.fulfill({ json: activeTaskProjection() });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Ask approval");
  await picker.click();
  await form.getByRole("button", { name: /^Approve for me/ }).click();
  await form.getByRole("textbox", { name: "New task prompt" }).fill("Inspect the task");
  await form.getByRole("textbox", { name: "New task prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    prompt: "Inspect the task",
    permissionMode: "approveForMe",
  });
});

test("new tasks start in Normal mode and submit an explicit Fast choice", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.unroute("**/api/tasks");
  let submittedBody = null;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({ json: taskDetailFixture({ fastMode: true }) });
    }
    return route.fulfill({ json: activeTaskProjection() });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const modelPicker = form.getByRole("button", { name: /Choose model/ });
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect(form.locator(".task-model-fast")).toHaveCount(0);
  await expect(modelPicker).not.toHaveClass(/\bis-fast\b/);
  const normalGridColumns = await modelPicker.evaluate(
    (button) => getComputedStyle(button).gridTemplateColumns.split(" ").length,
  );
  expect(normalGridColumns).toBe(2);

  await modelPicker.click();
  const modelMenu = form.getByRole("menu", {
    name: "Model, reasoning, and speed options",
  });
  await expect(modelMenu.getByText("Speed", { exact: true })).toBeVisible();
  const optionMetrics = await modelMenu
    .locator(".task-model-option")
    .first()
    .evaluate((option) => {
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        height: option.getBoundingClientRect().height,
        rootFontSize: Number.parseFloat(rootStyle.fontSize),
        targetFloor: Number.parseFloat(
          rootStyle.getPropertyValue("--interface-target-floor"),
        ),
        fontWeight: getComputedStyle(option.querySelector("strong")).fontWeight,
      };
    });
  expect(optionMetrics.fontWeight).toBe("600");
  expect(optionMetrics.height).toBeCloseTo(
    Math.max(
      optionMetrics.rootFontSize * 2.125,
      optionMetrics.targetFloor - 2,
    ),
    1,
  );
  await modelMenu.locator('[data-fast-mode="true"]').click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");
  await expect(form.locator(".task-model-fast")).toHaveAttribute(
    "title",
    "Fast mode",
  );
  await expect(modelPicker).toHaveClass(/\bis-fast\b/);
  const fastGridColumns = await modelPicker.evaluate(
    (button) => getComputedStyle(button).gridTemplateColumns.split(" ").length,
  );
  expect(fastGridColumns).toBe(3);
  const fastIconMetrics = await form
    .locator(".task-model-fast-icon")
    .evaluate((icon) => ({
      fill: getComputedStyle(icon).fill,
      color: getComputedStyle(icon).color,
      size: icon.getBoundingClientRect().width,
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
    }));
  expect(fastIconMetrics.fill).toBe(fastIconMetrics.color);
  expect(fastIconMetrics.size / fastIconMetrics.rootFontSize).toBeCloseTo(
    0.75,
    2,
  );

  await form.getByRole("textbox", { name: "New task prompt" }).fill("Use Fast mode");
  await form.getByRole("textbox", { name: "New task prompt" }).press("Enter");
  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody.fastMode).toBe(true);

  await expect(page).toHaveURL(/\/tasks\/thread-1$/);
  await page.locator("caffold-tasks-page").evaluate((element) => {
    element.requestNewTaskRoute();
  });
  const nextForm = page.locator('.task-new-form[data-task-form="create"]');
  await expect(nextForm.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect(nextForm.locator(".task-model-fast")).toHaveCount(0);
});

test("resets option-only New Task selections after Settings navigation", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.unroute("**/api/tasks");
  let submittedBody = null;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({ json: taskDetailFixture() });
    }
    return route.fulfill({ json: activeTaskProjection() });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const modelPicker = form.getByRole("button", { name: /Choose model/ });
  await modelPicker.click();
  await form.locator('[data-fast-mode="true"]').click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");

  await switchWorkspaceMode(page, "settings");
  await expect(page).toHaveURL("/settings");
  await switchWorkspaceMode(page, "tasks");
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect(form.locator(".task-model-fast")).toHaveCount(0);

  const prompt = form.getByRole("textbox", { name: "New task prompt" });
  await prompt.fill("Use the reset Normal mode");
  await prompt.press("Enter");
  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody.fastMode).toBe(false);
});

test("preserves and clears New Task options with their meaningful draft", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const modelPicker = form.getByRole("button", { name: /Choose model/ });
  const permissionPicker = form.getByRole("button", {
    name: "Choose approval mode",
  });
  const prompt = form.getByRole("textbox", { name: "New task prompt" });

  await modelPicker.click();
  await form.locator('[data-effort="xhigh"]').click();
  await modelPicker.click();
  await form.locator('[data-fast-mode="true"]').click();
  await permissionPicker.click();
  await form.getByRole("button", { name: /^Ask for approval/ }).click();
  await prompt.fill("Keep this complete draft snapshot");
  await pasteImage(prompt, "draft-snapshot.png");

  await switchWorkspaceMode(page, "settings");
  await expect(page).toHaveURL("/settings");
  await switchWorkspaceMode(page, "tasks");
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(prompt).toHaveValue("Keep this complete draft snapshot");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-test");
  await expect(form.locator('input[name="effort"]')).toHaveValue("xhigh");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");
  await expect(form.locator('input[name="permissionMode"]')).toHaveValue(
    "askForApproval",
  );

  await prompt.fill("");
  await form
    .getByRole("button", { name: "Remove draft-snapshot.png" })
    .click();
  await switchWorkspaceMode(page, "settings");
  await expect(page).toHaveURL("/settings");
  await switchWorkspaceMode(page, "tasks");
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(prompt).toHaveValue("");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-test");
  await expect(form.locator('input[name="effort"]')).toHaveValue("medium");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect(form.locator('input[name="permissionMode"]')).toHaveValue(
    "approveForMe",
  );
  expect(
    await form.locator("caffold-task-turn-options").evaluate((element) =>
      element.snapshot(),
    ),
  ).toMatchObject({
    modelExplicit: false,
    fastModeExplicit: false,
    permissionExplicit: false,
  });
});

test("reconciles an option-only follow-up to canonical Normal after Task switching", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Wide Task switching regression",
  );
  await installTaskApiFixture(page);
  const makeDetail = (threadId, title) => {
    const detail = taskDetailFixture({
      model: "gpt-test",
      reasoningEffort: "medium",
      fastMode: false,
    });
    detail.threadId = threadId;
    detail.task = {
      ...detail.task,
      id: threadId,
      threadId,
      title,
      preview: `${title} preview`,
    };
    return detail;
  };
  const detailA = makeDetail("thread_option_a", "Option Task A");
  const detailB = makeDetail("thread_option_b", "Option Task B");
  const details = new Map([
    [detailA.threadId, detailA],
    [detailB.threadId, detailB],
  ]);
  await page.unroute("**/api/tasks");
  await page.route("**/api/tasks", (route) =>
    route.fulfill({
      json: activeTaskProjection([detailB.task, detailA.task]),
    }),
  );
  await page.route(/\/api\/tasks\/thread_option_[ab](?:\?|$)/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
    return route.fulfill({ json: details.get(threadId) });
  });
  await page.route(/\/api\/tasks\/thread_option_[ab]\/stream(?:\?|$)/, (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" }),
  );

  await page.goto("/tasks/thread_option_a?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  const modelPicker = form.getByRole("button", { name: /Choose model/ });
  await modelPicker.click();
  await form.locator('[data-fast-mode="true"]').click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");

  const navigator = page.locator("caffold-task-navigator");
  await navigator
    .locator('.task-row[data-thread-id="thread_option_b"]')
    .click();
  await expect(page).toHaveURL("/tasks/thread_option_b");
  expect(
    await tasksPage.evaluate((element) => {
      const detail = element.taskDetail().taskDetail();
      const composer = detail.followUpComposers.get("thread_option_a");
      return {
        restorable: composer.hasRestorableState(),
        retained: detail.shouldRetainFollowUpComposer(
          "thread_option_a",
          composer,
        ),
        options: composer.turnOptions().snapshot(),
      };
    }),
  ).toEqual({
    restorable: false,
    retained: false,
    options: {
      model: "gpt-test",
      effort: "medium",
      fastMode: false,
      permissionMode: "approveForMe",
      modelExplicit: false,
      fastModeExplicit: false,
      permissionExplicit: false,
    },
  });

  await navigator
    .locator('.task-row[data-thread-id="thread_option_a"]')
    .click();
  await expect(page).toHaveURL("/tasks/thread_option_a");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect(form.locator(".task-model-fast")).toHaveCount(0);
});

test("switching to a model without Fast support normalizes to Normal and hides Speed", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.unroute("**/api/codex/models");
  await page.route("**/api/codex/models", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "gpt-fast",
            model: "gpt-fast",
            displayName: "GPT Fast",
            description: "Fast-capable model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            defaultReasoningEffort: "low",
            serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
            supportsPersonality: false,
            isDefault: true,
          },
          {
            id: "gpt-normal-only",
            model: "gpt-normal-only",
            displayName: "GPT Normal Only",
            description: "Normal-only model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            defaultReasoningEffort: "low",
            serviceTiers: [],
            supportsPersonality: false,
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    }),
  );

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: /Choose model/ });
  await picker.click();
  await form.locator('[data-fast-mode="true"]').click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");

  await picker.click();
  await form.locator('[data-model="gpt-normal-only"]').click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect(form.locator(".task-model-fast")).toHaveCount(0);
  await picker.click();
  await expect(
    form.getByRole("menu", { name: /Model.*options/ }).getByText("Speed", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("new task submission stays single-flight and restores local input after rejection", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.unroute("**/api/tasks");
  let releaseFirstRequest;
  const firstRequestGate = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const submittedBodies = [];
  let adoptedDetailReads = 0;
  await page.route("**/api/tasks/thread-1", (route) => {
    adoptedDetailReads += 1;
    return route.fulfill({ json: taskDetailFixture() });
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({ json: activeTaskProjection() });
    }
    submittedBodies.push(route.request().postDataJSON());
    if (submittedBodies.length === 1) {
      await firstRequestGate;
      return route.fulfill({
        status: 503,
        json: { error: "Create request rejected" },
      });
    }
    return route.fulfill({ json: taskDetailFixture() });
  });

  await page.goto("/tasks/new?cwd=src");
  const composer = page.locator("caffold-task-composer");
  const form = composer.locator('.task-new-form[data-task-form="create"]');
  const prompt = form.getByRole("textbox", { name: "New task prompt" });
  await composer.evaluate((element) => {
    element.dataset.instanceMarker = "stable";
  });
  await form.getByRole("button", { name: /Choose model/ }).click();
  await form.locator('[data-fast-mode="true"]').click();
  await prompt.fill("Retry this exact task");
  await pasteImage(prompt, "create-retry.png");
  await prompt.press("Enter");

  await expect.poll(() => submittedBodies).toHaveLength(1);
  await expect(form).toHaveAttribute("aria-busy", "true");
  await expect(prompt).toBeDisabled();
  await expect(form.getByRole("button", { name: "Start task" })).toBeDisabled();
  await form.getByRole("button", { name: "Start task" }).click({ force: true });
  expect(submittedBodies).toHaveLength(1);

  releaseFirstRequest();
  await expect(form).toContainText("Create request rejected");
  await expect(composer).toHaveAttribute("data-instance-marker", "stable");
  await expect(prompt).toHaveValue("Retry this exact task");
  await expect(prompt).toBeFocused();
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");

  await prompt.press("Enter");
  await expect.poll(() => submittedBodies).toHaveLength(2);
  expect(submittedBodies[1]).toMatchObject({
    cwd: "src",
    fastMode: true,
    prompt: "Retry this exact task",
  });
  expect(submittedBodies[1].images).toHaveLength(1);
  await expect(page).toHaveURL("/tasks/thread-1");
  expect(adoptedDetailReads).toBe(0);
});

test("explicit approval mode is sent with a follow-up prompt", async ({ page }) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: {
        ...taskDetailFixture(),
        permissionMode: "askForApproval",
      },
    }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
  let submittedBody = null;
  await page.route("**/api/tasks/thread-1/prompts", (route) => {
    submittedBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-2",
        steered: false,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Ask approval");
  await picker.click();
  await form.getByRole("button", { name: /^Approve for me/ }).click();
  await form.getByRole("textbox", { name: "Follow-up prompt" }).fill("Continue the task");
  await form.getByRole("textbox", { name: "Follow-up prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    prompt: "Continue the task",
    permissionMode: "approveForMe",
  });
});

test("send button does not return focus to the prompt after submission", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: taskDetailFixture() }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
  let acceptPrompt;
  const promptAccepted = new Promise((resolve) => {
    acceptPrompt = resolve;
  });
  let releasePrompt;
  await page.route("**/api/tasks/thread-1/prompts", async (route) => {
    acceptPrompt();
    await new Promise((resolve) => {
      releasePrompt = resolve;
    });
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-2",
        steered: false,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const form = page.locator(
    'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden]) .task-follow-up-form[data-task-form="follow-up"]',
  );
  const prompt = form.getByRole("textbox", { name: "Follow-up prompt" });
  await prompt.fill("Continue without reopening the keyboard");
  await form.getByRole("button", { name: "Send prompt" }).click();
  await promptAccepted;
  await expect(prompt).not.toBeFocused();

  releasePrompt();
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).not.toBeFocused();
});

test("keeps an idle follow-up composer compact within the portrait content gutter", async ({
  page,
}, testInfo) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: taskDetailFixture() }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  const form = page.locator(
    'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden]) .task-follow-up-form[data-task-form="follow-up"]',
  );
  const prompt = form.getByRole("textbox", { name: "Follow-up prompt" });
  const send = form.getByRole("button", { name: "Send prompt" });
  await expect(form).toBeVisible();
  await expect
    .poll(() =>
      form.evaluate((element) => {
        const composer = element.closest("caffold-task-composer");
        return Boolean(
          composer?.isConnected &&
            !composer.modelLoading &&
            !composer.permissionLoading,
        );
      }),
    )
    .toBe(true);
  const metrics = () =>
    form.evaluate((element) => {
      const panel = element.querySelector(".task-composer-panel");
      const textarea = element.querySelector("textarea[name='prompt']");
      const sendButton = element.querySelector(".task-primary-action-button");
      const modelButton = element.querySelector(".task-model-button");
      const modelName = element.querySelector(".task-model-name");
      const permissionButton = element.querySelector(".task-permission-button");
      const buildAlert = document.querySelector(
        "caffold-build-mismatch-alert",
      );
      const shell = document.querySelector("caffold-app-shell");
      const workspace = document.querySelector("caffold-task-workspace");
      const conversation = document.querySelector(".task-conversation-scroll");
      const rootStyle = getComputedStyle(document.documentElement);
      const formStyle = getComputedStyle(element);
      const conversationStyle = getComputedStyle(conversation);
      const sendStyle = getComputedStyle(sendButton, "::before");
      const panelRect = panel.getBoundingClientRect();
      const modelButtonRect = modelButton.getBoundingClientRect();
      const permissionButtonRect = permissionButton.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      return {
        borderTopWidth: formStyle.borderTopWidth,
        panelHeight: panelRect.height,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        panelBottom: panelRect.bottom,
        textareaHeight: textarea.getBoundingClientRect().height,
        modelLabel: modelButton.innerText.replace(/\s+/g, " ").trim(),
        modelNameClipped: modelName.scrollWidth > modelName.clientWidth + 1,
        chipGap: permissionButtonRect.left - modelButtonRect.right,
        viewportWidth: window.innerWidth,
        rootFontSize: Number.parseFloat(rootStyle.fontSize),
        formPaddingLeft: Number.parseFloat(formStyle.paddingLeft),
        conversationPaddingLeft: Number.parseFloat(
          conversationStyle.paddingLeft,
        ),
        sendDisabled: sendButton.disabled,
        sendBackground: sendStyle.backgroundColor,
        buildAlertHidden: buildAlert.hidden,
        shellBottom: shellRect.bottom,
        workspaceBottom: workspaceRect.bottom,
      };
    });

  const idle = await metrics();
  expect(idle).toEqual(
    expect.objectContaining({
      borderTopWidth: "0px",
      sendDisabled: true,
      buildAlertHidden: true,
    }),
  );
  expect(idle.panelHeight).toBeLessThanOrEqual(96);
  expect(idle.modelLabel).toBe("Test · medium");
  expect(idle.modelNameClipped).toBe(false);
  expect(idle.chipGap).toBeGreaterThanOrEqual(0);
  expect(idle.chipGap).toBeLessThanOrEqual(8);
  expect(idle.panelBottom).toBeLessThanOrEqual(idle.workspaceBottom);
  expect(idle.workspaceBottom).toBeLessThanOrEqual(idle.shellBottom);
  if (testInfo.project.name === "phone") {
    expect(idle.formPaddingLeft / idle.rootFontSize).toBeCloseTo(0.75, 2);
    expect(idle.conversationPaddingLeft / idle.rootFontSize).toBeCloseTo(
      0.75,
      2,
    );
    expect(idle.panelLeft).toBeCloseTo(idle.formPaddingLeft, 1);
    expect(idle.viewportWidth - idle.panelRight).toBeCloseTo(
      idle.formPaddingLeft,
      1,
    );
  }
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-follow-up-composer-compact",
  );

  await prompt.fill("One\nTwo\nThree\nFour\nFive");
  const expanded = await metrics();
  await expect(send).toBeEnabled();
  expect(expanded.panelHeight).toBeGreaterThan(idle.panelHeight + 60);
  expect(expanded.textareaHeight).toBeGreaterThan(idle.textareaHeight + 60);
  expect(expanded.sendBackground).not.toBe(idle.sendBackground);

  await prompt.fill("");
  const reset = await metrics();
  await expect(send).toBeDisabled();
  expect(reset.panelHeight).toBeLessThanOrEqual(idle.panelHeight + 1);
  expect(reset.sendBackground).toBe(idle.sendBackground);
});

test("managed tasks restore their last applied model, reasoning, and speed", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: taskDetailFixture({
        model: "gpt-test",
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
  let submittedBody = null;
  await page.route("**/api/tasks/thread-1/prompts", (route) => {
    submittedBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-2",
        steered: false,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const picker = form.getByRole("button", {
    name: /Choose model/,
  });
  await expect(picker.locator(".task-model-name")).toHaveText("Test");
  await expect(picker.locator(".task-model-effort")).toContainText("xhigh");
  await expect(picker.locator(".task-model-fast")).toHaveAttribute(
    "title",
    "Fast mode",
  );
  await page.reload();
  await expect(picker.locator(".task-model-name")).toHaveText("Test");
  await expect(picker.locator(".task-model-effort")).toContainText("xhigh");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");
  await picker.click();
  await form.locator('[data-fast-mode="false"]').click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await form.getByRole("textbox", { name: "Follow-up prompt" }).fill("Continue");
  await form.getByRole("textbox", { name: "Follow-up prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    model: "gpt-test",
    effort: "xhigh",
    fastMode: false,
  });
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");

  const normalizedDetail = taskDetailFixture({
    model: "gpt-test",
    reasoningEffort: "xhigh",
    fastMode: false,
  });
  normalizedDetail.revision = 2;
  normalizedDetail.events = [
    {
      id: "event-normal-follow-up",
      threadId: "thread-1",
      type: "user_message",
      summary: "User prompt",
      payload: { turnId: "turn-2", text: "Continue" },
      createdMs: 3,
    },
  ];
  await page.evaluate((detail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-refresh",
    });
  }, normalizedDetail);
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
});

test("canonical task sync preserves an open follow-up model picker", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  const initialDetail = taskDetailFixture({
    model: "gpt-test",
    reasoningEffort: "medium",
  });
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: initialDetail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  await form
    .getByRole("button", { name: /Choose model/ })
    .click();
  const picker = form.getByRole("menu", {
    name: /Model.*options/,
  });
  await expect(picker).toBeVisible();

  const syncedDetail = {
    ...initialDetail,
    revision: 2,
    task: {
      ...initialDetail.task,
      preview: "Canonical refresh while choosing a model",
      updatedMs: 3,
      recencyMs: 3,
    },
  };
  await page.evaluate((detail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-refresh",
    });
  }, syncedDetail);

  await expect(picker).toBeVisible();
  await form.locator('[data-model="gpt-test"]').click();
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-test");
});

test("keeps a tall follow-up model menu inside the conversation pane", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop uses the anchored model popover");
  await page.setViewportSize({ width: 1280, height: 360 });
  await installTaskApiFixture(page);
  await page.unroute("**/api/codex/models");
  await page.route("**/api/codex/models", (route) =>
    route.fulfill({
      json: {
        data: Array.from({ length: 12 }, (_, index) => ({
          id: `gpt-test-${index}`,
          model: `gpt-test-${index}`,
          displayName: `GPT Test ${index}`,
          description: `Test model ${index} with enough detail to make the menu tall`,
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced depth" },
            { reasoningEffort: "xhigh", description: "Extra depth" },
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          isDefault: index === 0,
        })),
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: taskDetailFixture({
        model: "gpt-test-0",
        reasoningEffort: "medium",
      }),
    }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );

  await page.goto("/tasks/thread-1");
  const conversationPane = page.locator(".task-conversation-pane");
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const modelButton = form.getByRole("button", {
    name: /Choose model/,
  });
  await modelButton.click();
  const popover = form.getByRole("menu", { name: /Model.*options/ });
  const [paneBox, buttonBox, popoverBox] = await Promise.all([
    conversationPane.boundingBox(),
    modelButton.boundingBox(),
    popover.boundingBox(),
  ]);
  expect(paneBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox.y).toBeGreaterThanOrEqual(Math.max(0, paneBox.y));
  expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(
    buttonBox.y - 7,
  );
  expect(popoverBox.height).toBeGreaterThanOrEqual(120);

  await form.locator('[data-effort="medium"]').click();
  await expect(form.locator('input[name="effort"]')).toHaveValue("medium");
});

test("active turns lock the approval mode until the next turn", async ({ page }) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: taskDetailFixture({ running: true }) }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
  let submittedBody = null;
  await page.route("**/api/tasks/thread-1/prompts", (route) => {
    submittedBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-1",
        steered: true,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");

  const summary = page.locator("caffold-task-detail-summary");
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const primaryAction = form.locator(".task-primary-action-button");
  await expect(summary.getByRole("button", { name: /Interrupt/ })).toHaveCount(0);
  const initialSummaryHeight = await summary.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await expect(primaryAction).toBeEnabled();
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Auto review");
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute(
    "title",
    "Approval mode can be changed after the active turn finishes.",
  );
  const modelPicker = form.getByRole("button", {
    name: /Choose model/,
  });
  await expect(modelPicker).toBeDisabled();
  await expect(modelPicker).toHaveAttribute(
    "title",
    "Model, reasoning, and speed can be changed after the active turn finishes.",
  );
  await form.getByRole("textbox", { name: "Follow-up prompt" }).fill("Steer this turn");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "send");
  await expect
    .poll(() =>
      summary.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(initialSummaryHeight);
  await form.getByRole("textbox", { name: "Follow-up prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    prompt: "Steer this turn",
    activeTurnId: "turn-1",
  });
  expect(submittedBody).not.toHaveProperty("permissionMode");
  expect(submittedBody).not.toHaveProperty("model");
  expect(submittedBody).not.toHaveProperty("effort");
  expect(submittedBody).not.toHaveProperty("fastMode");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await expect
    .poll(() =>
      summary.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(initialSummaryHeight);
});

test("steering an active turn preserves its existing work clock", async ({ page }) => {
  await installTaskApiFixture(page);
  const startedMs = Date.now() - 65_000;
  const detail = taskDetailFixture({ running: true });
  detail.task.activeTurn.startedAtMs = startedMs;
  detail.events = [
    {
      id: "turn-1:started",
      threadId: "thread-1",
      type: "turn_started",
      summary: "Turn started",
      payload: { turnId: "turn-1" },
      createdMs: startedMs,
    },
  ];
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
  let submittedBody = null;
  let acceptPrompt;
  const promptAccepted = new Promise((resolve) => {
    acceptPrompt = resolve;
  });
  let releasePrompt;
  await page.route("**/api/tasks/thread-1/prompts", async (route) => {
    submittedBody = route.request().postDataJSON();
    acceptPrompt();
    await new Promise((resolve) => {
      releasePrompt = resolve;
    });
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-1",
        steered: true,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const activeTurn = page.locator('.task-turn-active[data-turn-id="turn-1"]');
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${startedMs}`,
  );

  const prompt = page.getByRole("textbox", { name: "Follow-up prompt" });
  await prompt.fill("Steer without resetting the clock");
  await prompt.press("Enter");
  await promptAccepted;

  expect(submittedBody).toMatchObject({
    prompt: "Steer without resetting the clock",
    activeTurnId: "turn-1",
  });
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${startedMs}`,
  );

  releasePrompt();
  await expect(
    page.locator('.task-follow-up-form[data-task-form="follow-up"]'),
  ).toHaveAttribute("aria-busy", "false");
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${startedMs}`,
  );
});
