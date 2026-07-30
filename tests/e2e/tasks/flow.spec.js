import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
  openHeaderActionGroup,
  pasteImage,
  scrollTop,
  stabilizeDynamicText,
  taskPresentation,
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
    .locator('button[data-task-action="open-git-tool"][data-review-kind="diff"]')
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
  await captureReviewScreenshot(page, testInfo, "tasks-global-github-menu");
  await tasksPage
    .locator('button[data-task-action="open-github-tool"][data-review-kind="issues"]')
    .click();
  await expect(page).toHaveURL("/github/issues?cwd=.");
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
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
test("opens Tasks from Codex header and runs a minimal task loop", async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve(),
      },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__caffoldMockEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });

  const contextPath = "src";
  await mockCodexModels(page);
  const now = 1_767_000_000_000;
  let task = null;
  let events = [];
  let createTaskRequests = 0;
  let followUpRequests = 0;
  let taskDetailReadRequests = 0;
  let approvalRequests = 0;
  let gitStatusRequests = 0;
  let gitRefsRequests = 0;
  let gitCompareRequests = 0;
  let gitCompareDiffRequests = 0;
  let includeTaskDiffLiveFile = false;
  let omitCompletedCommandFromDetail = false;
  let resolveFollowUpRequest;
  let releaseFollowUpResponse;
  let resolveCanonicalFollowUpRequest;
  let releaseCanonicalFollowUpResponse;
  const followUpRequested = new Promise((resolve) => {
    resolveFollowUpRequest = resolve;
  });
  const followUpResponseReleased = new Promise((resolve) => {
    releaseFollowUpResponse = resolve;
  });
  const canonicalFollowUpRequested = new Promise((resolve) => {
    resolveCanonicalFollowUpRequest = resolve;
  });
  const canonicalFollowUpResponseReleased = new Promise((resolve) => {
    releaseCanonicalFollowUpResponse = resolve;
  });
  const threadId = "thread_12345678";
  const completedAssistantResponse = [
    "## Review ready",
    "",
    "The planner changes are **ready** to review. Open `Diff` next.",
    "",
    "- Verified planner behavior",
    "- Confirmed fixture coverage",
    "",
    "```text",
    "cargo test",
    "```",
    "",
    "한국어와 English가 함께 있는 결과입니다. [Planner notes](https://example.com/planner)",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Planner | Pass |",
    "",
    `Long token: ${"planner".repeat(24)}`,
    "",
    "Malformed **marker stays readable.",
    "",
    ...Array.from(
      { length: 36 },
      (_, index) =>
        `Review note ${index + 1}: verified planner behavior and fixture coverage.`,
    ),
  ].join("\n");

  const eventRecord = (id, type, summary, payload = null, offset = 0) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const detailResponse = (overrides = {}) => ({
    threadId,
    syncState: "ready",
    revision: overrides.revision ?? 1,
    task: overrides.task ?? task,
    events: overrides.events ?? events,
    eventsPage: { nextCursor: null, ...(overrides.eventsPage ?? {}) },
    pendingApprovals: [],
  });
  const updateTask = (updates) => {
    task = {
      ...task,
      ...updates,
      updatedMs: now + events.length + 1,
      lastEventSummary: updates.lastEventSummary ?? task.lastEventSummary,
    };
  };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        additions: includeTaskDiffLiveFile ? 6 : 5,
        deletions: 4,
        files: [
          {
            path: "src/planner.rs",
            repoRelativePath: "planner.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/tests/planner.rs",
            repoRelativePath: "tests/planner.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/lib.rs",
            repoRelativePath: "lib.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/unrelated.rs",
            repoRelativePath: "unrelated.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          ...(includeTaskDiffLiveFile
            ? [
                {
                  path: "src/live-update.rs",
                  repoRelativePath: "live-update.rs",
                  status: "??",
                  category: "untracked",
                  staged: false,
                  unstaged: false,
                  untracked: true,
                },
              ]
            : []),
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    const relativePath = file.replace(/^src\//, "");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: relativePath,
        kind: url.searchParams.get("kind"),
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          "index 1111111..2222222 100644",
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@ -1 +1 @@",
          "-old planner behavior",
          "+new planner behavior",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    gitRefsRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        refs: [
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
          { name: "origin/release", kind: "remote" },
        ],
        currentRef: "main",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "main",
      }),
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const baseRef = url.searchParams.get("base");
    const path = baseRef === "origin/release" ? "src/release.rs" : "src/planner.rs";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        baseRef,
        headRef: "main",
        additions: baseRef === "origin/release" ? 7 : 3,
        deletions: baseRef === "origin/release" ? 2 : 1,
        files: [
          {
            path,
            repoRelativePath: path.replace(/^src\//, ""),
            status: baseRef === "origin/release" ? "A" : "M",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    gitCompareDiffRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const file = url.searchParams.get("file");
    const relativePath = file.replace(/^src\//, "");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: relativePath,
        kind: `${url.searchParams.get("base")}...main`,
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@ -1 +1 @@",
          "-old branch behavior",
          "+new branch behavior",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route(/\/api\/task-image(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("/tmp/planner-layout.png");
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      expect(url.searchParams.get("cwd")).toBeNull();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: task ? [task] : [] }),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createTaskRequests += 1;
      const body = request.postDataJSON();
      expect(body.cwd).toBe(contextPath);
      expect(body.prompt).toBe("Inspect the planner changes");
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.effort).toBe("xhigh");
      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
      task = {
        id: threadId,
        threadId,
        ...canonicalTaskState("active", {
          activeFlags: ["waitingOnApproval"],
          turnId: "turn_1",
          latestTurnStatus: "inProgress",
        }),
        title: "Inspect the planner changes",
        preview: "Inspect the planner changes",
        cwd: "src",
        cwdPath: "src",
        relativeCwd: "",
        worktree: {
          rootPath: "src",
          branch: "main",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          relativeCwd: "",
          linked: false,
        },
        createdMs: now,
        updatedMs: now + 4,
        recencyMs: now + 4,
        lastEventSummary: "Command approval requested",
      };
      events = [
        eventRecord("event_1", "prompt_sent", "Prompt sent", { prompt: body.prompt }, 1),
        eventRecord(
          "event_1_user",
          "user_message",
          "User prompt",
          {
            prompt: "",
            text: [
              "# Files mentioned by the user:",
              "",
              "## planner-layout.png: /tmp/planner-layout.png",
              "",
              "## My request for Codex:",
              body.prompt,
            ].join("\n"),
            turnId: "turn_1",
            item: {
              content: [
                {
                  type: "text",
                  text: body.prompt,
                },
                {
                  type: "image",
                  url: body.images[0],
                  name: "planner-layout.png",
                },
                {
                  type: "localImage",
                  path: "/tmp/planner-layout.png",
                  name: "server-reference.png",
                },
              ],
            },
          },
          2,
        ),
        eventRecord(
          "event_2",
          "thread_started",
          "Thread started",
          { threadId: "thread_12345678" },
          3,
        ),
        eventRecord("event_3", "turn_started", "Turn started", { turnId: "turn_1" }, 4),
        eventRecord(
          "event_4",
          "approval_requested",
          "Command approval requested",
          {
            approvalId: "approval_1",
            kind: "command",
            method: "item/commandExecution/requestApproval",
            params: {
              command: "cargo test",
              cwd: "src",
              reason: "Run the test suite",
              availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
            },
          },
          5,
        ),
      ];

      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      taskDetailReadRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          detailResponse({
            events: omitCompletedCommandFromDetail
              ? events.filter((event) => event.type !== "command_execution")
              : events,
          }),
        ),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "prompts" &&
      method === "POST"
    ) {
      const body = request.postDataJSON();
      followUpRequests += 1;
      if (body.prompt === "Prompt that fails") {
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Prompt request failed" }),
        });
      }
      if (body.prompt === "한글 버튼 제출") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: `turn_${followUpRequests}`,
            steered: body.activeTurnId !== null,
          }),
        });
      }
      if (body.prompt === "Canonical sync unlocks composer") {
        resolveCanonicalFollowUpRequest();
        await canonicalFollowUpResponseReleased;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: "turn_canonical_ack",
            steered: false,
          }),
        });
      }
      if (body.prompt === "Enter after canonical sync") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: "turn_after_canonical_ack",
            steered: false,
          }),
        });
      }
      expect(body.prompt).toBe("Please tighten the tests");
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.effort).toBe("ultra");
      expect(body.activeTurnId).toBeNull();
      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
      resolveFollowUpRequest();
      await followUpResponseReleased;
      events = [
        ...events,
        eventRecord(
          "event_6",
          "prompt_sent",
          "Follow-up prompt sent",
          { prompt: body.prompt },
          13,
        ),
        eventRecord(
          "event_6_user",
          "user_message",
          "User prompt",
          {
            text: body.prompt,
            turnId: "turn_2",
            item: {
              content: [
                { type: "text", text: body.prompt },
                { type: "image", url: body.images[0], name: "follow-up.png" },
              ],
            },
          },
          14,
        ),
        eventRecord(
          "event_6_turn",
          "turn_started",
          "Turn started",
          { turnId: "turn_2" },
          15,
        ),
        eventRecord(
          "command_follow_up",
          "command_execution",
          "Command inProgress",
          {
            turnId: "turn_2",
            itemId: "command_follow_up",
            lifecycle: "started",
            command: "cargo test --workspace",
            cwd: "src",
            status: "inProgress",
          },
          16,
        ),
      ];
      updateTask({
        ...canonicalTaskState("active", {
          turnId: "turn_2",
          latestTurnStatus: "inProgress",
        }),
        lastEventSummary: "Command inProgress",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId,
          turnId: "turn_2",
          steered: false,
        }),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "interrupt" &&
      method === "POST"
    ) {
      events = [
        ...events,
        eventRecord("event_7", "turn_interrupted", "Interrupt requested", null, 17),
      ];
      updateTask({
        ...canonicalTaskState("idle", { latestTurnStatus: "interrupted" }),
        lastEventSummary: "Interrupt requested",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (
      segments.length === 5 &&
      segments[2] === threadId &&
      segments[3] === "approvals" &&
      segments[4] === "approval_1" &&
      method === "POST"
    ) {
      approvalRequests += 1;
      const body = request.postDataJSON();
      expect(body.decision).toBe("accept");
      events = [
        ...events,
        eventRecord(
          "event_5",
          "approval_resolved",
          "Approval resolved: accept",
          { approvalId: "approval_1", decision: "accept", turnId: "turn_1" },
          5,
        ),
        eventRecord(
          "item-9",
          "assistant_message",
          "Assistant response",
          {
            phase: "commentary",
            text: "I am checking the planner diff before the final answer.",
          },
          11,
        ),
        eventRecord(
          "event_8",
          "reasoning",
          "Reasoning summary",
          {
            summary: ["Checked the planner diff.", "Confirmed the fixture coverage path."],
          },
          8,
        ),
        eventRecord(
          "event_9",
          "plan",
          "Plan updated",
          {
            text: "1. Inspect planner behavior\n2. Run focused tests",
          },
          9,
        ),
        eventRecord(
          "event_9_command_live",
          "command_execution",
          "Command started",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "inProgress",
          },
          9,
        ),
        eventRecord(
          "event_9_command",
          "command_execution",
          "Command completed",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "completed",
            aggregatedOutput:
              "test result: ok. 12 passed.\n" +
              "command-output-with-an-intentionally-long-unbroken-token-".repeat(18),
          },
          9,
        ),
        eventRecord(
          "event_10",
          "file_change",
          "File changes: 2",
          {
            status: "completed",
            changeCount: 2,
            changes: [{ path: "src/planner.rs" }, { path: "tests/planner.rs" }],
          },
          10,
        ),
        eventRecord(
          "event_9_command_completed",
          "command_execution",
          "Command completed",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "completed",
          },
          11,
        ),
        eventRecord(
          "event_10_repeat",
          "file_change",
          "File changes: 1",
          {
            status: "completed",
            changeCount: 1,
            changes: [{ path: "src/lib.rs" }],
          },
          10,
        ),
        eventRecord(
          "item-10",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            phase: "final",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_11_duplicate",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            phase: "final",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_12",
          "turn_completed",
          "Turn completed",
          { turnId: "turn_1", status: "completed" },
          12,
        ),
      ];
      updateTask({
        ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
        lastEventSummary: "Turn completed",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    return route.continue();
  });

  await page.goto(`/files?cwd=${encodeURIComponent(contextPath)}`);
  const codexPopover = await openHeaderActionGroup(page, "codex");
  await codexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL("/tasks");
  const codexWorkspace = page.locator("caffold-codex-workspace");
  await expect(codexWorkspace).toBeVisible();
  await expect
    .poll(() =>
      codexWorkspace.evaluate((element) => element.parentElement?.tagName.toLowerCase()),
    )
    .toBe("caffold-app-shell");
  const appShellBox = await page.locator("caffold-app-shell").boundingBox();
  const codexWorkspaceBox = await codexWorkspace.boundingBox();
  expect(Math.round(codexWorkspaceBox?.y ?? -1)).toBe(Math.round(appShellBox?.y ?? -2));
  expect(Math.round(codexWorkspaceBox?.height ?? -1)).toBe(
    Math.round(appShellBox?.height ?? -2),
  );
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "list",
  );
  await expect(page.locator("caffold-tasks-page")).toContainText("No Caffold tasks yet.");

  const emptyNewTaskButton = page
    .locator("caffold-tasks-page .tasks-empty")
    .getByRole("button", { name: "New Task", exact: true });
  await test.step("keeps shared task controls stable", async () => {
    expect(await taskPresentation(emptyNewTaskButton)).toEqual(
      expect.objectContaining({
        alignItems: "center",
        backgroundColor: "rgb(221, 239, 232)",
        borderColor: "rgb(159, 201, 187)",
        borderRadius: "5px",
        borderWidth: "1px",
        color: "rgb(22, 124, 92)",
        display: "inline-grid",
        minHeight: "32px",
        padding: "5px 10px",
      }),
    );
    expect(
      await taskPresentation(
        page.locator(
          'caffold-tasks-page .tasks-header [data-task-action="open-settings"]',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: "5px",
        borderWidth: "1px",
        display: "grid",
        height: 32,
        padding: "0px",
        width: 32,
      }),
    );
  });
  await emptyNewTaskButton.click();
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(contextPath)}`);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "new",
  );
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-new"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-list"]'),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page .tasks-header h1")).toHaveText(
    "New Task",
  );
  const newTaskHeaderMetrics = await page.evaluate(() => {
    const closeButton = document
      .querySelector("caffold-codex-workspace .codex-workspace-close")
      .getBoundingClientRect();
    const title = document
      .querySelector("caffold-tasks-page .tasks-header h1")
      .getBoundingClientRect();
    return {
      closeRight: closeButton.right,
      titleLeft: title.left,
    };
  });
  expect(newTaskHeaderMetrics.titleLeft).toBeGreaterThanOrEqual(
    newTaskHeaderMetrics.closeRight + 8,
  );
  const newTaskComposer = page.locator("caffold-tasks-page .task-new-form");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("GPT-5.6-Sol");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("Light");
  await newTaskComposer.locator(".task-model-button").click();
  const modelPopover = page.locator("caffold-tasks-page .task-model-popover");
  await expect(modelPopover).toBeVisible();
  const modelPopoverMetrics = await newTaskComposer.evaluate((form) => {
    const button = form.querySelector(".task-model-button").getBoundingClientRect();
    const panel = form.querySelector(".task-composer-panel").getBoundingClientRect();
    const popover = form.querySelector(".task-model-popover").getBoundingClientRect();
    const firstDescription = form.querySelector(".task-model-option small");
    const descriptionStyle = firstDescription
      ? window.getComputedStyle(firstDescription)
      : null;
    return {
      buttonBottom: button.bottom,
      buttonLeft: button.left,
      panelBottom: panel.bottom,
      panelLeft: panel.left,
      panelRight: panel.right,
      backdropVisible: Boolean(
        form.querySelector(".task-model-backdrop") &&
          window.getComputedStyle(form.querySelector(".task-model-backdrop")).display !==
            "none",
      ),
      popoverBottom: popover.bottom,
      popoverLeft: popover.left,
      popoverRight: popover.right,
      popoverTop: popover.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      descriptionWhiteSpace: descriptionStyle?.whiteSpace ?? "",
    };
  });
  expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportWidth - 9,
  );
  expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverBottom).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportHeight - 9,
  );
  expect(modelPopoverMetrics.descriptionWhiteSpace).not.toBe("nowrap");
  if (testInfo.project.name !== "phone") {
    expect(modelPopoverMetrics.backdropVisible).toBe(false);
    expect(
      Math.abs(modelPopoverMetrics.popoverLeft - modelPopoverMetrics.buttonLeft),
    ).toBeLessThanOrEqual(2);
    expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(
      modelPopoverMetrics.buttonBottom + 6,
    );
    expect(
      modelPopoverMetrics.popoverTop - modelPopoverMetrics.buttonBottom,
    ).toBeLessThanOrEqual(14);
  } else {
    expect(modelPopoverMetrics.backdropVisible).toBe(true);
    expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
    expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
      modelPopoverMetrics.viewportWidth - 9,
    );
    expect(
      modelPopoverMetrics.viewportHeight - modelPopoverMetrics.popoverBottom,
    ).toBeLessThanOrEqual(14);
    await newTaskComposer.locator(".task-model-backdrop").click({
      position: { x: 8, y: 8 },
    });
    await expect(modelPopover).toBeHidden();
    await newTaskComposer.locator(".task-model-button").click();
    await expect(modelPopover).toBeVisible();
  }
  await captureReviewScreenshot(page, testInfo, "tasks-model-popover");
  await expect(modelPopover.locator('[data-effort="xhigh"]')).toBeVisible();
  await expect(modelPopover.locator('[data-effort="max"]')).toBeVisible();
  await expect(modelPopover.locator('[data-effort="ultra"]')).toBeVisible();
  await modelPopover.locator('[data-effort="xhigh"]').click();
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("Extra High");
  const newPromptTextarea = newTaskComposer.locator('textarea[name="prompt"]');
  const initialTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      rows: textarea.getAttribute("rows"),
    };
  });
  expect(initialTextareaMetrics.rows).toBe("2");

  await newPromptTextarea.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  const expandedTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      clientHeight: textarea.clientHeight,
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      overflowY: styles.overflowY,
      scrollHeight: textarea.scrollHeight,
    };
  });
  expect(expandedTextareaMetrics.height).toBeGreaterThan(
    initialTextareaMetrics.height + 20,
  );
  expect(expandedTextareaMetrics.height).toBeLessThanOrEqual(
    expandedTextareaMetrics.maxHeight + 2,
  );
  expect(expandedTextareaMetrics.scrollHeight).toBeGreaterThan(
    expandedTextareaMetrics.clientHeight,
  );
  expect(expandedTextareaMetrics.overflowY).toBe("auto");

  await newPromptTextarea.fill("Inspect the planner changes");
  await pasteImage(newPromptTextarea, "planner-layout.png");
  const newTaskAttachment = page.locator(
    'form[data-task-form="create"] .task-composer-attachment',
  );
  await expect(newTaskAttachment).toHaveCount(1);
  await expect(newTaskAttachment.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await newTaskAttachment.getByRole("button", { name: "Remove planner-layout.png" }).click();
  await expect(newTaskAttachment).toHaveCount(0);
  await pasteImage(newPromptTextarea, "planner-layout.png");
  await expect(newTaskAttachment).toHaveCount(1);
  const newTaskFormState = await page.locator("caffold-tasks-page").evaluate((element) => {
    const form = element.querySelector('form[data-task-form="create"]');
    return {
      data: Object.fromEntries(new FormData(form).entries()),
      valid: form.checkValidity(),
    };
  });
  expect(newTaskFormState).toEqual({
    data: {
      effort: "xhigh",
      model: "gpt-5.6-sol",
      permissionMode: "approveForMe",
      prompt: "Inspect the planner changes",
    },
    valid: true,
  });
  await page.locator('caffold-tasks-page textarea[name="prompt"]').press("Enter");

  await expect.poll(() => createTaskRequests).toBe(1);
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveCount(1);
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
  await expect(tasksPage).toContainText("Inspect the planner changes");
  await expect(tasksPage).toContainText("Thread thread_1");
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main · src");
  await expect(tasksPage.locator(".task-conversation")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary h2")).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(tasksPage.locator(".task-detail-meta")).toHaveCSS("font-size", "12px");
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).toContainText(
    "Inspect the planner changes",
  );
  const userAttachments = tasksPage.locator(".task-message-attachment");
  await expect(userAttachments).toHaveCount(2);
  await expect(userAttachments.nth(0).locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(userAttachments.nth(0).locator("figcaption")).toContainText(
    "planner-layout.png",
  );
  await expect(userAttachments.nth(1).locator("img")).toBeVisible();
  await expect(userAttachments.nth(1).locator("img")).toHaveAttribute(
    "src",
    /\/api\/task-image\?path=%2Ftmp%2Fplanner-layout\.png$/,
  );
  await expect(userAttachments.nth(1).locator("figcaption")).toContainText(
    "server-reference.png",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).not.toContainText(
    "Files mentioned by the user",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).not.toContainText(
    "/tmp/planner-layout.png",
  );
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"] .task-message-content'),
  ).toHaveCSS("font-size", "15px");
  await expect(tasksPage).toContainText("Command Approval");
  await expect(tasksPage).toContainText("cargo test");
  await expect(tasksPage).toContainText("Run the test suite");
  await expect(tasksPage.locator(".task-conversation .task-approval-flow")).toHaveCount(1);
  await expect(tasksPage.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
  await test.step("keeps detail, conversation, and composer presentation stable", async () => {
    const phone = testInfo.project.name === "phone";
    expect(await taskPresentation(tasksPage.locator(".task-detail-summary"))).toEqual(
      expect.objectContaining({
        alignItems: "center",
        borderWidth: "0px 0px 1px",
        display: "grid",
        padding: phone ? "7px 8px" : "12px 14px",
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(
          '.task-detail-summary .task-status-chip[data-status="waiting_for_approval"]',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 248, 231)",
        borderColor: "rgb(223, 197, 143)",
        borderRadius: "999px",
        borderWidth: "1px",
        color: "rgb(127, 86, 0)",
        display: "grid",
        height: 22,
        padding: "0px",
        width: 22,
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(
          '.task-approval-card button[data-task-action="approval"][data-decision="accept"]',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        alignItems: "center",
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: "5px",
        borderWidth: "1px",
        color: "rgb(22, 124, 92)",
        display: "grid",
        minHeight: "32px",
        padding: "5px 10px",
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(
          '.task-message[data-message-role="user"] .task-message-content',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(238, 242, 239)",
        borderRadius: "18px",
        fontSize: "15px",
        lineHeight: "22px",
        overflowWrap: "anywhere",
        padding: "10px 14px",
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(".task-follow-up-form .task-composer-panel"),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: phone ? "16px" : "18px",
        borderWidth: "1px",
        display: "grid",
        overflow: "visible",
      }),
    );
  });
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-presentation-contract-active",
  );
  await expect
    .poll(() => tasksPage.evaluate((element) => element.selectedThreadId))
    .toBe(threadId);
  await expect
    .poll(() =>
      tasksPage
        .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
        .evaluate((button) => ({
          action: button.dataset.taskAction,
          approvalId: button.dataset.approvalId,
          decision: button.dataset.decision,
        })),
    )
    .toEqual({ action: "approval", approvalId: "approval_1", decision: "accept" });

  await tasksPage
    .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
    .click();
  expect(pageErrors).toEqual([]);
  await expect.poll(() => approvalRequests).toBe(1);
  await expect(tasksPage).toHaveCount(1);
  await expect
    .poll(() =>
      tasksPage.evaluate((element) =>
        element
          .querySelector("caffold-task-detail")
          .events.map((event) => event.type),
      ),
    )
    .toContain("approval_resolved");
  await expect(tasksPage.locator(".task-conversation .task-approval-flow")).toHaveCount(0);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toContainText(
    "The planner changes are ready to review.",
  );
  const assistantMarkdown = tasksPage.locator(
    '.task-message[data-message-role="assistant"] caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("h2")).toHaveText("Review ready");
  await expect(assistantMarkdown.locator("strong")).toHaveText("ready");
  await expect(assistantMarkdown.locator("li")).toHaveCount(2);
  await expect(assistantMarkdown.locator("pre code")).toHaveText("cargo test");
  await expect(assistantMarkdown.getByRole("link", { name: "Planner notes" })).toHaveAttribute(
    "href",
    "https://example.com/planner",
  );
  await expect(assistantMarkdown.locator("table")).toContainText("Planner");
  await expect(assistantMarkdown).toContainText("Malformed **marker stays readable.");
  await expect
    .poll(() =>
      assistantMarkdown.evaluate((element) => {
        const body = element.shadowRoot.querySelector(".markdown-body");
        return body.scrollWidth <= body.clientWidth;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(() => {
        const probe = document.createElement("caffold-task-markdown");
        probe.textContent = "Fallback content";
        document.body.append(probe);
        const fallback = probe.shadowRoot.querySelector(".markdown-fallback");
        const style = getComputedStyle(fallback);
        const result = {
          backgroundColor: style.backgroundColor,
          borderWidth: style.borderWidth,
          margin: style.margin,
          padding: style.padding,
        };
        probe.remove();
        return result;
      }),
    )
    .toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      margin: "0px",
      padding: "0px",
    });
  await tasksPage.evaluate(() => {
    const probe = document.createElement("caffold-task-markdown");
    probe.hidden = true;
    probe.textContent = "[unsafe](javascript:alert(1))";
    document.body.append(probe);
  });
  await expect(page.locator("caffold-task-markdown").last()).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  await expect(page.locator("caffold-task-markdown").last().locator("a")).toHaveCount(0);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toHaveCount(1);
  await expect(
    tasksPage.locator(
      '.task-message[data-message-role="assistant"][data-message-phase="final"]',
    ),
  ).toHaveCount(1);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).not.toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator(".task-turn-work")).toContainText("Worked for");
  await expect(tasksPage.locator(".task-turn-work")).toContainText("6 updates");
  await expect(tasksPage.locator(".task-turn-work > details")).not.toHaveAttribute("open", "");
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const work = element.querySelector(".task-turn-work");
        const assistant = element.querySelector('.task-message[data-message-role="assistant"]');
        const position = work && assistant ? work.compareDocumentPosition(assistant) : 0;
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-work-item")).toHaveCount(6);
  await expect(tasksPage.locator(".task-work-item").first()).not.toBeVisible();
  await tasksPage.locator(".task-turn-work > details > summary").click();
  await expect(tasksPage.locator('.task-work-item[data-event-type="assistant_message"]')).toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="reasoning"]')).toContainText(
    "Checked the planner diff.",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="plan"]')).toContainText(
    "Run focused tests",
  );
  const completedCommand = tasksPage.locator(
    '.task-work-item[data-event-type="command_execution"]',
  );
  await expect(tasksPage.locator(".task-turn-work").last()).toContainText("Command");
  await expect(completedCommand.locator("details")).not.toHaveAttribute("open", "");
  await completedCommand.locator("summary").click();
  await expect(completedCommand).toContainText("cargo test");
  await expect(completedCommand).toContainText("cwd: src");
  await expect(completedCommand).toContainText("completed");
  await expect(completedCommand).toContainText(
    "test result: ok",
  );
  const completedCommandOutput = completedCommand.locator("pre");
  await expect
    .poll(() =>
      completedCommandOutput.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(
        (element) =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  const workItemOrder = await tasksPage.locator(".task-work-item").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-event-type")),
  );
  expect(workItemOrder).toEqual([
    "approval_resolved",
    "reasoning",
    "plan",
    "command_execution",
    "file_change",
    "assistant_message",
  ]);
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "2 file change updates",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "tests/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/lib.rs",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-work-details");
  await tasksPage.locator(".task-turn-work > details > summary").click();
  await expect(tasksPage.locator(".task-turn-work > details")).not.toHaveAttribute("open", "");
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  await expect(tasksPage.locator(".task-follow-up-form")).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-scroll")).toHaveCSS("overflow-y", "auto");
  await expect(tasksPage).not.toContainText("assistant message");
  await expect(tasksPage).not.toContainText("user message");
  await expect(tasksPage).not.toContainText("turn started");
  const taskDetailsButton = tasksPage.getByRole("button", { name: /Task details/ });
  await expect(taskDetailsButton).toBeVisible();
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: idle");
  await taskDetailsButton.click();
  const taskDetailsPopover = tasksPage.locator(".task-detail-popover");
  await expect(taskDetailsPopover).toBeVisible();
  await expect(taskDetailsPopover).toContainText("idle");
  await expect(taskDetailsPopover).toContainText(threadId);
  await expect(taskDetailsPopover).toContainText("src");
  await expect(taskDetailsPopover).toContainText("Worktree");
  await expect(taskDetailsPopover).toContainText("Branch");
  await expect(taskDetailsPopover).toContainText("main");
  if (testInfo.project.name === "phone") {
    const mobileHeaderMetrics = await tasksPage.evaluate((element) => {
      const header = element.querySelector(".tasks-header").getBoundingClientRect();
      const summary = element.querySelector(".task-detail-summary").getBoundingClientRect();
      const actions = [
        ...element.querySelectorAll(
          ".task-detail-actions > button, .task-detail-actions > details > summary",
        ),
      ].map((control) => control.getBoundingClientRect());
      const details = element
        .querySelector(".task-detail-info-button")
        .getBoundingClientRect();
      return {
        headerHeight: header.height,
        summaryHeight: summary.height,
        overflow: element.scrollWidth > element.clientWidth,
        actionSizes: [...actions, details].map((box) => ({
          height: box.height,
          width: box.width,
        })),
      };
    });
    expect(mobileHeaderMetrics.headerHeight).toBeLessThanOrEqual(50);
    expect(mobileHeaderMetrics.summaryHeight).toBeLessThanOrEqual(50);
    expect(mobileHeaderMetrics.overflow).toBe(false);
    for (const size of mobileHeaderMetrics.actionSizes) {
      expect(Math.round(size.width)).toBe(32);
      expect(Math.round(size.height)).toBe(32);
    }
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-mobile-header-details");
  }
  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-conversation");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  const conversationBeforeFiles = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeFiles.maxScrollTop).toBeGreaterThan(0);
  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-persist-probe", "kept"));
  const taskReview = tasksPage.locator("caffold-task-review");
  await taskReview.evaluate((element) =>
    element.setAttribute("data-persist-probe", "kept"),
  );
  const taskMasterStateBeforeTools =
    testInfo.project.name === "desktop"
      ? await tasksPage.evaluate((element) => {
          const separator = element.querySelector(".tasks-master-resizer");
          separator.focus();
          separator.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
          );
          const listScroll = element.querySelector(".task-list-scroll");
          const listRegion = element.querySelector(".tasks-list-region");
          listScroll.style.height = "90px";
          listRegion.style.minHeight = "240px";
          listScroll.scrollTop = 40;
          return {
            listWidth: Math.round(
              element.querySelector(".tasks-list-pane").getBoundingClientRect().width,
            ),
            listScrollTop: listScroll.scrollTop,
          };
        })
      : null;

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFilesView = tasksPage.locator(".task-files-view");
  await expect(taskFilesView).toBeVisible();
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            browser.watchActive && Boolean(browser.watchUnsubscribe),
        ),
    )
    .toBe(true);
  await expect(tasksPage.locator(".tasks-header")).toBeHidden();
  await expect(tasksPage.locator(".task-detail-summary")).toBeHidden();
  await expect(tasksPage.locator(".tasks-list-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-master-resizer")).toBeHidden();
  const taskFilesLayout = await page.evaluate(() => {
    const codex = document.querySelector("caffold-codex-workspace");
    const appHeader = document.querySelector("caffold-app-shell .app-header");
    const pathbar = document.querySelector("caffold-pathbar");
    const filesHeader = document.querySelector(".task-files-header");
    const filesView = document.querySelector(".task-files-view");
    const filesTitle = document.querySelector(".task-files-header h3");
    const browser = document.querySelector(".task-files-view caffold-file-browser");
    const fileList = document.querySelector(".task-files-view caffold-file-list");

    const coveredByCodex = (element) => {
      const rect = element.getBoundingClientRect();
      const topElement = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        inCodex: Boolean(topElement?.closest("caffold-codex-workspace")),
        inSelf: topElement === element || element.contains(topElement),
      };
    };

    const codexRect = codex.getBoundingClientRect();
    const filesHeaderRect = filesHeader.getBoundingClientRect();
    const filesViewRect = filesView.getBoundingClientRect();
    const browserRect = browser.getBoundingClientRect();
    const fileListRect = fileList.getBoundingClientRect();

    return {
      viewportWidth: window.innerWidth,
      appHeaderCoveredByCodex:
        coveredByCodex(appHeader).inCodex && !coveredByCodex(appHeader).inSelf,
      pathbarCoveredByCodex:
        coveredByCodex(pathbar).inCodex && !coveredByCodex(pathbar).inSelf,
      filesHeaderTop: filesHeaderRect.top,
      codexTop: codexRect.top,
      filesViewLeft: filesViewRect.left,
      codexLeft: codexRect.left,
      filesViewRight: filesViewRect.right,
      codexRight: codexRect.right,
      filesViewBottom: filesViewRect.bottom,
      codexBottom: codexRect.bottom,
      browserHeight: browserRect.height,
      fileListWidth: fileListRect.width,
      titleFits: filesTitle.clientWidth >= filesTitle.scrollWidth,
    };
  });
  expect(taskFilesLayout.appHeaderCoveredByCodex).toBe(true);
  expect(taskFilesLayout.pathbarCoveredByCodex).toBe(true);
  expect(taskFilesLayout.filesHeaderTop).toBeLessThanOrEqual(taskFilesLayout.codexTop + 1);
  expect(Math.abs(taskFilesLayout.filesViewLeft - taskFilesLayout.codexLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(taskFilesLayout.filesViewRight - taskFilesLayout.codexRight)).toBeLessThanOrEqual(1);
  expect(taskFilesLayout.filesViewBottom).toBeGreaterThanOrEqual(taskFilesLayout.codexBottom - 1);
  expect(taskFilesLayout.browserHeight).toBeGreaterThan(400);
  if (taskFilesLayout.viewportWidth >= 861) {
    expect(taskFilesLayout.fileListWidth).toBeGreaterThanOrEqual(300);
  }
  expect(taskFilesLayout.titleFits).toBe(true);
  const filesTitleLeft = await taskFilesView
    .locator(".task-files-header h3")
    .evaluate((element) => element.getBoundingClientRect().left);
  const codexCloseRight = await page
    .locator("caffold-codex-workspace .codex-workspace-close")
    .evaluate((element) => element.getBoundingClientRect().right);
  expect(filesTitleLeft).toBeGreaterThan(codexCloseRight);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect(taskFilesView.locator("caffold-file-browser")).toHaveAttribute(
    "data-browser-view",
    "list",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  const embeddedLiveName = `task-live-${testInfo.project.name}.txt`;
  const embeddedLivePath = resolve("tests/fixtures/home/src", embeddedLiveName);
  try {
    await writeFile(embeddedLivePath, "Codex Files live update\n");
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 2,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toBeVisible();
  } finally {
    await rm(embeddedLivePath, { force: true });
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 3,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toHaveCount(0);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser-list");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            !browser.watchActive && !browser.watchUnsubscribe,
        ),
    )
    .toBe(true);
  await expect(page.locator("caffold-codex-workspace")).toBeVisible();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            browser.watchActive && Boolean(browser.watchUnsubscribe),
        ),
    )
    .toBe(true);
  await taskFilesView.locator('button[data-entry-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText(
    "alpha.rs",
  );
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText("pub const ALPHA");
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");
  if (testInfo.project.name === "phone") {
    await taskFilesView.getByRole("button", { name: "Back to files" }).click();
  }
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(taskFilesView).toBeHidden();
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            !browser.watchActive && !browser.watchUnsubscribe,
        ),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary")).toBeVisible();
  if (taskMasterStateBeforeTools) {
    await expect(tasksPage.locator(".tasks-list-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-master-resizer")).toBeVisible();
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(taskMasterStateBeforeTools.listWidth);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(taskMasterStateBeforeTools.listScrollTop);
  }
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeFiles.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator(".task-follow-up-form .task-model-button").click();
  await expect(modelPopover).toBeVisible();
  await modelPopover.locator('[data-effort="ultra"]').click();
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Ultra",
  );
  const followUpTextarea = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await followUpTextarea.fill("Please tighten the tests");
  await pasteImage(followUpTextarea, "follow-up.png");
  await expect(
    tasksPage.locator('.task-follow-up-form .task-composer-attachment'),
  ).toHaveCount(1);
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "data-thread-id",
    threadId,
  );
  await tasksPage.evaluate((element) => {
    element.querySelector("caffold-task-detail").selectedThreadId = "";
  });
  await tasksPage
    .locator('.task-follow-up-form button[type="submit"]')
    .click();
  await followUpRequested;
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await followUpTextarea.fill("Keep this next draft while the request runs");
  await followUpTextarea.press("Enter");
  await expect.poll(() => followUpRequests).toBe(1);
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Please tighten the tests",
    }),
  ).toBeVisible();
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="user"]')
      .filter({ hasText: "Please tighten the tests" })
      .locator('.task-message-attachment img'),
  ).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(tasksPage).not.toContainText("Follow-up prompt sent");
  releaseFollowUpResponse();
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(followUpTextarea).toHaveValue(
    "Keep this next draft while the request runs",
  );
  await page.evaluate((detail) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${detail.task.threadId}/stream`),
    );
    source?.emit("task-sync", {
      threadId: detail.task.threadId,
      revision: detail.revision,
      detail,
      reason: "test",
    });
  }, detailResponse({
    revision: 2,
    task: {
      ...task,
      ...canonicalTaskState("active", {
        turnId: "turn_2",
        startedAtMs: now + 7,
        latestTurnStatus: "inProgress",
      }),
    },
  }));
  const runningStatus = tasksPage.locator(
    '.task-detail-summary .task-status-chip[data-status="running"]',
  );
  await expect(
    runningStatus,
  ).toBeVisible();
  await expect(runningStatus.locator(".task-status-spinner")).toBeVisible();
  await expect(runningStatus.locator(".task-status-label")).toHaveCount(0);
  const activeTurn = tasksPage.locator('.task-turn-active[data-turn-id="turn_2"]');
  await expect(activeTurn).toBeVisible();
  await expect(activeTurn.locator(".task-turn-active-duration")).toContainText(
    "Working for",
  );
  await expect(activeTurn.locator(".task-turn-active-state")).toHaveText(
    "Running command",
  );
  const activeDuration = await activeTurn.locator(".task-turn-active-duration").textContent();
  await expect
    .poll(() => activeTurn.locator(".task-turn-active-duration").textContent())
    .not.toBe(activeDuration);
  const stableActiveTurnStartedMs = await activeTurn.getAttribute(
    "data-active-turn-started-ms",
  );
  for (let revision = 3; revision <= 5; revision += 1) {
    await page.evaluate((detail) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${detail.task.threadId}/stream`),
      );
      source?.emit("task-sync", {
        threadId: detail.task.threadId,
        revision: detail.revision,
        detail,
        reason: "canonical-refresh",
      });
    }, detailResponse({
      revision,
      task: {
        ...task,
        ...canonicalTaskState("active", {
          turnId: "turn_2",
          startedAtMs: Number(stableActiveTurnStartedMs),
          latestTurnStatus: "inProgress",
        }),
      },
    }));
  }
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    stableActiveTurnStartedMs,
  );
  await tasksPage.evaluate((element) => {
    const conversation = element.querySelector("caffold-task-conversation");
    conversation.stopActiveTurnClock();
    conversation.connectedCallback();
  });
  const durationAfterReconnect = await activeTurn
    .locator(".task-turn-active-duration")
    .textContent();
  await expect
    .poll(() => activeTurn.locator(".task-turn-active-duration").textContent())
    .not.toBe(durationAfterReconnect);
  const runningTaskRow = tasksPage.locator(
    `.task-row[data-thread-id="${threadId}"]`,
  );
  await expect(runningTaskRow).toHaveAttribute("data-task-status", "running");
  await expect(runningTaskRow).toHaveAttribute("aria-busy", "true");
  await expect(runningTaskRow.locator(".task-status-spinner")).toHaveCount(1);
  if (testInfo.project.name === "desktop") {
    await expect(runningTaskRow.locator(".task-status-spinner")).toBeVisible();
  }
  await expect(followUpTextarea).toBeFocused();
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Please tighten the tests",
    }),
  ).toHaveCount(1);

  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-review-persist-probe", "kept"));
  await followUpTextarea.fill("Keep this draft while reviewing");
  const conversationBeforeDiff = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeDiff.maxScrollTop).toBeGreaterThan(0);
  const taskDetailReadsBeforeDiff = taskDetailReadRequests;
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  await expect(codexWorkspace).toBeVisible();
  await expect(page.locator("caffold-review-workspace")).toBeHidden();
  const taskDiffView = tasksPage.locator(".task-diff-view");
  await expect(taskDiffView).toBeVisible();
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      taskReview.evaluate((review) => Boolean(review.diffWatchUnsubscribe)),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-list-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-master-resizer")).toBeHidden();
  const taskDiffLayout = await tasksPage.evaluate((element) => {
    const pageRect = element.getBoundingClientRect();
    const diffRect = element.querySelector(".task-diff-view").getBoundingClientRect();
    return {
      leftGap: Math.abs(diffRect.left - pageRect.left),
      rightGap: Math.abs(diffRect.right - pageRect.right),
    };
  });
  expect(taskDiffLayout.leftGap).toBeLessThanOrEqual(1);
  expect(taskDiffLayout.rightGap).toBeLessThanOrEqual(1);
  const taskDiffTree = taskDiffView.locator("caffold-git-diff-changes-tree");
  await expect(taskDiffTree.locator("button[data-change-path]")).toHaveCount(4);
  await expect(taskDiffTree.locator('button[data-task-related="true"]')).toHaveCount(3);
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="unrelated.rs"]'),
  ).not.toHaveAttribute("data-task-related", "true");
  await taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  const taskDiffViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
  );
  await expect(taskDiffViewer).toContainText("planner.rs");
  await expect(taskDiffViewer).toContainText(
    "new planner behavior",
  );
  if (testInfo.project.name === "phone") {
    const statusRequestsBeforeViewerRefresh = gitStatusRequests;
    await taskDiffViewer.locator(".viewer-refresh-button").click();
    await expect
      .poll(() => gitStatusRequests)
      .toBeGreaterThan(statusRequestsBeforeViewerRefresh);
  }
  const statusRequestsBeforeWatchChange = gitStatusRequests;
  includeTaskDiffLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 4,
      paths: ["src/live-update.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect.poll(() => gitStatusRequests).toBeGreaterThan(statusRequestsBeforeWatchChange);
  const liveUpdateChange = taskDiffTree.locator(
    'button[data-repo-relative-path="live-update.rs"]',
  );
  await expect(liveUpdateChange).toHaveCount(1);
  if (testInfo.project.name === "phone") {
    await expect(liveUpdateChange).toBeHidden();
  } else {
    await expect(liveUpdateChange).toBeVisible();
  }
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");

  const refsBeforeBranch = gitRefsRequests;
  const compareBeforeBranch = gitCompareRequests;
  await taskDiffView.getByRole("button", { name: "Branch" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "branch");
  await expect.poll(() => gitRefsRequests).toBeGreaterThan(refsBeforeBranch);
  await expect.poll(() => gitCompareRequests).toBeGreaterThan(compareBeforeBranch);
  await expect(taskDiffView.locator("select[data-task-compare-base]")).toHaveValue(
    "origin/main",
  );
  await expect(taskDiffView.locator("[data-task-compare-head]")).toHaveText("main");
  const taskCompareTree = taskDiffView.locator("caffold-git-compare-tree");
  const taskCompareFile = taskCompareTree.locator(
    'button[data-compare-path="src/planner.rs"]',
  );
  await expect(taskCompareFile).toBeVisible();
  await taskCompareFile.click();
  await expect.poll(() => gitCompareDiffRequests).toBeGreaterThan(0);
  const taskCompareViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="branch"] caffold-review-file-viewer',
  );
  await expect(taskCompareViewer).toContainText("new branch behavior");
  await taskDiffView.locator("select[data-task-compare-base]").selectOption("origin/release");
  await expect(taskCompareTree.locator('button[data-compare-path="src/release.rs"]')).toBeVisible();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");

  await taskDiffView.getByRole("button", { name: "Working Tree" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "working");
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");

  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-review-persist-probe",
    "kept",
  );
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      taskReview.evaluate((review) => !review.diffWatchUnsubscribe),
    )
    .toBe(true);
  await expect(followUpTextarea).toHaveValue("Keep this draft while reviewing");
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Ultra",
  );

  if (taskMasterStateBeforeTools) {
    await expect(tasksPage.locator(".tasks-list-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-master-resizer")).toBeVisible();
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(taskMasterStateBeforeTools.listWidth);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(taskMasterStateBeforeTools.listScrollTop);
  }
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeDiff.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(taskDetailReadRequests).toBe(taskDetailReadsBeforeDiff);

  await followUpTextarea.fill("한글 버튼 제출");
  await page.evaluate(() => {
    Object.defineProperty(HTMLFormElement.prototype, "prompt", {
      configurable: true,
      get() {
        throw new Error("Legacy named form access is unavailable");
      },
    });
  });
  await tasksPage.locator('.task-follow-up-form button[type="submit"]').click();
  await expect.poll(() => followUpRequests).toBe(2);
  await expect(followUpTextarea).toHaveValue("");
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await followUpTextarea.fill("Canonical sync unlocks composer");
  await tasksPage.locator('.task-follow-up-form button[type="submit"]').click();
  await canonicalFollowUpRequested;
  await expect.poll(() => followUpRequests).toBe(3);
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "true",
  );

  const canonicalPromptEvent = eventRecord(
    "event_canonical_prompt",
    "user_message",
    "User prompt",
    {
      text: "Canonical sync unlocks composer",
      turnId: "turn_canonical_ack",
      item: {
        content: [{ type: "text", text: "Canonical sync unlocks composer" }],
      },
    },
    30,
  );
  events = [...events, canonicalPromptEvent];
  updateTask({
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    lastEventSummary: "Canonical prompt accepted",
  });
  await page.evaluate((detail) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${detail.task.threadId}/stream`),
    );
    source?.emit("task-sync", {
      threadId: detail.task.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-prompt-ack",
    });
  }, detailResponse({ revision: 20 }));
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await followUpTextarea.fill("Enter after canonical sync");
  await followUpTextarea.press("Enter");
  await expect.poll(() => followUpRequests).toBe(4);
  await expect(followUpTextarea).toHaveValue("");
  releaseCanonicalFollowUpResponse();
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await followUpTextarea.fill("Prompt that fails");
  await followUpTextarea.press("Enter");
  await expect.poll(() => followUpRequests).toBe(5);
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(followUpTextarea).toBeFocused();
  await expect(followUpTextarea).toHaveValue("Prompt that fails");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Prompt that fails",
    }),
  ).toHaveCount(0);

  omitCompletedCommandFromDetail = true;
  const openTaskListButton = tasksPage.locator('[data-task-action="open-list"]');
  if (await openTaskListButton.isVisible()) {
    await openTaskListButton.click();
  }
  await tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`).click();
  await expect(followUpTextarea).toHaveValue("Prompt that fails");
  await tasksPage
    .locator(
      '.task-turn-work:has(.task-work-item[data-event-type="command_execution"]) > details > summary',
    )
    .click();
  await expect(
    tasksPage.locator('.task-work-item[data-event-type="command_execution"]'),
  ).toContainText("test result: ok");
});
