import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { expectDomainBackChrome } from "../support/domain-header.js";
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
const PULL_FILE_PATH = `${WORKTREE_ROOT}/src/review.rs`;

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

async function installLinkedWorktreeGithubFixture(page) {
  await installEventSourceMock(page, {
    registryKey: "__taskGithubEventSources",
  });
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
    issue: 0,
    pulls: 0,
    pull: 0,
    pullFiles: 0,
    pullFile: 0,
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
  await page.route(/\/api\/github\/issue(?:\?|$)/, (route) => {
    counts.issue += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1984");
    return route.fulfill({
      json: {
        repository,
        github,
        issue: {
          number: 1984,
          title: "Keep task GitHub lists fresh",
          state: "OPEN",
          author: "panarch",
          labels: [],
          comments: 0,
          body: "Fresh Task-owned Issue detail",
          bodyHtml: "<p>Fresh Task-owned Issue detail</p>",
          createdAt: "2026-08-07T02:00:00Z",
          updatedAt: "2026-08-07T03:00:00Z",
          url: "https://github.com/gluesql/gluesql/issues/1984",
        },
      },
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    counts.pull += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1983");
    return route.fulfill({
      json: {
        repository,
        github,
        pull: {
          number: 1983,
          title: "Reject unsupported table function arguments",
          state: "OPEN",
          draft: false,
          author: "kwondo1017",
          labels: [],
          comments: 0,
          reviews: 0,
          commits: 1,
          additions: 2,
          deletions: 1,
          changedFiles: 1,
          baseRefName: "main",
          headRefName: "query-plan-limit-offset",
          body: "Task-owned Pull Request detail",
          bodyHtml: "<p>Task-owned Pull Request detail</p>",
          createdAt: "2026-08-03T02:00:00Z",
          updatedAt: "2026-08-03T03:00:00Z",
          url: "https://github.com/gluesql/gluesql/pull/1983",
          conversationComments: [],
          reviewComments: [],
          commitSummaries: [],
        },
      },
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, (route) => {
    counts.pullFiles += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1983");
    return route.fulfill({
      json: {
        repository,
        github,
        number: 1983,
        files: [{
          path: PULL_FILE_PATH,
          repoRelativePath: "src/review.rs",
          previousPath: null,
          previousRepoRelativePath: null,
          status: "M",
          additions: 2,
          deletions: 1,
          changes: 3,
          patchAvailable: true,
          blobUrl: null,
          rawUrl: null,
        }],
        totalFiles: 1,
      },
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    counts.pullFile += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1983");
    expect(url.searchParams.get("file")).toBe(PULL_FILE_PATH);
    return route.fulfill({
      json: {
        repository,
        github,
        number: 1983,
        path: PULL_FILE_PATH,
        repoRelativePath: "src/review.rs",
        status: "M",
        kind: "PR #1983",
        additions: 2,
        deletions: 1,
        diff: "@@ -1 +1,2 @@\n-old review\n+new Task-owned review\n+fresh route",
        diffUnavailable: false,
        message: null,
      },
    });
  });

  return { task, repository, github, counts };
}

async function chooseLinkedWorktreeGithubList(page, kind) {
  const summary = page.locator("caffold-task-detail-summary");
  await expect(summary).toContainText("query-plan-limit-offset");
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
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
}

test("retains the same Task GitHub DOM and refreshes lists when reactivated", async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);

  await openLinkedWorktreePullRequests(page);
  const githubLayout = page.locator("caffold-task-github-layout");
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText(
    "Reject unsupported table function arguments",
  );
  expect(fixture.counts.pulls).toBe(1);
  await githubLayout.evaluate((layout) => {
    layout.dataset.testIdentity = "retained";
  });

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await expect(githubLayout).toBeHidden();
  await expect(githubLayout).toHaveAttribute("data-test-identity", "retained");
  await page.waitForTimeout(150);
  expect(fixture.counts.pulls).toBe(1);

  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect.poll(() => fixture.counts.pulls).toBe(2);
  await expect(githubLayout).toHaveAttribute("data-test-identity", "retained");

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  const issuesPage = page.locator("caffold-github-issues-list-page");
  const domainHeader = githubLayout.locator(
    ":scope > .task-github-surface > .task-domain-header",
  );
  await expect(domainHeader.locator("h2")).toHaveText("Issues");
  await expect(domainHeader.locator(".task-domain-subtitle")).toHaveText(
    "gluesql/gluesql · 1 issues",
  );
  await expect(issuesPage).toContainText("Keep task GitHub lists fresh");
  await expect(issuesPage.locator(".github-issues-panel > header")).toHaveCount(0);
  expect(fixture.counts.issues).toBe(1);

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect.poll(() => fixture.counts.issues).toBe(2);
});

test("keeps loaded GitHub routes stable across unrelated Task stream updates", async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.goto(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");

  const issuesPage = page.locator("caffold-github-issues-list-page");
  await expect(issuesPage).toContainText("Keep task GitHub lists fresh");
  expect(fixture.counts.issues).toBe(1);
  await emitGithubTaskEvent(page, 2);
  await expect(issuesPage).toContainText("Keep task GitHub lists fresh");
  await expect(issuesPage).not.toContainText("Loading issues...");
  expect(fixture.counts.issues).toBe(1);

  await page.locator('button[data-issue-number="1984"]').click();
  const issueDetail = page.locator("caffold-github-issue-detail-page");
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  await expectDomainBackChrome(
    page.locator(
      "caffold-task-github-layout > .task-github-surface > .task-domain-header",
    ),
    "Back to issues",
  );
  expect(fixture.counts.issue).toBe(1);
  await emitGithubTaskEvent(page, 3);
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  expect(fixture.counts.issue).toBe(1);

  await chooseLinkedWorktreeGithubList(page, "pulls");
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  expect(fixture.counts.pulls).toBe(1);
  await emitGithubTaskEvent(page, 4);
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  await expect(pullsPage).not.toContainText("Loading pull requests...");
  expect(fixture.counts.pulls).toBe(1);

  await page.locator('button[data-pull-number="1983"]').click();
  const pullDetail = page.locator("caffold-github-pull-detail-page");
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");
  expect(fixture.counts.pull).toBe(1);
  await emitGithubTaskEvent(page, 5);
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");
  expect(fixture.counts.pull).toBe(1);

  await pullDetail.getByRole("button", { name: "Open files for PR #1983" }).click();
  const pullFile = page.locator(`button[data-file-tree-path="${PULL_FILE_PATH}"]`);
  await expect(pullFile).toBeVisible();
  expect(fixture.counts.pullFiles).toBe(1);
  await emitGithubTaskEvent(page, 6);
  await expect(pullFile).toBeVisible();
  expect(fixture.counts.pullFiles).toBe(1);

  await pullFile.click();
  const pullDiff = page.locator("caffold-github-pull-files-page caffold-diff-viewer");
  await expect(pullDiff).toContainText("new Task-owned review");
  expect(fixture.counts.pullFile).toBe(1);
  await emitGithubTaskEvent(page, 7);
  await expect(pullDiff).toContainText("new Task-owned review");
  expect(fixture.counts.pullFile).toBe(1);
});

test("reloads a Task-scoped GitHub route from canonical Task context", async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/github/pulls`);
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  const domainHeader = page.locator(
    "caffold-task-github-layout > .task-github-surface > .task-domain-header",
  );
  await expect(domainHeader.locator("h2")).toHaveText("Pull Requests");
  await expect(domainHeader.locator(".task-domain-subtitle")).toHaveText(
    "gluesql/gluesql · 53 PRs",
  );
  const domainHeaderGeometry = await domainHeader.evaluate((header) => {
    const headerStyle = getComputedStyle(header);
    const taskHeader = document.querySelector("caffold-task-detail-summary");
    const taskHeaderStyle = getComputedStyle(taskHeader);
    const domainTitleStyle = getComputedStyle(
      header.querySelector(".task-domain-title h2"),
    );
    const taskTitleStyle = getComputedStyle(
      taskHeader.querySelector(".task-detail-heading > h2"),
    );
    return {
      height: header.getBoundingClientRect().height,
      minimumHeight: Number.parseFloat(headerStyle.minHeight),
      paddingMatchesTask:
        Math.abs(
          Number.parseFloat(headerStyle.paddingRight) -
            Number.parseFloat(taskHeaderStyle.paddingRight),
        ) <= 1,
      symmetricPadding:
        Math.abs(
          Number.parseFloat(headerStyle.paddingLeft) -
            Number.parseFloat(headerStyle.paddingRight),
        ) <= 1,
      titleSizeMatchesTask:
        Math.abs(
          Number.parseFloat(domainTitleStyle.fontSize) -
            Number.parseFloat(taskTitleStyle.fontSize),
        ) <= 0.1,
    };
  });
  expect(domainHeaderGeometry.height).toBeCloseTo(
    domainHeaderGeometry.minimumHeight,
    0,
  );
  expect(domainHeaderGeometry).toMatchObject({
    paddingMatchesTask: true,
    symmetricPadding: true,
    titleSizeMatchesTask: true,
  });
  await expect(pullsPage.locator(".github-pulls-panel > header")).toHaveCount(0);
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await expect(page.locator("caffold-review-workspace")).toHaveCount(0);
  expect(fixture.counts.pulls).toBe(1);

  await page.reload();
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  await expect.poll(() => fixture.counts.pulls).toBe(2);
});

test("navigates and reloads Task-scoped Issue, PR, and PR file routes", async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.goto(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues`);
  await page.reload();
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  await page.locator('button[data-issue-number="1984"]').click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues/1984`);
  const issueDetail = page.locator("caffold-github-issue-detail-page");
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");

  await page.goBack();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues`);
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  await page.goForward();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues/1984`);
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  await page.reload();
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  expect(fixture.counts.issue).toBeGreaterThanOrEqual(3);

  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
  await page.locator('button[data-pull-number="1983"]').click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983`);
  const pullDetail = page.locator("caffold-github-pull-detail-page");
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");
  await page.reload();
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");

  await pullDetail.getByRole("button", { name: "Open files for PR #1983" }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983/files`);
  const pullFile = page.locator(`button[data-file-tree-path="${PULL_FILE_PATH}"]`);
  await expect(pullFile).toBeVisible();
  await page.reload();
  await expect(pullFile).toBeVisible();

  await pullFile.click();
  await expect(page).toHaveURL(
    `/tasks/${THREAD_ID}/github/pulls/1983/files?file=src%2Freview.rs`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new Task-owned review",
  );
  await page.reload();
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new Task-owned review",
  );
  expect(fixture.counts.pullFile).toBeGreaterThanOrEqual(2);

  await page.goBack();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983/files`);
  await expect(pullFile).toBeVisible();
  await page.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983`);
  await page.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
});

test("rejects an inactive GitHub list response before the cached child is reactivated", async ({ page }) => {
  await installLinkedWorktreeGithubFixture(page);
  await page.unroute(/\/api\/github\/pulls(?:\?|$)/);
  const pendingRoutes = [];
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    pendingRoutes.push(route);
  });
  await openLinkedWorktreePullRequests(page);
  await expect.poll(() => pendingRoutes.length).toBe(1);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await pendingRoutes[0].fulfill({
    json: githubPullsResponse("Stale pull request"),
  });

  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect.poll(() => pendingRoutes.length).toBe(2);
  await pendingRoutes[1].fulfill({
    json: githubPullsResponse("Fresh pull request"),
  });
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText("Fresh pull request");
  await expect(pullsPage).not.toContainText("Stale pull request");
});

test("stops an older GitHub activation before it loads content for a replaced route", async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.unroute(/\/api\/github\/status(?:\?|$)/);
  const pendingStatus = [];
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    pendingStatus.push(route);
  });

  await page.goto(`/tasks/${THREAD_ID}/github/pulls`);
  await expect.poll(() => pendingStatus.length).toBe(1);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues`);
  await expect.poll(() => pendingStatus.length).toBe(2);

  await pendingStatus[0].fulfill({
    json: githubStatusResponse(fixture.repository, fixture.github),
  });
  await page.waitForTimeout(100);
  expect(fixture.counts.pulls).toBe(0);
  expect(fixture.counts.issues).toBe(0);

  await pendingStatus[1].fulfill({
    json: githubStatusResponse(fixture.repository, fixture.github),
  });
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  expect(fixture.counts.pulls).toBe(0);
  expect(fixture.counts.issues).toBe(1);
});

