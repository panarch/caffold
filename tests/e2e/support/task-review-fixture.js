import { expect } from "@playwright/test";

export async function installTaskReviewFixture(page) {
  let gitStatusRequests = 0;
  let gitRefsRequests = 0;
  let gitCompareRequests = 0;
  let gitCompareDiffRequests = 0;
  let includeLiveFile = false;
  let largeChangeSet = false;
  let edgeCaseFiles = false;
  let cleanWorkingTree = false;
  let cleanBranch = false;
  let failNextGitStatus = false;
  const compareDelays = new Map();

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    if (failNextGitStatus) {
      failNextGitStatus = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture status unavailable" }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        additions: cleanWorkingTree ? 0 : includeLiveFile ? 6 : largeChangeSet ? 185 : 5,
        deletions: cleanWorkingTree ? 0 : 4,
        files: cleanWorkingTree ? [] : [
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
          ...(includeLiveFile
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
          ...(edgeCaseFiles
            ? [
                {
                  path: "src/deleted.rs",
                  repoRelativePath: "deleted.rs",
                  status: " D",
                  category: "unstaged",
                  staged: false,
                  unstaged: true,
                  untracked: false,
                },
                {
                  path: "src/untracked.rs",
                  repoRelativePath: "untracked.rs",
                  status: "??",
                  category: "untracked",
                  staged: false,
                  unstaged: false,
                  untracked: true,
                },
              ]
            : []),
          ...(largeChangeSet
            ? Array.from({ length: 180 }, (_, index) => ({
                path: `src/generated/deep/review/file-${`${index + 1}`.padStart(3, "0")}-with-a-long-review-name.rs`,
                repoRelativePath: `generated/deep/review/file-${`${index + 1}`.padStart(3, "0")}-with-a-long-review-name.rs`,
                status: " M",
                category: "unstaged",
                staged: false,
                unstaged: true,
                untracked: false,
              }))
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
          "@@ -60 +60 @@",
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
          {
            name: "origin/feature/this-is-a-very-long-branch-name-used-for-responsive-review-testing",
            kind: "remote",
          },
        ],
        currentRef: "main",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "main",
      }),
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, async (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const baseRef = url.searchParams.get("base");
    const delay = compareDelays.get(baseRef) ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const path = baseRef === "origin/release" ? "src/release.rs" : "src/planner.rs";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        baseRef,
        headRef: "main",
        additions: cleanBranch ? 0 : baseRef === "origin/release" ? 7 : 3,
        deletions: cleanBranch ? 0 : baseRef === "origin/release" ? 2 : 1,
        files: cleanBranch ? [] : [
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
          "@@ -60 +60 @@",
          "-old branch behavior",
          "+new branch behavior",
        ].join("\n"),
      }),
    });
  });

  return {
    get gitStatusRequests() {
      return gitStatusRequests;
    },
    get gitRefsRequests() {
      return gitRefsRequests;
    },
    get gitCompareRequests() {
      return gitCompareRequests;
    },
    get gitCompareDiffRequests() {
      return gitCompareDiffRequests;
    },
    set includeLiveFile(value) {
      includeLiveFile = value;
    },
    set largeChangeSet(value) {
      largeChangeSet = value;
    },
    set edgeCaseFiles(value) {
      edgeCaseFiles = value;
    },
    set cleanWorkingTree(value) {
      cleanWorkingTree = value;
    },
    set cleanBranch(value) {
      cleanBranch = value;
    },
    set failNextGitStatus(value) {
      failNextGitStatus = value;
    },
    setCompareDelay(baseRef, delayMs) {
      compareDelays.set(baseRef, delayMs);
    },
  };
}
