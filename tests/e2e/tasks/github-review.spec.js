import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const THREAD_ID = "thread_linked_worktree_github";
const WORKTREE_ROOT = "Users/taehoon/.codex/worktrees/4ce7/gluesql";

function linkedWorktreeTask() {
  const recencyMs = 1_785_700_000_000;
  return {
    id: THREAD_ID,
    threadId: THREAD_ID,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "테스트, 안녕",
    preview: "Linked worktree GitHub review",
    cwd: "Users/taehoon/Workspace/rust/gluesql",
    cwdPath: "Users/taehoon/Workspace/rust/gluesql",
    relativeCwd: "",
    worktree: {
      rootPath: WORKTREE_ROOT,
      branch: "query-plan-limit-offset",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      relativeCwd: "",
      linked: true,
    },
    createdMs: recencyMs,
    updatedMs: recencyMs,
    recencyMs,
    lastEventSummary: "Linked worktree GitHub review",
  };
}

async function installLinkedWorktreeGithubFixture(page, repositoryContextHandler) {
  await installEventSourceMock(page);
  await mockCodexModels(page);

  const task = linkedWorktreeTask();
  const repository = {
    rootPath: WORKTREE_ROOT,
    branch: "query-plan-limit-offset",
    dirty: false,
  };
  const github = {
    owner: "gluesql",
    name: "gluesql",
    nameWithOwner: "gluesql/gluesql",
    url: "https://github.com/gluesql/gluesql",
  };
  const counts = {
    issues: 0,
    pulls: 0,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [task], nextCursor: null } }),
  );
  await page.route(new RegExp(`/api/tasks/${THREAD_ID}(?:\\?|$)`), (route) =>
    route.fulfill({
      json: {
        threadId: THREAD_ID,
        syncState: "ready",
        revision: 1,
        task,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: false,
        permissionMode: null,
        model: null,
        reasoningEffort: null,
      },
    }),
  );
  await page.route(/\/api\/list(?:\?|$)/, repositoryContextHandler);
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({ json: { repository, additions: 0, deletions: 0, files: [] } }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path !== WORKTREE_ROOT) {
      return route.fulfill({
        json: {
          repository: null,
          github: null,
          ghAvailable: true,
          authenticated: true,
          issuesAvailable: false,
          pullsAvailable: false,
          message: "No GitHub remote detected",
        },
      });
    }
    return route.fulfill({
      json: {
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    counts.pulls += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    return route.fulfill({
      json: {
        repository,
        github,
        state: "open",
        pulls: [
          {
            number: 1983,
            title: "Reject unsupported table function arguments",
            state: "open",
            draft: false,
            author: "kwondo1017",
            labels: [],
            comments: 4,
            updatedAt: "2026-08-03T03:00:00Z",
            url: "https://github.com/gluesql/gluesql/pull/1983",
          },
        ],
        page: 1,
        perPage: 50,
        totalPulls: 53,
        totalPages: 2,
        hasPrevious: false,
        hasNext: true,
      },
    });
  });

  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    counts.issues += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    return route.fulfill({
      json: {
        repository,
        github,
        state: "open",
        issues: [
          {
            number: 1984,
            title: "Keep task GitHub lists fresh",
            state: "open",
            author: "panarch",
            labels: [],
            comments: 0,
            updatedAt: "2026-08-07T03:00:00Z",
            url: "https://github.com/gluesql/gluesql/issues/1984",
          },
        ],
        page: 1,
        perPage: 50,
        totalIssues: 1,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      },
    });
  });

  return { task, repository, github, counts };
}

async function chooseLinkedWorktreeGithubList(page, kind) {
  const summary = page.locator("caffold-task-detail-summary");
  await expect(summary).toContainText("query-plan-limit-offset · gluesql");
  await summary
    .locator('.task-review-menu summary[aria-label="Open GitHub workspace"]')
    .click();
  await summary
    .locator(
      `button[data-summary-action="open-github-tool"][data-review-kind="${kind}"]`,
    )
    .click();
}

async function openLinkedWorktreePullRequests(page) {
  await page.goto(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect(page).toHaveURL(
    `/github/pulls?cwd=${encodeURIComponent(WORKTREE_ROOT)}`,
  );
}

test("refreshes GitHub lists when reopened from the task menu", async ({ page }) => {
  let repository;
  const fixture = await installLinkedWorktreeGithubFixture(page, (route) =>
    route.fulfill({
      json: {
        root: "Users/taehoon",
        path: WORKTREE_ROOT,
        git: repository,
        entries: [],
      },
    }),
  );
  repository = fixture.repository;

  await openLinkedWorktreePullRequests(page);
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Reject unsupported table function arguments",
  );
  expect(fixture.counts.pulls).toBe(1);

  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect.poll(() => fixture.counts.pulls).toBe(2);

  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  expect(fixture.counts.issues).toBe(1);

  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect.poll(() => fixture.counts.issues).toBe(2);
});

test("loads pull requests after linked worktree context resolves", async ({ page }) => {
  let resolveContextRequest;
  const contextRequested = new Promise((resolve) => {
    resolveContextRequest = resolve;
  });
  let pendingContextRoute = null;
  const { repository } = await installLinkedWorktreeGithubFixture(page, (route) => {
    pendingContextRoute = route;
    resolveContextRequest();
  });

  await openLinkedWorktreePullRequests(page);
  await contextRequested;

  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText("Loading pull requests...");

  await pendingContextRoute.fulfill({
    json: {
      root: "Users/taehoon",
      path: WORKTREE_ROOT,
      git: repository,
      entries: [],
    },
  });

  await expect(pullsPage.locator(".github-pulls-repo")).toHaveText("gluesql/gluesql");
  await expect(pullsPage.locator(".github-pulls-count")).toHaveText("53 PRs");
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
});

test("shows linked worktree context failures instead of a blank pull request list", async ({
  page,
}) => {
  await installLinkedWorktreeGithubFixture(page, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "repository_context_unavailable",
          message: "Worktree context unavailable",
        },
      },
    }),
  );

  await openLinkedWorktreePullRequests(page);

  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage.locator(".error-panel")).toBeVisible();
  await expect(pullsPage).toContainText("Worktree context unavailable");
});
