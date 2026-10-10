import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  createdTaskResponse,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
  pasteImage,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("opens global Tasks without local registry state", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);

  const threadId = "thread_global_fixture";
  let createdTaskRequest = null;
  let fileReads = 0;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Global task",
    preview: "Hello from a cwd-backed task",
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "frontend/tests/e2e/fixtures/home",
    worktree: null,
    createdMs: 1_767_200_000_000,
    updatedMs: 1_767_200_000_000,
    recencyMs: 1_767_200_000_000,
    lastEventSummary: "Assistant response",
  };
  const detail = {
    revision: 1,
    eventRevision: 1,
    task,
    events: [
      {
        id: "event_prompt",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: { text: "Say hello globally" },
        position: { anchorMs: task.createdMs, index: 0 },
      },
      {
        id: "event_answer",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "Hello from a global Codex thread." },
        position: { anchorMs: task.createdMs + 1, index: 0 },
      },
    ],
    eventsPage: { nextCursor: null },
    eventsRange: { from: null, to: null },
    pendingApprovals: [],
  };
  const taskListQueries = [];

  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      taskListQueries.push({ cwd: url.searchParams.get("cwd") });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeTaskProjection()),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createdTaskRequest = request.postDataJSON();
      expect(createdTaskRequest.cwd).toBe("src");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(createdTaskResponse(detail, {
          section: {
            id: "section-src",
            name: "src",
            repository: false,
          },
        })),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "prompts" &&
      method === "POST"
    ) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId,
          turnId: "turn-global-created",
          userMessageId: "message-global-created",
          steered: false,
        }),
      });
    }

    return route.fallback();
  });
  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== ".") {
      return route.continue();
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        root: "frontend/tests/e2e/fixtures/home",
        path: ".",
        git: { rootPath: ".", branch: "main", dirty: true },
        entries: [
          {
            name: "src",
            path: "src",
            kind: "directory",
            isSymlink: false,
            supported: true,
            gitIgnored: false,
            size: null,
            modifiedMs: null,
            git: null,
          },
          {
            name: "README.md",
            path: "README.md",
            kind: "file",
            isSymlink: false,
            supported: true,
            gitIgnored: false,
            size: 24,
            modifiedMs: null,
            git: null,
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/file(?:\?|$)/, (route) => {
    fileReads += 1;
    return route.continue();
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: ".",
          branch: "main",
          dirty: true,
        },
        additions: 1,
        deletions: 0,
        files: [
          {
            path: "README.md",
            repoRelativePath: "README.md",
            status: "??",
            category: "untracked",
            staged: false,
            unstaged: false,
            untracked: true,
          },
        ],
      }),
    }),
  );
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    expect(url.searchParams.get("file")).toBe("README.md");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: ".",
          branch: "main",
          dirty: true,
        },
        path: "README.md",
        repoRelativePath: "README.md",
        kind: "untracked",
        diff: [
          "diff --git a/README.md b/README.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/README.md",
          "@@ -0,0 +1 @@",
          "+Global worktree review",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: ".", branch: "main", dirty: true },
        github: { owner: "example", name: "caffold" },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    });
  });
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: ".", branch: "main", dirty: true },
        github: { owner: "example", name: "caffold" },
        state: "open",
        issues: [],
        page: 1,
        perPage: 50,
        totalIssues: 0,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });

  await page.goto("/");
  await expect(page).toHaveURL("/");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
  await expect(tasksPage).toHaveAttribute("data-task-list-state", "empty");
  await expect(tasksPage.locator(".task-new-form")).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toHaveCount(0);
  await expect(page.locator("caffold-task-workspace")).not.toHaveAttribute(
    "data-workspace-route-control-visible",
    "",
  );
  await captureReviewScreenshot(page, testInfo, "tasks-home-new-task-detail");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(
    page.locator("caffold-task-workspace .task-workspace-back"),
  ).toBeHidden();

  await page.goto("/tasks?cwd=.");
  await expect(page).toHaveURL("/");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
  await expect(page.locator("caffold-task-navigator")).toContainText(
    "No Caffold tasks yet.",
  );

  await page.goto("/tasks");
  await expect(page).toHaveURL("/");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
  await expect(page.locator("caffold-task-navigator")).toContainText(
    "No Caffold tasks yet.",
  );

  await page.goto("/tasks?cwd=.");
  await expect(page).toHaveURL("/");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });

  await page.goto("/tasks/new");
  await expect(page).toHaveURL("/tasks/new");
  await expect(page.locator("caffold-task-workspace")).toHaveAttribute(
    "data-workspace-route-control-visible",
    "",
  );
  await page.goBack();
  await expect(page).toHaveURL("/");
  await page.goto("/tasks/new");
  await expect(page).toHaveURL("/tasks/new");
  const prompt = tasksPage.locator('textarea[name="prompt"]');
  const directoryField = tasksPage.locator("caffold-task-new caffold-task-directory-field");
  await prompt.fill("Say hello globally");
  await directoryField.getByRole("button", { name: "Show folders" }).click();
  const srcRow = directoryField.locator('button[data-file-tree-path="src"]');
  await expect(srcRow).toBeVisible();
  await srcRow.click();
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(directoryField.locator(".task-directory-field-path")).toHaveText("src");
  expect(fileReads).toBe(0);
  await expect(prompt).toHaveValue("Say hello globally");
  await expect(
    tasksPage.locator(".task-new-form .task-primary-action-button"),
  ).toBeEnabled();
  await prompt.press("Enter");

  await expect.poll(() => createdTaskRequest?.titleSource).toBe("Say hello globally");
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");
  await expect(
    page.locator(
      `caffold-task-navigator .task-row[data-thread-id="${threadId}"]`,
    ),
  ).toContainText("Global task");
  const openReview = tasksPage.getByRole("button", { name: "Review", exact: true });
  await expect(openReview).toBeEnabled();
  await expect(tasksPage.getByRole("button", { name: "Git unavailable" })).toBeDisabled();
  await expect(tasksPage.getByRole("button", { name: "GitHub unavailable" })).toBeDisabled();
  await openReview.click();
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source`,
  );
  await expect(tasksPage).toContainText(
    "Git review is unavailable for this task.",
  );
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();

  Object.assign(task, {
    worktree: {
      rootPath: ".",
      branch: "main",
      headSha: "0123456789abcdef",
      relativeCwd: "",
      linked: false,
    },
  });
  await page.reload();
  await emitTaskDetailBootstrap(page, detail);
  await expect(
    tasksPage.locator('[data-task-info-field="worktree-ref"]'),
  ).toHaveText("main");
  await expect(
    tasksPage.locator("caffold-task-detail-git, caffold-task-detail-github"),
  ).toHaveCount(2);

  const gitReviewMenu = tasksPage.locator("caffold-task-detail-git");
  const gitReviewMenuButton = gitReviewMenu.getByRole("button", {
    name: "Open Git workspace",
  });
  await gitReviewMenuButton.click();
  const gitReviewMenuPopover = gitReviewMenu.locator(".task-git-popover");
  await expect(gitReviewMenuPopover).toBeVisible();
  const [gitReviewMenuButtonBox, gitReviewMenuPopoverBox] = await Promise.all([
    gitReviewMenuButton.boundingBox(),
    gitReviewMenuPopover.boundingBox(),
  ]);
  expect(gitReviewMenuButtonBox).not.toBeNull();
  expect(gitReviewMenuPopoverBox).not.toBeNull();
  expect(gitReviewMenuPopoverBox.x).toBeGreaterThanOrEqual(7);
  expect(
    gitReviewMenuPopoverBox.x + gitReviewMenuPopoverBox.width,
  ).toBeLessThanOrEqual(page.viewportSize().width - 7);
  expect(gitReviewMenuPopoverBox.y).toBeGreaterThanOrEqual(
    gitReviewMenuButtonBox.y + gitReviewMenuButtonBox.height + 4,
  );
  expect(
    gitReviewMenuButtonBox.x + gitReviewMenuButtonBox.width / 2,
  ).toBeGreaterThanOrEqual(gitReviewMenuPopoverBox.x - 1);
  expect(
    gitReviewMenuButtonBox.x + gitReviewMenuButtonBox.width / 2,
  ).toBeLessThanOrEqual(
    gitReviewMenuPopoverBox.x + gitReviewMenuPopoverBox.width + 1,
  );
  await captureReviewScreenshot(page, testInfo, "tasks-global-git-menu");
  await expect(
    gitReviewMenu.locator('button[data-review-kind="compare"]'),
  ).toBeVisible();
  await expect(
    gitReviewMenu.locator('button[data-review-kind="log"]'),
  ).toBeVisible();
  await expect(gitReviewMenu.locator('button[data-review-kind="diff"]')).toHaveCount(0);
  await gitReviewMenuButton.click();

  await tasksPage
    .getByRole("button", { name: "Open GitHub workspace" })
    .click();
  const githubMenuMetrics = await tasksPage
    .locator("caffold-task-detail-github")
    .evaluate((menu) => {
      const probe = document.createElement("div");
      probe.style.cssText = [
        "position:fixed",
        "height:var(--interface-compact-control-size)",
        "font-size:var(--interface-meta-font-size)",
      ].join(";");
      document.body.append(probe);
      const expected = {
        fontSize: getComputedStyle(probe).fontSize,
        height: probe.getBoundingClientRect().height,
      };
      probe.remove();
      return {
        expected,
        items: [...menu.querySelectorAll(".task-github-popover button")].map(
          (button) => ({
            fontSize: getComputedStyle(button).fontSize,
            height: button.getBoundingClientRect().height,
          }),
        ),
      };
    });
  expect(githubMenuMetrics.items).toHaveLength(2);
  for (const item of githubMenuMetrics.items) {
    expect(item.fontSize).toBe(githubMenuMetrics.expected.fontSize);
    expect(item.height).toBeCloseTo(githubMenuMetrics.expected.height, 1);
  }
  await captureReviewScreenshot(page, testInfo, "tasks-global-github-menu");
  await tasksPage
    .locator(
      'caffold-task-detail-github button[data-github-button-action][data-review-kind="issues"]',
    )
    .click();
  await expect(page).toHaveURL(`/tasks/${threadId}/github/issues`);
  await expect(page.locator("caffold-task-github-layout")).toHaveAttribute(
    "data-github-mode",
    "issues",
  );
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await tasksPage
    .locator(
      'caffold-task-review caffold-segmented-control[data-review-axis="navigator"] button[data-segmented-value="files"]',
    )
    .click();
  const taskReview = tasksPage.locator("caffold-task-review");
  if (testInfo.project.name === "phone") {
    await taskReview.evaluate((review) => review.updateAxis("viewer", "source"));
  } else {
    await taskReview
      .locator(
        'caffold-segmented-control[data-review-axis="viewer"] button[data-segmented-value="source"]',
      )
      .click();
  }
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "review",
  );
  const taskFiles = tasksPage.locator("caffold-task-review caffold-file-navigator");
  await expect(
    taskFiles.locator('button[data-file-tree-path="README.md"]'),
  ).toBeVisible();
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "review",
  );
  await expect(page).toHaveURL(`/tasks/${threadId}/review?nav=files&view=source`);
  const taskDiff = tasksPage.locator("caffold-task-review");
  await taskDiff.getByRole("button", { name: "Changes", exact: true }).click();
  if (testInfo.project.name === "phone") {
    await taskDiff.evaluate((review) => review.updateAxis("viewer", "diff"));
  } else {
    await taskDiff.getByRole("button", { name: "Diff", exact: true }).click();
  }
  const readmeChange = taskDiff.locator(
    'caffold-git-diff-changes-tree button[data-file-tree-relative-path="README.md"]',
  );
  await expect(readmeChange).toBeVisible();
  await readmeChange.click();
  await expect(
    taskDiff.locator("caffold-review-file-viewer"),
  ).toContainText("Global worktree review");
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
});
test("runs a minimal task from creation through follow-up", { tag: "@all-viewports" }, async ({ page }) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);

  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "new");
  await expect(tasksPage).toHaveAttribute("data-task-list-state", "empty");

  const composer = tasksPage.locator(".task-new-form");
  await expect(composer).toBeVisible();
  await composer.locator(".task-model-button").click();
  await composer.locator(".task-model-popover [data-effort=\"xhigh\"]").click();
  const prompt = composer.locator('textarea[name="prompt"]');
  await prompt.fill("Inspect the planner changes");
  await pasteImage(prompt, "planner-layout.png");
  await expect(composer.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(composer.locator(".task-primary-action-button")).toBeEnabled();
  await prompt.press("Enter");

  await expect.poll(() => scenario.createTaskRequests).toBe(1);
  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);
  await expect(tasksPage.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
  await tasksPage
    .locator('.task-approval-card button[data-decision="allow"]')
    .click();
  await expect.poll(() => scenario.approvalRequests).toBe(1);
  await expect(
    tasksPage.locator(".task-assistant-message"),
  ).toContainText("The planner changes are ready to review.");

  const followUp = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await followUp.fill("한글 버튼 제출");
  await expect(
    tasksPage.locator(".task-follow-up-form .task-primary-action-button"),
  ).toBeEnabled();
  await followUp.press("Enter");
  await expect.poll(() => scenario.followUpRequests).toBe(1);
  await expect(followUp).toHaveValue("");
  expect(scenario.pageErrors).toEqual([]);
});

test("shows the retained initial prompt until the ordinary prompt request is accepted", { tag: "@viewport-independent" }, async ({ page }) => {
  const scenario = await installTaskLoopFixture(page, { deferInitialPrompt: true });
  const tasksPage = page.locator("caffold-tasks-page");
  await startTaskFromNewSurface(page, scenario);

  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);
  await scenario.initialPromptRequested;
  expect(scenario.createTaskRequests).toBe(1);
  expect(scenario.initialPromptRequests).toBe(1);
  const userMessage = tasksPage.locator('.task-message[data-message-role="user"]');
  await expect(userMessage).toHaveCount(1);
  await expect(userMessage).toContainText("Inspect the planner changes");
  await expect(userMessage.locator("caffold-task-user-message")).toHaveAttribute(
    "data-delivery-state",
    "sending",
  );
  await expect(userMessage.locator(".task-message-attachment img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );

  await scenario.releaseInitialPrompt();

  await expect(userMessage).toHaveCount(1);
  await expect(userMessage.locator("caffold-task-user-message")).not.toHaveAttribute(
    "data-delivery-state",
    /.+/,
  );
  await expect(tasksPage).toContainText("Command approval requested");
  expect(scenario.pageErrors).toEqual([]);
});

test("prevents a duplicate while create then ordinary prompt is in progress", { tag: "@viewport-independent" }, async ({ page }) => {
  const scenario = await installTaskLoopFixture(page, { deferInitialPrompt: true });
  const tasksPage = page.locator("caffold-tasks-page");
  await startTaskFromNewSurface(page, scenario);
  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);
  await scenario.initialPromptRequested;

  const followUp = tasksPage.locator('.task-follow-up-form textarea[name="prompt"]');
  await followUp.fill("Second prompt before the first turn");
  await followUp.press("Enter");

  expect(scenario.initialPromptRequests).toBe(1);
  expect(scenario.followUpRequests).toBe(0);
  await expect(followUp).toHaveValue("Second prompt before the first turn");
  await expect(
    tasksPage.locator(".task-follow-up-form .task-primary-action-button"),
  ).toBeDisabled();

  await scenario.releaseInitialPrompt();

  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]'),
  ).toHaveCount(1);
  expect(scenario.pageErrors).toEqual([]);
});

test("keeps the empty Task and restores its composer when the initial prompt is rejected", { tag: "@viewport-independent" }, async ({ page }) => {
  const scenario = await installTaskLoopFixture(page, { deferInitialPrompt: true });
  const tasksPage = page.locator("caffold-tasks-page");
  await startTaskFromNewSurface(page, scenario, {
    fastMode: true,
    permissionMode: "askForApproval",
  });
  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);
  await scenario.initialPromptRequested;
  expect(scenario.initialPromptBody).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fastMode: true,
    permissionMode: "askForApproval",
  });

  await scenario.rejectInitialPrompt();

  await expect(
    tasksPage.locator(".task-follow-up-form .task-composer-request-error"),
  ).toHaveText("Prompt request failed");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]'),
  ).toHaveCount(0);
  const composer = tasksPage.locator(".task-follow-up-form");
  await expect(composer.locator('textarea[name="prompt"]')).toHaveValue(
    "Inspect the planner changes",
  );
  await expect(composer.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(composer.locator('input[name="model"]')).toHaveValue(
    "gpt-5.6-sol",
  );
  await expect(composer.locator('input[name="effort"]')).toHaveValue("xhigh");
  await expect(composer.locator('input[name="fastMode"]')).toHaveValue("true");
  await expect(composer.locator('input[name="permissionMode"]')).toHaveValue(
    "askForApproval",
  );
  await expect(composer.locator('textarea[name="prompt"]')).toBeFocused();
  expect(scenario.createTaskRequests).toBe(1);
  expect(scenario.initialPromptRequests).toBe(1);
  expect(scenario.pageErrors).toEqual([]);
});

// The New Task surface's own submission, performed the way a person performs
// it, so each test above starts from a Task that was created through the UI.
async function startTaskFromNewSurface(
  page,
  scenario,
  { fastMode = false, permissionMode = "" } = {},
) {
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);
  const composer = page.locator("caffold-tasks-page .task-new-form");
  await expect(composer).toBeVisible();
  await composer.locator(".task-model-button").click();
  await composer.locator('.task-model-popover [data-effort="xhigh"]').click();
  if (fastMode) {
    await composer.locator(".task-model-button").click();
    await composer.locator('[data-fast-mode="true"]').click();
  }
  if (permissionMode) {
    await composer.getByRole("button", { name: "Choose approval mode" }).click();
    await composer.locator(`[data-permission-mode="${permissionMode}"]`).click();
  }
  const prompt = composer.locator('textarea[name="prompt"]');
  await prompt.fill("Inspect the planner changes");
  await pasteImage(prompt, "planner-layout.png");
  await expect(composer.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(composer.locator(".task-primary-action-button")).toBeEnabled();
  await prompt.press("Enter");
}
