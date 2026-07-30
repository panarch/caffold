import { expect } from "@playwright/test";

export const ROUTE_REPOSITORY = {
  rootPath: "src",
  branch: "feature/review",
  dirty: true,
};

export const ROUTE_COMMIT = {
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  shortSha: "abcdef1",
  subject: "Route review state",
  body: "",
  authorName: "Caffold",
  authorEmail: "caffold@example.test",
  authorTimeMs: 1_767_000_000_000,
};

const ROUTE_GITHUB = {
  owner: "example",
  name: "caffold",
  nameWithOwner: "example/caffold",
  url: "https://github.com/example/caffold",
};

function createRequestGate() {
  let armed = false;
  let signalStarted = null;
  let releaseRequest = null;

  return {
    holdNext() {
      armed = true;
      return new Promise((resolve) => {
        signalStarted = resolve;
      });
    },
    async waitIfArmed() {
      if (!armed) {
        return;
      }
      armed = false;
      signalStarted?.();
      signalStarted = null;
      await new Promise((resolve) => {
        releaseRequest = resolve;
      });
      releaseRequest = null;
    },
    release() {
      expect(releaseRequest, "a delayed request is waiting").toBeTruthy();
      releaseRequest();
    },
  };
}

export async function installStandaloneReviewRouteMocks(page) {
  const counts = {
    list: 0,
    gitStatus: 0,
    gitCompare: 0,
    gitCommit: 0,
    githubIssues: 0,
    githubPulls: 0,
    githubPull: 0,
    githubPullFiles: 0,
  };
  const delays = {
    list: createRequestGate(),
    issue: createRequestGate(),
    pullFiles: createRequestGate(),
  };

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    counts.list += 1;
    await delays.list.waitIfArmed();
    await route.continue();
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    counts.gitStatus += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
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
        repository: ROUTE_REPOSITORY,
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
        repository: ROUTE_REPOSITORY,
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
    counts.gitCompare += 1;
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
        repository: ROUTE_REPOSITORY,
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
        repository: ROUTE_REPOSITORY,
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
        repository: ROUTE_REPOSITORY,
        commits: [ROUTE_COMMIT],
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
    counts.gitCommit += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
        commit: ROUTE_COMMIT,
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
    expect(url.searchParams.get("sha")).toBe(ROUTE_COMMIT.sha);
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
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
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    }),
  );
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    counts.githubIssues += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
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
    await delays.issue.waitIfArmed();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
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
    counts.githubPulls += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("page")).toBe("2");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
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
    counts.githubPull += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
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
    counts.githubPullFiles += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    await delays.pullFiles.waitIfArmed();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
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
        repository: ROUTE_REPOSITORY,
        github: ROUTE_GITHUB,
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

  return { counts, delays };
}