function githubStatusResponse(repository, github) {
  return {
    repository,
    github,
    ghAvailable: true,
    authenticated: true,
    issuesAvailable: true,
    pullsAvailable: true,
    message: null,
  };
}

function githubPullsResponse(title) {
  return {
    repository: {
      rootPath: WORKTREE_ROOT,
      branch: "query-plan-limit-offset",
      dirty: false,
    },
    github: {
      owner: "gluesql",
      name: "gluesql",
      nameWithOwner: "gluesql/gluesql",
      url: "https://github.com/gluesql/gluesql",
    },
    state: "open",
    pulls: [{
      number: 1983,
      title,
      state: "open",
      draft: false,
      author: "panarch",
      labels: [],
      comments: 0,
      updatedAt: "2026-08-03T03:00:00Z",
      url: "https://github.com/gluesql/gluesql/pull/1983",
    }],
    page: 1,
    perPage: 50,
    totalPulls: 1,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  };
}

async function emitGithubTaskEvent(page, revision) {
  await page.evaluate(({ threadId, revision }) => {
    const source = window.__taskGithubEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    if (!source) {
      throw new Error(`Missing detail stream for ${threadId}`);
    }
    source.emit("task-event", {
      threadId,
      revision,
      event: {
        id: `event_domain_render_${revision}`,
        threadId,
        type: "assistant_message",
        payload: { text: `Task update ${revision}` },
      },
    });
  }, { threadId: THREAD_ID, revision });
}
