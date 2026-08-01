import { expect, test } from "@playwright/test";
import {
  installTaskApiFixture,
  TASK_PERMISSION_FIXTURE,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import { pasteImage } from "../support/task-fixtures.js";

test("composer exposes Codex approval modes and confirms full access", async ({ page }) => {
  await installTaskApiFixture(page);
  await page.goto("/tasks/new?cwd=src");

  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Approve for me");
  await expect
    .poll(() =>
      form
        .locator(".task-composer-toolbar")
        .evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth + 1),
    )
    .toBe(true);

  await picker.click();
  await expect(form.getByRole("menu", { name: "Approval modes" })).toBeVisible();
  await form.getByRole("button", { name: /^Ask for approval/ }).click();
  await expect(form.locator('input[name="permissionMode"]')).toHaveValue(
    "askForApproval",
  );

  await picker.click();
  page.once("dialog", (dialog) => dialog.accept());
  await form.getByRole("button", { name: /^Full access/ }).click();
  await expect(form.locator('input[name="permissionMode"]')).toHaveValue("fullAccess");
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
    return route.fulfill({ json: { tasks: [], nextCursor: null } });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  await expect(
    form.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Approve for me");
  await form.getByRole("textbox", { name: "New task prompt" }).fill("Inspect the task");
  await form.getByRole("textbox", { name: "New task prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).not.toHaveProperty("permissionMode");
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
    return route.fulfill({ json: { tasks: [], nextCursor: null } });
  });

  await page.goto("/tasks/new?cwd=src");
  const form = page.locator('.task-new-form[data-task-form="create"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Ask for approval");
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
      return route.fulfill({ json: { tasks: [], nextCursor: null } });
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

  await prompt.press("Enter");
  await expect.poll(() => submittedBodies).toHaveLength(2);
  expect(submittedBodies[1]).toMatchObject({
    cwd: "src",
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
  await expect(picker).toContainText("Ask for approval");
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
  const metrics = () =>
    form.evaluate((element) => {
      const panel = element.querySelector(".task-composer-panel");
      const textarea = element.querySelector("textarea[name='prompt']");
      const sendButton = element.querySelector(".task-send-button");
      const build = document.querySelector(".app-build");
      const workspace = document.querySelector("caffold-codex-workspace");
      const conversation = document.querySelector(".task-conversation-scroll");
      const rootStyle = getComputedStyle(document.documentElement);
      const formStyle = getComputedStyle(element);
      const conversationStyle = getComputedStyle(conversation);
      const sendStyle = getComputedStyle(sendButton);
      const panelRect = panel.getBoundingClientRect();
      const buildRect = build.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      return {
        borderTopWidth: formStyle.borderTopWidth,
        panelHeight: panelRect.height,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        panelBottom: panelRect.bottom,
        textareaHeight: textarea.getBoundingClientRect().height,
        viewportWidth: window.innerWidth,
        rootFontSize: Number.parseFloat(rootStyle.fontSize),
        formPaddingLeft: Number.parseFloat(formStyle.paddingLeft),
        conversationPaddingLeft: Number.parseFloat(
          conversationStyle.paddingLeft,
        ),
        sendDisabled: sendButton.disabled,
        sendBackground: sendStyle.backgroundColor,
        buildPosition: getComputedStyle(build).position,
        buildTop: buildRect.top,
        workspaceBottom: workspaceRect.bottom,
      };
    });

  const idle = await metrics();
  expect(idle).toEqual(
    expect.objectContaining({
      borderTopWidth: "0px",
      sendDisabled: true,
      buildPosition: "static",
    }),
  );
  expect(idle.panelHeight).toBeLessThanOrEqual(96);
  expect(idle.panelBottom).toBeLessThanOrEqual(idle.buildTop);
  expect(idle.workspaceBottom).toBeLessThanOrEqual(idle.buildTop);
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

test("managed tasks restore their last applied model and reasoning effort", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: taskDetailFixture({
        model: "gpt-test",
        reasoningEffort: "xhigh",
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
    name: "Choose model and reasoning",
  });
  await expect(picker).toContainText("GPT Test");
  await expect(picker).toContainText("XHigh");
  await page.reload();
  await expect(picker).toContainText("GPT Test");
  await expect(picker).toContainText("XHigh");
  await form.getByRole("textbox", { name: "Follow-up prompt" }).fill("Continue");
  await form.getByRole("textbox", { name: "Follow-up prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    model: "gpt-test",
    effort: "xhigh",
  });
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
    .getByRole("button", { name: "Choose model and reasoning" })
    .click();
  const picker = form.getByRole("menu", {
    name: "Model and reasoning options",
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
            { value: "medium", label: "Medium" },
            { value: "xhigh", label: "XHigh" },
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
    name: "Choose model and reasoning",
  });
  await modelButton.click();
  const popover = form.getByRole("menu", { name: "Model and reasoning options" });
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

  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Approve for me");
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute(
    "title",
    "Approval mode can be changed after the active turn finishes.",
  );
  const modelPicker = form.getByRole("button", {
    name: "Choose model and reasoning",
  });
  await expect(modelPicker).toBeDisabled();
  await expect(modelPicker).toHaveAttribute(
    "title",
    "Model and reasoning can be changed after the active turn finishes.",
  );
  await form.getByRole("textbox", { name: "Follow-up prompt" }).fill("Steer this turn");
  await form.getByRole("textbox", { name: "Follow-up prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    prompt: "Steer this turn",
    activeTurnId: "turn-1",
  });
  expect(submittedBody).not.toHaveProperty("permissionMode");
  expect(submittedBody).not.toHaveProperty("model");
  expect(submittedBody).not.toHaveProperty("effort");
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
