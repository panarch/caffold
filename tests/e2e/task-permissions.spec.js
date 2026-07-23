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
            supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
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

function taskDetail({ running = false } = {}) {
  return {
    managed: true,
    revision: 1,
    task: {
      id: "thread-1",
      threadId: "thread-1",
      title: running ? "Running task" : "New task",
      preview: running ? "Working" : "Ready",
      status: running ? "running" : "idle",
      cwd: "src",
      cwdPath: "src",
      relativeCwd: ".",
      worktree: null,
      createdMs: 1,
      updatedMs: 2,
      recencyMs: 2,
      activeTurnId: running ? "turn-1" : null,
      activeTurnStartedMs: running ? 1 : null,
      lastEventSummary: null,
      unseen: false,
    },
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
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

  await page.goto("/tasks/thread-1?cwd=src");

  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const picker = form.getByRole("button", { name: "Choose approval mode" });
  await expect(picker).toContainText("Approve for me");
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute(
    "title",
    "Approval mode can be changed after the active turn finishes.",
  );
});
