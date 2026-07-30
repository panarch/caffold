import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  clickHeaderAction,
} from "../support/header-actions.js";
import {
  FILES_HOME_URL,
} from "../support/file-browser-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("restores standalone review routes", async ({ page }) => {
  const repository = { rootPath: "src", branch: "feature/review", dirty: true };
  const commit = {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    shortSha: "abcdef1",
    subject: "Route review state",
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_767_000_000_000,
  };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  let gitStatusRequests = 0;
  let gitCompareRequests = 0;
  let gitCommitRequests = 0;
  let githubIssuesRequests = 0;
  let githubPullsRequests = 0;
  let githubPullRequests = 0;
  let githubPullFilesRequests = 0;
  let listRequests = 0;
  let delayNextListRequest = false;
  let resolveDelayedListStarted = null;
  let releaseDelayedListRequest = null;
  let delayNextIssueRequest = false;
  let resolveDelayedIssueStarted = null;
  let releaseDelayedIssueRequest = null;
  let delayNextPullFilesRequest = false;
  let resolveDelayedPullFilesStarted = null;
  let releaseDelayedPullFilesRequest = null;

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    if (delayNextListRequest) {
      delayNextListRequest = false;
      resolveDelayedListStarted?.();
      resolveDelayedListStarted = null;
      await new Promise((resolve) => {
        releaseDelayedListRequest = resolve;
      });
      releaseDelayedListRequest = null;
    }
    await route.continue();
  });

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: [
          {
            path: "src/example.rs",
            repoRelativePath: "example.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "unstaged",
        diff: [
          "diff --git a/example.rs b/example.rs",
          "index 1111111..2222222 100644",
          "--- a/example.rs",
          "+++ b/example.rs",
          "@@ -1,1 +1,2 @@",
          "-old route line",
          "+new route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "feature/review",
      }),
    }),
  );
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/main");
    const head = url.searchParams.get("head");
    expect(["feature/review", "main"]).toContain(head);
    const files =
      head === "main"
        ? []
        : [
            {
              path: "src/example.rs",
              repoRelativePath: "example.rs",
              status: "M",
            },
          ];

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef: "origin/main",
        headRef: head,
        files,
      }),
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/main");
    expect(url.searchParams.get("head")).toBe("feature/review");
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "origin/main...feature/review",
        diff: [
          "diff --git a/example.rs b/example.rs",
          "@@ -1,1 +1,2 @@",
          "-old compare route line",
          "+new compare route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits: [commit],
        page: 2,
        perPage: 50,
        totalCommits: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    }),
  );
  await page.route(/\/api\/git\/commit(?:\?|$)/, (route) => {
    gitCommitRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commit,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            status: "M",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/commit-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("sha")).toBe(commit.sha);
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        kind: "commit abcdef1",
        diff: [
          "diff --git a/planner/mod.rs b/planner/mod.rs",
          "@@ -1,1 +1,2 @@",
          "-old commit route line",
          "+new commit route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    }),
  );
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    githubIssuesRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: [
          {
            number: 42,
            title: "Route issue detail",
            state: "OPEN",
            author: "Caffold",
            labels: ["routing"],
            assignees: [],
            comments: 1,
            updatedAt: "2026-07-01T10:00:00Z",
            url: "https://github.com/example/caffold/issues/42",
          },
        ],
        page: 2,
        perPage: 50,
        totalIssues: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/issue(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("42");
    if (delayNextIssueRequest) {
      delayNextIssueRequest = false;
      resolveDelayedIssueStarted?.();
      resolveDelayedIssueStarted = null;
      await new Promise((resolve) => {
        releaseDelayedIssueRequest = resolve;
      });
      releaseDelayedIssueRequest = null;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        issue: {
          number: 42,
          title: "Route issue detail",
          state: "OPEN",
          author: "Caffold",
          labels: ["routing"],
          assignees: [],
          comments: 1,
          body: "Route issue body",
          bodyHtml: "<p>Route issue body</p>",
          createdAt: "2026-07-01T08:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          url: "https://github.com/example/caffold/issues/42",
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    githubPullsRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("page")).toBe("2");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: [
          {
            number: 12,
            title: "Route pull request detail",
            state: "open",
            draft: false,
            author: "Caffold",
            labels: ["routing"],
            comments: 2,
            updatedAt: "2026-07-01T10:00:00Z",
            url: "https://github.com/example/caffold/pull/12",
          },
        ],
        page: 2,
        perPage: 50,
        totalPulls: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    githubPullRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        pull: {
          number: 12,
          title: "Route pull request detail",
          state: "OPEN",
          draft: false,
          author: "Caffold",
          labels: ["routing"],
          comments: 1,
          reviews: 1,
          commits: 1,
          additions: 4,
          deletions: 2,
          changedFiles: 1,
          baseRefName: "main",
          headRefName: "feature/pr-route",
          body: "Route PR body",
          bodyHtml: "<p>Route PR body</p>",
          createdAt: "2026-07-01T08:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          url: "https://github.com/example/caffold/pull/12",
          conversationComments: [
            {
              author: "taehoon",
              body: "Conversation route comment",
              bodyHtml: "<p>Conversation route comment</p>",
              createdAt: "2026-07-01T08:30:00Z",
              updatedAt: "2026-07-01T08:30:00Z",
              url: "https://github.com/example/caffold/pull/12#issuecomment-1",
            },
          ],
          reviewComments: [
            {
              author: "codex",
              state: "COMMENTED",
              body: "Review summary route comment",
              bodyHtml: "<p>Review summary route comment</p>",
              submittedAt: "2026-07-01T09:00:00Z",
            },
          ],
          commitSummaries: [
            {
              sha: "1234567890abcdef1234567890abcdef12345678",
              shortSha: "1234567",
              subject: "Route PR commit",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:00:00Z",
              committedAt: "2026-07-01T09:00:00Z",
              url: "https://github.com/example/caffold/commit/1234567",
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, async (route) => {
    githubPullFilesRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    if (delayNextPullFilesRequest) {
      delayNextPullFilesRequest = false;
      resolveDelayedPullFilesStarted?.();
      resolveDelayedPullFilesStarted = null;
      await new Promise((resolve) => {
        releaseDelayedPullFilesRequest = resolve;
      });
      releaseDelayedPullFilesRequest = null;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            previousPath: null,
            status: "M",
            additions: 4,
            deletions: 2,
            changes: 6,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/planner/mod.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/planner/mod.rs",
          },
        ],
        totalFiles: 1,
      }),
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: "M",
        kind: "PR #12",
        diff: [
          "diff --git a/planner/mod.rs b/planner/mod.rs",
          "@@ -1,1 +1,2 @@",
          "-old PR route line",
          "+new PR route line",
        ].join("\n"),
        diffUnavailable: false,
        message: null,
      }),
    });
  });

  delayNextListRequest = true;
  const delayedListStarted = new Promise((resolve) => {
    resolveDelayedListStarted = resolve;
  });
  const directDiffRoute = page.goto("/git/diff?cwd=src&file=example.rs");
  await delayedListStarted;
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-route-surface",
    "review",
  );
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  releaseDelayedListRequest();
  await directDiffRoute;
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  await page.goto("/git/diff?cwd=src");
  await expect(page.locator('button[data-change-path="src/example.rs"]')).toBeVisible();
  const gitStatusRequestsBeforeDiffClick = gitStatusRequests;
  await page.locator('button[data-change-path="src/example.rs"]').click();
  await expect(page).toHaveURL("/git/diff?cwd=src&file=example.rs");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeDiffClick);
  const gitStatusRequestsBeforeDiffBack = gitStatusRequests;
  await page.goBack();
  await expect(page).toHaveURL("/git/diff?cwd=src");
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeDiffBack);

  await page.goto(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview&file=example.rs",
  );
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(page.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(page.locator('select[data-compare-ref="head"]')).toHaveValue("feature/review");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");
  await page.goto("/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview");
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  const compareHeaderActionsSnapshot = await page
    .locator("caffold-header-actions")
    .evaluate((element) => {
      window.__caffoldCompareGitGroupButton = element.querySelector(
        'button[data-action-group="git"]',
      );
      const gitGroupButton = window.__caffoldCompareGitGroupButton;
      return {
        groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
          (button) => button.dataset.actionGroup,
        ),
        gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
      };
    });
  const listRequestsBeforeCompareRefChange = listRequests;
  const gitStatusRequestsBeforeCompareRefChange = gitStatusRequests;
  await page.locator('select[data-compare-ref="head"]').selectOption("main");
  await expect(page).toHaveURL("/git/compare?cwd=src&base=origin%2Fmain&head=main");
  await expect(page.locator("caffold-git-compare-page")).toContainText("0 files");
  expect(listRequests).toBe(listRequestsBeforeCompareRefChange);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeCompareRefChange);
  const compareHeaderActionsState = await page
    .locator("caffold-header-actions")
    .evaluate((element) => {
      const gitGroupButton = element.querySelector('button[data-action-group="git"]');
      return {
        groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
          (button) => button.dataset.actionGroup,
        ),
        gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
        sameGitGroupButton: gitGroupButton === window.__caffoldCompareGitGroupButton,
      };
    });
  expect(compareHeaderActionsState.sameGitGroupButton).toBe(true);
  expect(compareHeaderActionsState.groups).toEqual(compareHeaderActionsSnapshot.groups);
  expect(compareHeaderActionsState.gitGroupButtonHtml).toBe(
    compareHeaderActionsSnapshot.gitGroupButtonHtml,
  );

  await page.locator('select[data-compare-ref="head"]').selectOption("feature/review");
  await expect(page).toHaveURL(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview",
  );
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  const gitCompareRequestsBeforeClick = gitCompareRequests;
  await page.locator('button[data-compare-path="src/example.rs"]').click();
  await expect(page).toHaveURL(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview&file=example.rs",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");
  expect(gitCompareRequests).toBe(gitCompareRequestsBeforeClick);
  const gitCompareRequestsBeforeBack = gitCompareRequests;
  await page.goBack();
  await expect(page).toHaveURL(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview",
  );
  expect(gitCompareRequests).toBe(gitCompareRequestsBeforeBack);

  await page.goto(`/git/log?cwd=src&page=2&sha=${commit.sha}&file=planner%2Fmod.rs`);
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(page.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  await page.goto(`/git/log?cwd=src&page=2&sha=${commit.sha}`);
  await expect(page.locator('button[data-commit-path="src/planner/mod.rs"]')).toBeVisible();
  const gitCommitRequestsBeforeClick = gitCommitRequests;
  await page.locator('button[data-commit-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(`/git/log?cwd=src&page=2&sha=${commit.sha}&file=planner%2Fmod.rs`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  expect(gitCommitRequests).toBe(gitCommitRequestsBeforeClick);
  const gitCommitRequestsBeforeBack = gitCommitRequests;
  await page.goBack();
  await expect(page).toHaveURL(`/git/log?cwd=src&page=2&sha=${commit.sha}`);
  expect(gitCommitRequests).toBe(gitCommitRequestsBeforeBack);
  await page.getByRole("button", { name: "Back to log" }).click();
  await expect(page).toHaveURL("/git/log?cwd=src&page=2");

  delayNextIssueRequest = true;
  const delayedIssueStarted = new Promise((resolve) => {
    resolveDelayedIssueStarted = resolve;
  });
  const githubIssuesRequestsBeforeIssueDetailRoute = githubIssuesRequests;
  const directIssueRoute = page.goto("/github/issues/42?cwd=src&page=2");
  await delayedIssueStarted;
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "issues",
  );
  await expect(page.locator("caffold-github-issues-layout")).toHaveAttribute(
    "data-issues-view",
    "detail",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toBeHidden();
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeIssueDetailRoute);
  releaseDelayedIssueRequest();
  await directIssueRoute;
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText("Route issue body");
  const githubIssuesRequestsBeforeBack = githubIssuesRequests;
  await page.getByRole("button", { name: "Back to issues" }).click();
  await expect(page).toHaveURL("/github/issues?cwd=src&page=2");
  await expect(page.locator('button[data-issue-number="42"]')).toBeVisible();
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeBack + 1);
  const githubIssuesRequestsBeforeIssueClick = githubIssuesRequests;
  await page.locator('button[data-issue-number="42"]').click();
  await expect(page).toHaveURL("/github/issues/42?cwd=src&page=2");
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText("Route issue body");
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeIssueClick);

  delayNextPullFilesRequest = true;
  const delayedPullFilesStarted = new Promise((resolve) => {
    resolveDelayedPullFilesStarted = resolve;
  });
  const githubPullsRequestsBeforePrFileRoute = githubPullsRequests;
  const githubPullRequestsBeforePrFileRoute = githubPullRequests;
  const directPrFileRoute = page.goto(
    "/github/pulls/12/files?cwd=src&page=2&file=planner%2Fmod.rs",
  );
  await delayedPullFilesStarted;
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await expect(page.locator(".github-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "files",
  );
  await expect(page.locator("caffold-github-pull-files-page")).toHaveAttribute(
    "data-detail-view",
    "viewer",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toBeHidden();
  await expect(page.locator("caffold-github-pull-detail-page")).toBeHidden();
  expect(githubPullsRequests).toBe(githubPullsRequestsBeforePrFileRoute);
  expect(githubPullRequests).toBe(githubPullRequestsBeforePrFileRoute);
  releaseDelayedPullFilesRequest();
  await directPrFileRoute;
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(githubPullsRequests).toBe(githubPullsRequestsBeforePrFileRoute);
  expect(githubPullRequests).toBe(githubPullRequestsBeforePrFileRoute);
  await page.goto("/github/pulls/12/files?cwd=src&page=2");
  await expect(page).toHaveURL("/github/pulls/12/files?cwd=src&page=2");
  await expect(page.locator("caffold-github-pull-files-page")).toBeVisible();
  await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  await expect(page.locator('button[data-pull-file-path="src/planner/mod.rs"]')).toBeVisible();
  const githubPullFilesRequestsBeforeFileClick = githubPullFilesRequests;
  await page.locator('button[data-pull-file-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(
    "/github/pulls/12/files?cwd=src&page=2&file=planner%2Fmod.rs",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(githubPullFilesRequests).toBe(githubPullFilesRequestsBeforeFileClick);
  await page.goBack();
  await expect(page).toHaveURL("/github/pulls/12/files?cwd=src&page=2");
  const githubPullRequestsBeforePrBack = githubPullRequests;
  await page.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL("/github/pulls/12?cwd=src&page=2");
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText("Route PR body");
  expect(githubPullRequests).toBe(githubPullRequestsBeforePrBack + 1);
  const githubPullsRequestsBeforeBack = githubPullsRequests;
  await page.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL("/github/pulls?cwd=src&page=2");
  await expect(page.locator('button[data-pull-number="12"]')).toBeVisible();
  expect(githubPullsRequests).toBe(githubPullsRequestsBeforeBack + 1);
  await page.locator('button[data-pull-number="12"]').click();
  await expect(page).toHaveURL("/github/pulls/12?cwd=src&page=2");
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText("Route PR body");

  await page.goto("/git/diff?cwd=src&file=example.rs");
  await expect(page).toHaveURL("/git/diff?cwd=src&file=example.rs");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");

  await page.goto(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview&file=example.rs",
  );
  await expect(page.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(page.locator('select[data-compare-ref="head"]')).toHaveValue("feature/review");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");

  await page.goto(
    `/git/log?cwd=src&page=2&sha=${commit.sha}&file=planner%2Fmod.rs`,
  );
  await expect(page.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");

  await page.goto("/github/issues/42?cwd=src");
  await expect(page.locator("caffold-github-issues-layout")).toHaveAttribute(
    "data-issues-view",
    "detail",
  );
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText(
    "Route issue body",
  );

  await page.goto("/github/pulls/12/files?cwd=src&page=2&file=planner%2Fmod.rs");
  await expect(page.locator("caffold-github-pull-files-page")).toHaveAttribute(
    "data-detail-view",
    "viewer",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
});

test("reloads active review modes when the directory context changes", async ({ page }) => {
  const repository = { rootPath: "src", branch: "main", dirty: true };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const gitStatusPaths = [];
  const gitRefsPaths = [];
  const gitComparePaths = [];
  const gitLogPaths = [];
  const githubIssuesPaths = [];
  const githubPullsPaths = [];

  const fileEntry = (name, path) => ({
    name,
    path,
    kind: "file",
    isSymlink: false,
    supported: true,
    gitIgnored: false,
    size: 10,
    modifiedMs: null,
    git: null,
  });
  const directoryEntry = (name, path) => ({
    name,
    path,
    kind: "directory",
    isSymlink: false,
    supported: true,
    gitIgnored: false,
    size: null,
    modifiedMs: null,
    git: null,
  });
  const directories = new Map([
    [
      "",
      {
        root: "tests/fixtures/home",
        path: "",
        entries: [directoryEntry("src", "src")],
        git: null,
      },
    ],
    [
      "src",
      {
        root: "tests/fixtures/home",
        path: "src",
        entries: [
          directoryEntry("planner", "src/planner"),
          fileEntry("example.rs", "src/example.rs"),
        ],
        git: repository,
      },
    ],
    [
      "src/planner",
      {
        root: "tests/fixtures/home",
        path: "src/planner",
        entries: [fileEntry("mod.rs", "src/planner/mod.rs")],
        git: repository,
      },
    ],
  ]);
  const statusFiles = {
    src: [
      {
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        status: " M",
        category: "unstaged",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    "src/planner": [
      {
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: " M",
        category: "unstaged",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
  };
  const compareFiles = {
    src: [
      {
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        status: "M",
      },
    ],
    "src/planner": [
      {
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: "M",
      },
    ],
  };
  const logCommits = {
    src: [
      {
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        subject: "Source context commit",
        body: "",
        authorName: "Caffold",
        authorEmail: "caffold@example.test",
        authorTimeMs: 1_767_000_000_000,
      },
    ],
    "src/planner": [
      {
        sha: "2222222222222222222222222222222222222222",
        shortSha: "2222222",
        subject: "Planner context commit",
        body: "",
        authorName: "Caffold",
        authorEmail: "caffold@example.test",
        authorTimeMs: 1_767_000_001_000,
      },
    ],
  };
  const issuesByPath = {
    src: [
      {
        number: 10,
        title: "Source context issue",
        state: "OPEN",
        author: "Caffold",
        labels: ["source"],
        assignees: [],
        comments: 0,
        updatedAt: "2026-07-01T10:00:00Z",
        url: "https://github.com/example/caffold/issues/10",
      },
    ],
    "src/planner": [
      {
        number: 11,
        title: "Planner context issue",
        state: "OPEN",
        author: "Caffold",
        labels: ["planner"],
        assignees: [],
        comments: 0,
        updatedAt: "2026-07-01T10:01:00Z",
        url: "https://github.com/example/caffold/issues/11",
      },
    ],
  };
  const pullsByPath = {
    src: [
      {
        number: 20,
        title: "Source context pull",
        state: "open",
        draft: false,
        author: "Caffold",
        labels: ["source"],
        comments: 0,
        updatedAt: "2026-07-01T11:00:00Z",
        url: "https://github.com/example/caffold/pull/20",
      },
    ],
    "src/planner": [
      {
        number: 21,
        title: "Planner context pull",
        state: "open",
        draft: false,
        author: "Caffold",
        labels: ["planner"],
        comments: 0,
        updatedAt: "2026-07-01T11:01:00Z",
        url: "https://github.com/example/caffold/pull/21",
      },
    ],
  };

  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    const directory = directories.get(path);
    expect(directory, `mocked directory for ${path}`).toBeTruthy();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(directory),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    }),
  );
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitStatusPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: statusFiles[path] ?? [],
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitRefsPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "feature/review",
      }),
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitComparePaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef: url.searchParams.get("base") ?? "origin/main",
        headRef: url.searchParams.get("head") ?? "feature/review",
        files: compareFiles[path] ?? [],
      }),
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitLogPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits: logCommits[path] ?? [],
        page: 1,
        perPage: 50,
        totalCommits: (logCommits[path] ?? []).length,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    githubIssuesPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: issuesByPath[path] ?? [],
        page: 1,
        perPage: 50,
        totalIssues: (issuesByPath[path] ?? []).length,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    githubPullsPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: pullsByPath[path] ?? [],
        page: 1,
        perPage: 50,
        totalPulls: (pullsByPath[path] ?? []).length,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });

  const loadDirectory = async (path) => {
    await page.locator("caffold-app-shell").evaluate(
      (shell, nextPath) => shell.loadDirectory(nextPath),
      path,
    );
  };
  const expectLastPath = async (calls, path) => {
    await expect.poll(() => calls.at(-1) ?? "").toBe(path);
  };

  await page.goto(FILES_HOME_URL);

  await loadDirectory("src");
  await expectLastPath(gitStatusPaths, "src");
  await clickHeaderAction(page, "git", "open-diff-workspace");
  await expect(page.locator('button[data-change-path="src/example.rs"]')).toBeVisible();
  await loadDirectory("src/planner");
  await expectLastPath(gitStatusPaths, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(page.locator('button[data-change-path="src/planner/mod.rs"]')).toBeVisible();
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "git", "open-compare-workspace");
  await expectLastPath(gitRefsPaths, "src");
  await expectLastPath(gitComparePaths, "src");
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  await loadDirectory("src/planner");
  await expectLastPath(gitRefsPaths, "src/planner");
  await expectLastPath(gitComparePaths, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(page.locator('button[data-compare-path="src/planner/mod.rs"]')).toBeVisible();
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "git", "open-log-workspace");
  await expectLastPath(gitLogPaths, "src");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Source context commit");
  await loadDirectory("src/planner");
  await expectLastPath(gitLogPaths, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Planner context commit");
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "github", "open-github-issues-workspace");
  await expectLastPath(githubIssuesPaths, "src");
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Source context issue",
  );
  await loadDirectory("src/planner");
  await expectLastPath(githubIssuesPaths, "src/planner");
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Planner context issue",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "github", "open-github-pulls-workspace");
  await expectLastPath(githubPullsPaths, "src");
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Source context pull",
  );
  await loadDirectory("src/planner");
  await expectLastPath(githubPullsPaths, "src/planner");
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "pulls",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Planner context pull",
  );
});
