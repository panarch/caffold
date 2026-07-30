import { expect, test } from "@playwright/test";

const PERMISSIONS = {
  defaultMode: "approveForMe",
  options: [
    {
      mode: "askForApproval",
      label: "Ask for approval",
      description: "Work in the workspace and ask before crossing its boundary.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "approveForMe",
      label: "Approve for me",
      description: "Keep the workspace boundary and review eligible requests automatically.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "fullAccess",
      label: "Full access",
      description: "Run without sandbox restrictions or approval prompts.",
      allowed: true,
      dangerous: true,
    },
  ],
};

async function stubComposerApis(page) {
  await page.route("**/api/codex/permissions*", (route) =>
    route.fulfill({ json: PERMISSIONS }),
  );
  await page.route("**/api/codex/models", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [
              { value: "medium", label: "Medium" },
              { value: "xhigh", label: "XHigh" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/tasks", (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } }),
  );
  await page.route("**/api/task-history*", (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } }),
  );
  await page.route("**/api/tasks/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
}

function taskDetail({
  running = false,
  model = null,
  reasoningEffort = null,
} = {}) {
  return {
    threadId: "thread-1",
    syncState: "ready",
    managed: true,
    revision: 1,
    task: {
      id: "thread-1",
      threadId: "thread-1",
      title: running ? "Running task" : "New task",
      preview: running ? "Working" : "Ready",
      threadStatus: { type: running ? "active" : "idle", activeFlags: [] },
      latestTurnStatus: running ? "inProgress" : null,
      activeTurn: running ? { id: "turn-1", startedAtMs: 1 } : null,
      cwd: "src",
      cwdPath: "src",
      relativeCwd: ".",
      worktree: null,
      createdMs: 1,
      updatedMs: 2,
      recencyMs: 2,
      lastEventSummary: null,
      unseen: false,
    },
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
    model,
    reasoningEffort,
  };
}

test("composer exposes Codex approval modes and confirms full access", async ({ page }) => {
  await stubComposerApis(page);
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
  await stubComposerApis(page);
  await page.unroute("**/api/tasks");
  let submittedBody = null;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({ json: taskDetail() });
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
  await stubComposerApis(page);
  await page.unroute("**/api/codex/permissions*");
  await page.route("**/api/codex/permissions*", (route) =>
    route.fulfill({
      json: {
        ...PERMISSIONS,
        defaultMode: "askForApproval",
      },
    }),
  );
  await page.unroute("**/api/tasks");
  let submittedBody = null;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({ json: taskDetail() });
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

test("explicit approval mode is sent with a follow-up prompt", async ({ page }) => {
  await stubComposerApis(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: {
        ...taskDetail(),
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

test("managed tasks restore their last applied model and reasoning effort", async ({
  page,
}) => {
  await stubComposerApis(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: taskDetail({
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

test("keeps a tall follow-up model menu inside the conversation pane", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop uses the anchored model popover");
  await stubComposerApis(page);
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
      json: taskDetail({
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
  await form
    .getByRole("button", { name: "Choose model and reasoning" })
    .click();
  const popover = form.getByRole("menu", { name: "Model and reasoning options" });
  const [paneBox, popoverBox] = await Promise.all([
    conversationPane.boundingBox(),
    popover.boundingBox(),
  ]);
  expect(paneBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox.y).toBeGreaterThanOrEqual(paneBox.y);

  await form.locator('[data-effort="medium"]').click();
  await expect(form.locator('input[name="effort"]')).toHaveValue("medium");
});

test("active turns lock the approval mode until the next turn", async ({ page }) => {
  await stubComposerApis(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: taskDetail({ running: true }) }),
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
  await stubComposerApis(page);
  const startedMs = Date.now() - 65_000;
  const detail = taskDetail({ running: true });
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

test("raw active flags prioritize approval over user input", async ({ page }) => {
  await stubComposerApis(page);
  const detail = taskDetail({ running: true });
  detail.task.threadStatus.activeFlags = [
    "waitingOnUserInput",
    "waitingOnApproval",
  ];
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");

  await expect(
    page.locator(
      '.task-detail-summary .task-status-chip[data-status="waiting_for_approval"]',
    ),
  ).toBeVisible();
  await expect(page.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
});

test("active task without a canonical turn omits controls and elapsed time", async ({
  page,
}) => {
  await stubComposerApis(page);
  const detail = taskDetail({ running: true });
  detail.task.latestTurnStatus = null;
  detail.task.activeTurn = null;
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");

  await expect(
    page.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Interrupt" })).toHaveCount(0);
  const active = page.locator(".task-turn-active");
  await expect(active).toBeVisible();
  await expect(active).not.toHaveAttribute("data-active-turn-started-ms");
  await expect(active.locator(".task-turn-active-duration")).toHaveText("Working");
});

test("loading detail accepts a canonical task sync without a synthetic task", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        if (url.includes("/api/tasks/thread-1/stream")) {
          window.__taskDetailSource = this;
        } else if (url.startsWith("/api/tasks/stream")) {
          window.__taskListSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await stubComposerApis(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: {
        threadId: "thread-1",
        syncState: "loading",
        managed: true,
        revision: 0,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: true,
      },
    }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  await expect(page.getByText("Loading task...")).toBeVisible();
  await expect(page.locator(".task-detail")).toHaveCount(0);

  const detail = taskDetail();
  detail.revision = 2;
  await page.evaluate((detail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-bootstrap",
    });
  }, detail);

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await expect(page.getByText("Loading task...")).toHaveCount(0);

  await page.evaluate((detail) => {
    window.__taskListSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail: { ...detail, managed: false },
      reason: "late-sync-after-removal",
    });
  }, detail);
  await expect(
    page.locator('.task-row[data-thread-id="thread-1"]'),
  ).toHaveCount(0);

  await page.evaluate(() => {
    const message = {
      threadId: "thread-1",
      revision: 3,
      detail: {
        threadId: "thread-1",
        syncState: "loading",
        managed: true,
        revision: 3,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: true,
      },
      reason: "canonical-source-error",
      error: "Codex app-server is unavailable",
    };
    window.__taskDetailSource.emit("task-sync", message);
    window.__taskListSource.emit("task-sync", message);
  });

  await expect(
    page.getByText("Task details are temporarily unavailable."),
  ).toBeVisible();
  await expect(
    page.locator(".task-load-error-message"),
  ).toHaveText("Codex app-server is unavailable");
  await expect(page.locator(".task-detail")).toHaveCount(0);
  await expect(page.locator(".task-status-chip")).toHaveCount(0);
  await expect(
    page.locator('.task-list-section[data-task-section="managed"]'),
  ).toContainText("Codex app-server is unavailable");
  await expect(
    page.locator('.task-row[data-thread-id="thread-1"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-task-action="retry-task-detail"]'),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '.task-list-section[data-task-section="managed"] [data-task-action="retry-task-list"]',
    ),
  ).toHaveCount(1);
});
