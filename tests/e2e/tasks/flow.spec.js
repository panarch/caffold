import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
  openHeaderActionGroup,
  pasteImage,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("opens global Tasks without local registry state", async ({ page }, testInfo) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);

  const threadId = "thread_global_fixture";
  let createdTaskRequest = null;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Global task",
    preview: "Hello from a cwd-backed task",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "tests/fixtures/home",
    worktree: null,
    createdMs: 1_767_200_000_000,
    updatedMs: 1_767_200_000_000,
    recencyMs: 1_767_200_000_000,
    lastEventSummary: "Assistant response",
  };
  const detail = {
    task,
    events: [
      {
        id: "event_prompt",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: { text: "Say hello globally" },
        createdMs: task.createdMs,
      },
      {
        id: "event_answer",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "Hello from a global Codex thread." },
        createdMs: task.createdMs + 1,
      },
    ],
    eventsPage: { nextCursor: null },
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
        body: JSON.stringify({ tasks: [] }),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createdTaskRequest = request.postDataJSON();
      expect(createdTaskRequest.cwd).toBe("src");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    return route.continue();
  });
  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== ".") {
      return route.continue();
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        root: "tests/fixtures/home",
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
  await expect(page).toHaveURL("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  const taskActionTextSize = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;font-size:var(--interface-meta-font-size)";
    document.body.append(probe);
    const value = getComputedStyle(probe).fontSize;
    probe.remove();
    return value;
  });
  await expect(
    tasksPage.locator('.tasks-header [data-task-action="open-new"]'),
  ).toHaveCSS("font-size", taskActionTextSize);
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(
    page.locator("caffold-codex-workspace .codex-workspace-close"),
  ).toBeHidden();

  await page.goto("/tasks?cwd=.");
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  await expect(tasksPage).toContainText("No Caffold tasks yet.");

  await page.goto("/tasks");
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  await expect(tasksPage).toContainText("No Caffold tasks yet.");

  await page.goto("/tasks?cwd=.");
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });

  await tasksPage
    .locator(".tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL("/tasks/new");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(page).toHaveURL("/tasks");
  await tasksPage
    .locator(".tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL("/tasks/new");
  await tasksPage.locator('textarea[name="prompt"]').fill("Say hello globally");
  await tasksPage.getByRole("button", { name: "Browse Files" }).click();
  const cwdBrowser = tasksPage.locator(".task-new-cwd-browser caffold-file-browser");
  await expect(cwdBrowser).toBeVisible();
  await cwdBrowser.locator('button[data-entry-path="src"]').click();
  await tasksPage.getByRole("button", { name: "Use This Folder" }).click();
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(tasksPage.locator('textarea[name="prompt"]')).toHaveValue(
    "Say hello globally",
  );
  await expect(tasksPage.locator(".task-composer-context")).toContainText("src");
  await tasksPage.locator('textarea[name="prompt"]').press("Enter");

  await expect.poll(() => createdTaskRequest?.prompt).toBe("Say hello globally");
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");
  const openDiff = tasksPage.getByRole("button", { name: "Open Diff" });
  await expect(openDiff).toBeDisabled();
  await expect(tasksPage.getByRole("button", { name: "Git unavailable" })).toBeDisabled();
  await expect(tasksPage.getByRole("button", { name: "GitHub unavailable" })).toBeDisabled();
  await expect(tasksPage).toContainText("Unavailable outside a Git worktree.");

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
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main");
  await expect(tasksPage.locator(".task-review-menu")).toHaveCount(2);

  await tasksPage
    .locator('.task-review-menu summary[aria-label="Open Git workspace"]')
    .click();
  await captureReviewScreenshot(page, testInfo, "tasks-global-git-menu");
  await tasksPage
    .locator('button[data-summary-action="open-git-tool"][data-review-kind="diff"]')
    .click();
  await expect(page).toHaveURL("/git/diff?cwd=.");
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");

  await tasksPage
    .locator('.task-review-menu summary[aria-label="Open GitHub workspace"]')
    .click();
  const githubMenuMetrics = await tasksPage
    .locator('.task-review-menu[data-review-menu="github"]')
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
        items: [...menu.querySelectorAll(".task-review-menu-popover button")].map(
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
    .locator('button[data-summary-action="open-github-tool"][data-review-kind="issues"]')
    .click();
  await expect(page).toHaveURL("/github/issues?cwd=.");
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");

  await tasksPage.locator('button[data-summary-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFiles = tasksPage.locator(".task-files-view");
  await expect(
    taskFiles.locator('button[data-entry-path="README.md"]'),
  ).toBeVisible();
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );

  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  const taskDiff = tasksPage.locator(".task-diff-view");
  const readmeChange = taskDiff.locator(
    'caffold-git-diff-changes-tree button[data-repo-relative-path="README.md"]',
  );
  await expect(readmeChange).toBeVisible();
  await readmeChange.click();
  await expect(
    taskDiff.locator(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
    ),
  ).toContainText("Global worktree review");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
});
test("runs a minimal task from creation through follow-up", async ({ page }) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/files?cwd=${encodeURIComponent(scenario.contextPath)}`);
  const codexPopover = await openHeaderActionGroup(page, "codex");
  await codexPopover.locator('button[data-action="open-tasks"]').click();

  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "list");
  await tasksPage
    .locator(".tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();

  const composer = tasksPage.locator(".task-new-form");
  await composer.locator(".task-model-button").click();
  await composer.locator(".task-model-popover [data-effort=\"xhigh\"]").click();
  const prompt = composer.locator('textarea[name="prompt"]');
  await prompt.fill("Inspect the planner changes");
  await pasteImage(prompt, "planner-layout.png");
  await expect(composer.locator(".task-composer-attachment")).toHaveCount(1);
  await prompt.press("Enter");

  await expect.poll(() => scenario.createTaskRequests).toBe(1);
  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);
  await expect(tasksPage.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
  await tasksPage
    .locator('.task-approval-card button[data-decision="accept"]')
    .click();
  await expect.poll(() => scenario.approvalRequests).toBe(1);
  await expect(
    tasksPage.locator('.task-message[data-message-role="assistant"]'),
  ).toContainText("The planner changes are ready to review.");

  const followUp = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await followUp.fill("한글 버튼 제출");
  await followUp.press("Enter");
  await expect.poll(() => scenario.followUpRequests).toBe(1);
  await expect(followUp).toHaveValue("");
  expect(scenario.pageErrors).toEqual([]);
});
