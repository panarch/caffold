import { expect } from "@playwright/test";

export async function installTaskReviewFixture(page) {
  let gitStatusRequests = 0;
  let gitRefsRequests = 0;
  let gitCompareRequests = 0;
  let gitCompareDiffRequests = 0;
  let includeLiveFile = false;

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        additions: includeLiveFile ? 6 : 5,
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
  };
}
