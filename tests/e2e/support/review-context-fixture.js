import { expect } from "@playwright/test";

const GITHUB_REPOSITORY = {
  owner: "example",
  name: "caffold",
  nameWithOwner: "example/caffold",
  url: "https://github.com/example/caffold",
};

function fileEntry(name, path) {
  return {
    name,
    path,
    kind: "file",
    isSymlink: false,
    supported: true,
    gitIgnored: false,
    size: 10,
    modifiedMs: null,
    git: null,
  };
}

function directoryEntry(name, path) {
  return {
    name,
    path,
    kind: "directory",
    isSymlink: false,
    supported: true,
    gitIgnored: false,
    size: null,
    modifiedMs: null,
    git: null,
  };
}

export async function installReviewContextMocks(page) {
  const repository = { rootPath: "src", branch: "main", dirty: true };
  const paths = {
    gitStatus: [],
    gitRefs: [],
    gitCompare: [],
    gitLog: [],
    githubIssues: [],
    githubPulls: [],
  };
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
        github: GITHUB_REPOSITORY,
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
    paths.gitStatus.push(path);
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
    paths.gitRefs.push(path);
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
    paths.gitCompare.push(path);
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
    paths.gitLog.push(path);
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
    paths.githubIssues.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github: GITHUB_REPOSITORY,
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
    paths.githubPulls.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github: GITHUB_REPOSITORY,
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

  return { paths };
}
