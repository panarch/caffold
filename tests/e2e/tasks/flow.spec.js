import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
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
  let fileReads = 0;
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
    "data-workspace-close-visible",
    "",
  );
  await expect(page.locator(".files-surface")).toBeHidden();
  await expect(page.locator("caffold-app-menu")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "tasks-home-new-task-detail");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(
    page.locator("caffold-task-workspace .task-workspace-close"),
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
  await expect(
    page.locator("caffold-task-workspace .task-workspace-close"),
  ).toHaveAttribute("aria-label", "Close new task");
  await page.goBack();
  await expect(page).toHaveURL("/");
  await page.goto("/tasks/new");
  await expect(page).toHaveURL("/tasks/new");
  const prompt = tasksPage.locator('textarea[name="prompt"]');
  const browseCwd = tasksPage.getByRole("button", { name: "Browse Files" });
  const directoryPicker = tasksPage.locator("caffold-task-directory-picker");
  const directoryDialog = directoryPicker.locator("dialog");
  await prompt.fill("Say hello globally");
  await browseCwd.click();
  await expect(directoryDialog).toBeVisible();
  await expect(prompt).toBeVisible();
  await expect(directoryPicker.locator("caffold-file-browser")).toHaveCount(0);
  await expect(
    directoryPicker.locator('button[data-file-tree-path="README.md"]'),
  ).toBeDisabled();
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-new-directory-picker",
  );
  expect(fileReads).toBe(0);
  const cancelCwd = directoryPicker.getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  const chooseCwd = directoryPicker.getByRole("button", {
    name: "Use This Folder",
    exact: true,
  });
  const cwdActionGeometry = await Promise.all(
    [cancelCwd, chooseCwd].map((control) =>
      control.evaluate((element) => {
        const style = getComputedStyle(element);
        const visualStyle = getComputedStyle(element, "::before");
        const bounds = element.getBoundingClientRect();
        const visualTop = Number.parseFloat(visualStyle.top) || 0;
        const visualBottom = Number.parseFloat(visualStyle.bottom) || 0;
        const targetFloor = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--interface-target-floor",
          ),
        ) || 0;
        const hitEdgeY =
          targetFloor >= 39 && bounds.height < 39
            ? bounds.top - 3
            : bounds.top + 1;
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          hitEdgeY,
        );
        return {
          borderRadius: style.borderRadius,
          display: style.display,
          fontSize: style.fontSize,
          hitAtEdge: hit === element || element.contains(hit),
          label: element.textContent.trim(),
          hitLabel: hit?.textContent?.trim() || hit?.className || hit?.tagName || null,
          visualHeight: Math.min(
            bounds.height,
            bounds.height - visualTop - visualBottom,
          ),
        };
      }),
    ),
  );
  expect(cwdActionGeometry[0].borderRadius).toBe(
    cwdActionGeometry[1].borderRadius,
  );
  expect(cwdActionGeometry[0].display).toBe(cwdActionGeometry[1].display);
  expect(cwdActionGeometry[0].fontSize).toBe(cwdActionGeometry[1].fontSize);
  expect(cwdActionGeometry[0].visualHeight).toBeCloseTo(
    cwdActionGeometry[1].visualHeight,
    1,
  );
  expect(
    cwdActionGeometry.every(({ hitAtEdge }) => hitAtEdge),
    JSON.stringify(cwdActionGeometry),
  ).toBe(true);
  await cancelCwd.click();
  await expect(directoryDialog).toBeHidden();
  await expect(prompt).toHaveValue("Say hello globally");
  await expect(browseCwd).toBeFocused();

  await browseCwd.click();
  await expect(directoryDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(directoryDialog).toBeHidden();
  await expect(prompt).toHaveValue("Say hello globally");
  await expect(browseCwd).toBeFocused();

  await browseCwd.click();
  await expect(directoryDialog).toBeVisible();
  await directoryPicker.locator('button[data-file-tree-path="src"]').click();
  await expect(directoryPicker.locator("[data-directory-picker-path]")).toContainText(
    "/src",
  );
  expect(fileReads).toBe(0);
  await chooseCwd.click();
  await expect(directoryDialog).toBeHidden();
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(prompt).toHaveValue("Say hello globally");
  await expect(tasksPage.locator(".task-composer-context")).toContainText("src");
  await prompt.press("Enter");

  await expect.poll(() => createdTaskRequest?.prompt).toBe("Say hello globally");
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");
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
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main");
  await expect(tasksPage.locator(".task-review-menu")).toHaveCount(2);

  const gitReviewMenu = tasksPage.locator(
    '.task-review-menu:has(summary[aria-label="Open Git workspace"])',
  );
  const gitReviewMenuButton = gitReviewMenu.locator("summary");
  await gitReviewMenuButton.click();
  const gitReviewMenuPopover = gitReviewMenu.locator(".task-review-menu-popover");
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

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await tasksPage.locator('caffold-task-review button[data-review-axis="navigator"][data-review-value="files"]').click();
  const taskReview = tasksPage.locator("caffold-task-review");
  if (testInfo.project.name === "phone") {
    await taskReview.evaluate((review) => review.updateAxis("viewer", "source"));
  } else {
    await taskReview
      .locator('button[data-review-axis="viewer"][data-review-value="source"]')
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
test("runs a minimal task from creation through follow-up", async ({ page }) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/files?cwd=${encodeURIComponent(scenario.contextPath)}`);
  await page.locator("caffold-app-menu .app-menu-button").click();
  await page
    .locator('caffold-app-menu button[data-action="open-tasks"]')
    .click();

  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
  await expect(tasksPage).toHaveAttribute("data-task-list-state", "empty");

  const composer = tasksPage.locator(".task-new-form");
  await expect(composer).toBeVisible();
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
