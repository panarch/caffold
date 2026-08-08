import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
  installEventSourceMock,
  scrollTop,
} from "../support/task-fixtures.js";
import {
  headerActionGroupButton,
  openHeaderActionGroup,
  expectFileTreeDensity,
} from "../support/header-actions.js";
import {
  elementWidth,
  dragHorizontalResizer,
  expectPreservedScroll,
  expectHorizontalScroller,
  expectMobileReviewDetail,
  expectUnifiedDiffRowsShareScrollWidth,
  expectDiffScrollerFillsViewer,
  expectCompareRefControlsFit,
  expectAlignedWorkspaceHeaders,
  expectMatchingPaneTitleSizes,
} from "../support/review-layout.js";
import {
  FILES_HOME_URL,
} from "../support/file-browser-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("opens changed diffs from Changes mode", async ({ page }, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__caffoldMockEventSources",
    autoOpen: true,
  });
  const longContextLine = ` context line ${"long-diff-token-".repeat(36)}`;
  const repository = { rootPath: "src", branch: "main", dirty: true };
  let delayNextStatus = false;
  let delayNextDiff = false;
  let statusRequests = 0;
  let diffRequests = 0;
  let currentDiffLine = "new line";
  let resolveStatusStarted;
  let releaseStatus;
  let resolveDiffStarted;
  let releaseDiff;

  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    statusRequests += 1;
    if (delayNextStatus) {
      delayNextStatus = false;
      resolveStatusStarted?.();
      await new Promise((resolve) => {
        releaseStatus = resolve;
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        additions: 6540,
        deletions: 19618,
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
            path: "src/new-file.rs",
            repoRelativePath: "new-file.rs",
            status: "??",
            category: "untracked",
            staged: false,
            unstaged: false,
            untracked: true,
          },
        ],
      }),
    });
  });

  await page.route(/\/api\/git\/diff(?:\?|$)/, async (route) => {
    diffRequests += 1;
    if (delayNextDiff) {
      delayNextDiff = false;
      resolveDiffStarted?.();
      await new Promise((resolve) => {
        releaseDiff = resolve;
      });
    }
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    const kind = url.searchParams.get("kind");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        kind,
        diff:
          kind === "untracked"
            ? [
                "diff --git a/new-file.rs b/new-file.rs",
                "new file mode 100644",
                "index 0000000..1111111",
                "--- /dev/null",
                "+++ b/new-file.rs",
                "@@ -0,0 +1,2 @@",
                "+pub fn new_file() {}",
                "+// new file line",
              ].join("\n")
            : [
                `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
                "index 1111111..2222222 100644",
                `--- a/${file.replace(/^src\//, "")}`,
                `+++ b/${file.replace(/^src\//, "")}`,
                "@@ -10,4 +10,5 @@ pub fn sample()",
                longContextLine,
                "-old line",
                `+${currentDiffLine}`,
                "+another line",
                " trailing line",
              ].join("\n"),
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('caffold-file-list button[data-file-tree-path="src"]').click();

  const gitButton = headerActionGroupButton(page, "git");
  await expect(gitButton).toBeVisible();
  await expect(page.locator("caffold-pathbar .header-action-button")).toHaveCount(0);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("3");
  await expect(gitButton.locator("img.header-action-brand-icon")).toBeVisible();
  await expect(gitButton.locator("img.header-action-brand-icon")).toHaveAttribute(
    "src",
    "/assets/brand/git-logomark-light.svg",
  );
  await expect(gitButton).not.toContainText("master");
  await expect(gitButton).toHaveAttribute("title", "Git actions, 3 changed files");

  const gitPopover = await openHeaderActionGroup(page, "git");
  const diffMenuItem = gitPopover.locator('button[data-action="open-diff-workspace"]');
  await expect(diffMenuItem.locator(".header-menu-label")).toHaveText("Diff");
  await expect(diffMenuItem.locator(".header-menu-metric")).toHaveText("3");
  await diffMenuItem.click();
  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "git");
  await expect(workspace.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(workspace.getByRole("button", { name: "Refresh diff" })).toBeVisible();
  const statusStarted = new Promise((resolve) => {
    resolveStatusStarted = resolve;
  });
  delayNextStatus = true;
  const refreshDiff = workspace.getByRole("button", { name: "Refresh diff" });
  await refreshDiff.click();
  await statusStarted;
  await expect(refreshDiff).toHaveClass(/is-refreshing/);
  releaseStatus();
  await expect(refreshDiff).not.toHaveClass(/is-refreshing/);
  await expect(workspace.getByRole("button", { name: "Close review workspace" })).toBeVisible();
  await expect(page.locator("caffold-git-diff-page")).toContainText("Unstaged");
  await expect(page.locator("caffold-git-diff-page")).not.toContainText("Untracked");
  await expect(page.locator("caffold-git-diff-page")).toContainText("example.rs");
  await expect(page.locator("caffold-git-diff-page")).toContainText("deleted.rs");
  await expect(page.locator("caffold-git-diff-page")).toContainText("new-file.rs");
  await expect(
    page.locator("caffold-git-diff-changes-tree .change-line-stats .is-addition"),
  ).toHaveText("+6,540");
  await expect(
    page.locator("caffold-git-diff-changes-tree .change-line-stats .is-deletion"),
  ).toHaveText("-19,618");
  const changesTree = page.locator("caffold-git-diff-changes-tree");
  await expect(changesTree.locator('button[data-file-tree-path="src/new-file.rs"] .file-tree-status-code')).toHaveText(
    "A",
  );
  await expectFileTreeDensity(
    page,
    changesTree.locator('button[data-file-tree-path="src/new-file.rs"]'),
  );
  await captureReviewScreenshot(page, testInfo, "diff-changes-summary");
  if (testInfo.project.name !== "phone") {
    const resizeHandle = workspace.locator(".git-mode-diff .git-diff-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "caffold-git-diff-page caffold-git-diff-browser > caffold-git-diff-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "caffold-git-diff-page caffold-git-diff-browser > caffold-git-diff-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }

  await changesTree.locator('button[data-file-tree-path="src/example.rs"]').click();
  await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toContainText(
    "example.rs",
  );
  await expect(page.locator(".git-mode-diff .viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to changes",
      detailSelector: ".git-mode-diff caffold-review-file-viewer",
      listSelector: "caffold-git-diff-changes-tree",
      sharedFileViewer: true,
      viewerRefresh: true,
    });
  } else {
    await expect(
      page.locator(".git-mode-diff caffold-review-file-viewer .viewer-refresh-button"),
    ).toBeHidden();
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-git-diff-changes-tree .changes-tree-panel > header",
      ".git-mode-diff caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-git-diff-changes-tree .changes-tree-panel > header",
      ".git-mode-diff caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await expect(page.locator("caffold-diff-viewer")).toContainText("@@ -10,4 +10,5 @@");
  await expect(page.locator("caffold-diff-viewer")).toContainText("old line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new line");
  const visibleDiff = page.locator("caffold-diff-viewer");
  const changesScroller = changesTree.locator(".file-tree-scroll");
  const unchangedRow = changesTree.locator(
    'button[data-file-tree-path="src/example.rs"]',
  );
  await visibleDiff.evaluate((element) => {
    element.dataset.unrelatedWatchProbe = "kept";
  });
  await changesScroller.evaluate((element) => {
    element.dataset.unrelatedWatchProbe = "kept";
  });
  await unchangedRow.evaluate((button) => {
    button.closest("li").unrelatedWatchProbe = true;
  });
  const statusBeforeUnrelatedWatch = statusRequests;
  const diffBeforeUnrelatedWatch = diffRequests;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 8,
      paths: ["src/deleted.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect.poll(() => statusRequests).toBeGreaterThan(statusBeforeUnrelatedWatch);
  expect(diffRequests).toBe(diffBeforeUnrelatedWatch);
  await expect(visibleDiff).toHaveAttribute("data-unrelated-watch-probe", "kept");
  await expect(changesScroller).toHaveAttribute("data-unrelated-watch-probe", "kept");
  expect(
    await unchangedRow.evaluate(
      (button) => button.closest("li").unrelatedWatchProbe === true,
    ),
  ).toBe(true);
  await expectHorizontalScroller(page, "caffold-diff-viewer .diff-lines");
  await expectUnifiedDiffRowsShareScrollWidth(page);
  await expectDiffScrollerFillsViewer(page);
  await captureReviewScreenshot(page, testInfo, "diff-viewer-horizontal-scroll");

  const contextRow = page.locator(".diff-row-context").filter({ hasText: "context line" });
  await expect(contextRow.locator(".diff-old-line")).toHaveText("10");
  await expect(contextRow.locator(".diff-new-line")).toHaveText("10");

  const removedRow = page.locator(".diff-row-removed").filter({ hasText: "old line" });
  await expect(removedRow.locator(".diff-old-line")).toHaveText("11");
  await expect(removedRow.locator(".diff-new-line")).toHaveText("");
  await expect(removedRow.locator(".diff-prefix")).toHaveText("-");

  const addedRow = page.locator(".diff-row-added").filter({ hasText: "new line" });
  await expect(addedRow.locator(".diff-old-line")).toHaveText("");
  await expect(addedRow.locator(".diff-new-line")).toHaveText("11");
  await expect(addedRow.locator(".diff-prefix")).toHaveText("+");

  const trailingRow = page.locator(".diff-row-context").filter({ hasText: "trailing line" });
  await expect(trailingRow.locator(".diff-old-line")).toHaveText("12");
  await expect(trailingRow.locator(".diff-new-line")).toHaveText("13");

  const diffStarted = new Promise((resolve) => {
    resolveDiffStarted = resolve;
  });
  currentDiffLine = "refreshed line";
  delayNextDiff = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 9,
      paths: ["src/example.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await diffStarted;
  await expect(visibleDiff).toContainText("new line");
  await expect(page.locator(".git-mode-diff .surface-message")).toHaveCount(0);
  releaseDiff();
  await expect(page.locator("caffold-diff-viewer")).toContainText("refreshed line");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(page.locator("caffold-git-diff-page")).toBeVisible();
    await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toBeHidden();
  }
  await page.locator('button[data-file-tree-path="src/deleted.rs"]').click();
  await expect(page.locator(".git-mode-diff .viewer-subtitle")).toHaveText(
    "Deleted · Unstaged",
  );
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(workspace.locator(".git-mode-diff")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(page.locator("caffold-git-diff-page")).toBeVisible();
    await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toBeHidden();
    await expect(page.locator('button[data-file-tree-path="src/deleted.rs"]')).toHaveAttribute(
      "aria-current",
      "false",
    );
  }

  await page.locator('button[data-file-tree-path="src/new-file.rs"]').click();
  await expect(page.locator(".git-mode-diff .viewer-subtitle")).toHaveText("Added");
  await expect(page.locator("caffold-diff-viewer")).toContainText("pub fn new_file");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
  }

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
  await expect(page.locator("caffold-file-list")).toBeVisible();
});

test("opens branch compare diffs", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "feature/review", dirty: false };
  const baseRef =
    "origin/codex/replace-coverage-badges-with-shields-for-very-long-base-branch-name";
  const headRef =
    "origin/codex/add-column-selection-to-scan-data-and-implement-in-parquet-review-flow-with-extra-long-head-reference-for-layout";
  const compareRefs = {
    repository,
    refs: [
      { name: "HEAD", kind: "head" },
      { name: "feature/review", kind: "local" },
      { name: "main", kind: "local" },
      { name: "origin/main", kind: "remote" },
      { name: baseRef, kind: "remote" },
      { name: headRef, kind: "remote" },
      { name: "origin/release", kind: "remote" },
    ],
    currentRef: "feature/review",
    defaultBaseRef: baseRef,
    defaultHeadRef: headRef,
  };

  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(compareRefs),
    });
  });

  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    const baseRef = url.searchParams.get("base");
    const headRef = url.searchParams.get("head");
    const changedPath =
      baseRef === "origin/release" ? "src/runtime/release.rs" : "src/planner/function.rs";
    const files =
      baseRef === headRef
        ? []
        : [
            {
              path: changedPath,
              repoRelativePath: changedPath.replace(/^src\//, ""),
              status: baseRef === "origin/release" ? "A" : "M",
            },
            {
              path: "src/runtime/new.rs",
              repoRelativePath: "runtime/new.rs",
              status: "A",
            },
          ];

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef,
        headRef,
        additions: files.length === 0 ? 0 : baseRef === "origin/release" ? 7 : 5,
        deletions: files.length === 0 ? 0 : baseRef === "origin/release" ? 3 : 2,
        files,
      }),
    });
  });

  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/release");
    expect(url.searchParams.get("head")).toBe(headRef);
    expect(url.searchParams.get("file")).toBe("src/runtime/release.rs");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/runtime/release.rs",
        repoRelativePath: "runtime/release.rs",
        kind: `origin/release...${headRef}`,
        diff: [
          "diff --git a/runtime/release.rs b/runtime/release.rs",
          "index 1111111..2222222 100644",
          "--- a/runtime/release.rs",
          "+++ b/runtime/release.rs",
          "@@ -1,1 +1,2 @@",
          "-old compare line",
          "+new compare line",
          "+another compare line",
        ].join("\n"),
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-file-tree-path="src"]').click();

  const gitPopover = await openHeaderActionGroup(page, "git");
  const compareButton = gitPopover.locator('button[data-action="open-compare-workspace"]');
  await expect(compareButton.locator(".header-menu-label")).toHaveText("Compare");
  await expect(compareButton).toHaveAttribute("title", "Open Compare");
  await compareButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "git");
  await expect(workspace.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Compare");
  await expect(workspace.getByRole("button", { name: "Refresh compare" })).toBeVisible();
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "2 files",
  );
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue(
    baseRef,
  );
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(
    headRef,
  );
  const gitReviewControls = workspace.locator("caffold-git-review-controls");
  await expect(gitReviewControls).toBeVisible();
  const headRefSelect = gitReviewControls.locator('select[data-compare-ref="head"]');
  await headRefSelect.focus();
  await expect(headRefSelect).toBeFocused();
  await gitReviewControls.evaluate((controls) => {
    controls.dataset.regressionInstance = "stable";
    controls.addEventListener("caffold:refresh-git-review", () => {
      window.__caffoldGitRefreshIntentCount =
        (window.__caffoldGitRefreshIntentCount ?? 0) + 1;
    });
    document.querySelector("caffold-git-review-layout").setRefreshState("refreshing");
  });
  await expect(gitReviewControls).toHaveAttribute("data-regression-instance", "stable");
  await expect(headRefSelect).toBeFocused();
  await page.evaluate(() => {
    document.querySelector("caffold-git-review-layout").setRefreshState("idle");
  });
  await gitReviewControls.getByRole("button", { name: "Refresh compare" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__caffoldGitRefreshIntentCount ?? 0))
    .toBe(1);
  await expect(
    workspace.locator('select[data-compare-ref="head"] optgroup[label="Current"]'),
  ).toHaveCount(1);
  await expectCompareRefControlsFit(page, testInfo, { sameRefCss: true });
  await captureReviewScreenshot(page, testInfo, "compare-long-refs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("2 files");
  await expect(page.locator("caffold-git-compare-page")).toContainText("planner");
  await expect(page.locator("caffold-git-compare-page")).toContainText("function.rs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("new.rs");
  await expect(
    page.locator("caffold-git-compare-tree .compare-line-stats .is-addition"),
  ).toHaveText("+5");
  await expect(
    page.locator("caffold-git-compare-tree .compare-line-stats .is-deletion"),
  ).toHaveText("-2");

  await workspace.locator('select[data-compare-ref="base"]').selectOption("main");
  await workspace.locator('select[data-compare-ref="head"]').selectOption("main");
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("main");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue("main");
  await expectCompareRefControlsFit(page, testInfo, {
    compactRefs: true,
    sameRefCss: true,
    tightRefGaps: true,
  });
  await captureReviewScreenshot(page, testInfo, "compare-empty-short-refs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("0 files");

  await workspace.locator('select[data-compare-ref="base"]').selectOption("origin/main");
  await workspace.locator('select[data-compare-ref="head"]').selectOption("feature/review");
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(
    "feature/review",
  );
  await expectCompareRefControlsFit(page, testInfo, {
    compactRefs: true,
    sameRefCss: true,
  });
  await captureReviewScreenshot(page, testInfo, "compare-short-refs");

  await workspace.locator('select[data-compare-ref="head"]').selectOption(headRef);
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(headRef);
  await expectCompareRefControlsFit(page, testInfo, {
    sameRefCss: true,
    mixedRefs: true,
  });
  await captureReviewScreenshot(page, testInfo, "compare-mixed-refs");
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 2048, height: 900 });
    await expectCompareRefControlsFit(page, testInfo, {
      sameRefCss: true,
      mixedRefs: true,
      visibleHeadRef: true,
    });
    await captureReviewScreenshot(page, testInfo, "compare-mixed-refs-wide");
  }

  await workspace.locator('select[data-compare-ref="base"]').selectOption(
    "origin/release",
  );
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("origin/release");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(headRef);
  await expect(page.locator("caffold-git-compare-page")).toContainText("release.rs");
  await expectFileTreeDensity(
    page,
    page.locator('button[data-file-tree-path="src/runtime/release.rs"]'),
  );

  await page.locator('button[data-file-tree-path="src/runtime/release.rs"]').click();
  await expect(page.locator('button[data-file-tree-path="src/runtime/release.rs"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(".git-mode-compare caffold-review-file-viewer")).toContainText(
    "release.rs",
  );
  await expect(page.locator(".git-mode-compare .viewer-subtitle")).toHaveText(
    `Added · origin/release...${headRef}`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("old compare line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare line");
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to compare",
      detailSelector: ".git-mode-compare caffold-review-file-viewer",
      listSelector: "caffold-git-compare-tree",
      sharedFileViewer: true,
      viewerRefresh: true,
    });
    const compareViewer = page.locator(
      ".git-mode-compare caffold-review-file-viewer",
    );
    await compareViewer.evaluate((viewer) => {
      viewer.addEventListener("caffold:refresh-git-review", () => {
        window.__caffoldViewerRefreshIntentCount =
          (window.__caffoldViewerRefreshIntentCount ?? 0) + 1;
      });
    });
    await compareViewer.locator(".viewer-refresh-button").click();
    await expect
      .poll(() => page.evaluate(() => window.__caffoldViewerRefreshIntentCount ?? 0))
      .toBe(1);
    await page.getByRole("button", { name: "Back to compare" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(workspace.locator(".git-mode-compare")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(page.locator("caffold-git-compare-page")).toBeVisible();
    await expect(page.locator(".git-mode-compare caffold-review-file-viewer")).toBeHidden();
  }
});

test("opens commit diffs from Log mode", async ({ page }, testInfo) => {
  const commit = {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    shortSha: "abcdef1",
    subject: "Update planner function",
    body: "Explain the planner update.\n\nKeep review context visible in the log.",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_767_000_000_000,
  };
  const fillerCommits = Array.from({ length: 49 }, (_, index) => ({
    sha: `feed${index.toString(16).padStart(36, "0")}`,
    shortSha: `feed${index.toString(16).padStart(3, "0")}`,
    subject: `Earlier commit ${index + 1}`,
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_766_000_000_000 - index * 1000,
  }));
  const olderCommits = Array.from({ length: 25 }, (_, index) => ({
    sha: `dead${index.toString(16).padStart(36, "0")}`,
    shortSha: `dead${index.toString(16).padStart(3, "0")}`,
    subject: `Oldest page commit ${index + 1}`,
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_765_000_000_000 - index * 1000,
  }));
  const pageOneCommits = [...fillerCommits, commit];
  const totalCommits = pageOneCommits.length + olderCommits.length;
  const repository = { rootPath: "src", branch: "main", dirty: true };

  await page.route(/\/api\/git\/log(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("perPage") ?? "50");
    const commits = pageNumber === 2 ? olderCommits : pageOneCommits;

    if (pageNumber === 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits,
        page: pageNumber,
        perPage,
        totalCommits,
        totalPages: 2,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < 2,
      }),
    });
  });

  await page.route(/\/api\/git\/commit(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commit,
        additions: 12,
        deletions: 4,
        files: [
          {
            path: "src/planner/function.rs",
            repoRelativePath: "planner/function.rs",
            status: "M",
          },
          {
            path: "src/runtime/lib.rs",
            repoRelativePath: "runtime/lib.rs",
            status: "A",
          },
        ],
      }),
    }),
  );

  await page.route(/\/api\/git\/commit-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        kind: "commit abcdef1",
        diff: [
          `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
          "index 1111111..2222222 100644",
          `--- a/${file.replace(/^src\//, "")}`,
          `+++ b/${file.replace(/^src\//, "")}`,
          "@@ -1,1 +1,2 @@",
          "-old planner line",
          "+new planner line",
          "+another planner line",
        ].join("\n"),
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-file-tree-path="src"]').click();

  const gitPopover = await openHeaderActionGroup(page, "git");
  const logButton = gitPopover.locator('button[data-action="open-log-workspace"]');
  await expect(logButton.locator(".header-menu-label")).toHaveText("Log");
  await expect(logButton).toHaveAttribute("title", "Open Log");
  await logButton.click();
  const workspace = page.locator("caffold-review-workspace");
  const logView = workspace.locator(".git-mode-log");
  const backButton = workspace.locator('button[data-action="back-review-workspace"]');
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "git");
  await expect(workspace.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(workspace.getByRole("button", { name: "Refresh log" })).toBeVisible();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Update planner function");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("abcdef1");
  await expect(page.locator("caffold-git-log-list-page")).toBeVisible();
  await expect(page.locator("caffold-git-log-commit-page")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "log-list");
  const pagination = page.locator("caffold-git-log-list-page caffold-pagination");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(pagination.getByRole("button", { name: "Newest page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Newer page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Oldest page" }).click();
  await page.waitForTimeout(40);
  const preservedLogText = await page.locator("caffold-git-log-list-page").textContent();
  expect(preservedLogText).toContain("Update planner function");
  expect(preservedLogText).not.toContain("Loading log...");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Oldest page commit 1");
  await expect(pagination.getByRole("button", { name: "Older page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Oldest page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Newest page" }).click();
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Update planner function");

  const logEntry = page.locator(
    'caffold-git-log-list-page .log-entry[data-commit-sha="abcdef1234567890abcdef1234567890abcdef12"]',
  );
  const logList = page.locator("caffold-git-log-list-page .log-list");
  await logEntry.scrollIntoViewIfNeeded();
  const beforeLogScroll = await scrollTop(logList);
  expect(beforeLogScroll).toBeGreaterThan(0);
  await expect(logEntry).not.toHaveAttribute("aria-current");
  const bodyToggle = logEntry.getByRole("button", { name: /Expand commit body for abcdef1/ });
  await bodyToggle.click();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(logEntry).not.toHaveAttribute("aria-current");
  await expectPreservedScroll(logList, beforeLogScroll);
  await expect(logEntry.locator(".log-body")).toContainText("Explain the planner update.");
  await expect(logEntry.locator(".log-body")).toContainText("Keep review context visible");
  await logEntry.getByRole("button", { name: /Collapse commit body for abcdef1/ }).click();
  await expect(logEntry.locator(".log-body")).toHaveCount(0);
  await expectPreservedScroll(logList, beforeLogScroll);

  await logEntry.getByRole("button", { name: /Open commit diff for abcdef1/ }).click();
  await expect(logView).toHaveAttribute("data-log-view", "detail");
  await expect(page.locator("caffold-git-log-list-page")).toBeHidden();
  await expect(page.locator("caffold-git-log-commit-page")).toBeVisible();
  await expect(backButton).toBeVisible();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText("abcdef1");
  const commitTree = page.locator("caffold-commit-changes-tree");
  await expect(commitTree).toContainText("2 files");
  await expect(commitTree.locator(".commit-line-stats .is-addition")).toHaveText("+12");
  await expect(commitTree.locator(".commit-line-stats .is-deletion")).toHaveText("-4");
  await expect(commitTree).not.toContainText("Update planner function");
  await expect(commitTree).toContainText("planner");
  await expect(commitTree).toContainText("function.rs");
  const commitFileButton = page.locator('button[data-file-tree-path="src/planner/function.rs"]');
  await expect(commitFileButton).toHaveAttribute("aria-current", "false");
  await expectFileTreeDensity(page, commitFileButton);
  await expect(page.locator(".git-mode-log caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  await captureReviewScreenshot(page, testInfo, "log-commit-detail");
  if (testInfo.project.name === "phone") {
    await expect(logView.locator("caffold-git-log-commit-page")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(commitTree).toBeVisible();
    await expect(page.locator(".git-mode-log caffold-review-file-viewer")).toBeHidden();
  }
  const resizeHandle = workspace.locator(
    "caffold-git-log-commit-page > caffold-review-panel-resizer",
  );
  if (testInfo.project.name !== "phone") {
    await expect(resizeHandle).toBeVisible();
    await expect(resizeHandle).not.toHaveAttribute("resize-target");
    await expect(resizeHandle).toHaveAttribute("aria-valuemin", "180");
  } else {
    await expect(resizeHandle).toBeHidden();
    await expect(page.locator("caffold-git-log-commit-page")).toHaveCSS(
      "--git-log-commit-panel-width",
      "320px",
    );
  }
  if (testInfo.project.name === "foldable") {
    const splitLayout = await page
      .locator("caffold-git-log-commit-page")
      .evaluate((page) => {
        const tree = page.querySelector("caffold-commit-changes-tree");
        const resizer = page.querySelector("caffold-review-panel-resizer");
        const viewer = page.querySelector("caffold-review-file-viewer");
        const treeRect = tree.getBoundingClientRect();
        const resizerRect = resizer.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        return {
          resizerLeft: resizerRect.left,
          resizerRight: resizerRect.right,
          treeBottom: treeRect.bottom,
          treeRight: treeRect.right,
          treeTop: treeRect.top,
          viewerBottom: viewerRect.bottom,
          viewerLeft: viewerRect.left,
          viewerTop: viewerRect.top,
        };
      });
    expect(splitLayout.resizerLeft).toBeGreaterThanOrEqual(
      splitLayout.treeRight - 1,
    );
    expect(splitLayout.viewerLeft).toBeGreaterThanOrEqual(
      splitLayout.resizerRight - 1,
    );
    expect(Math.abs(splitLayout.treeTop - splitLayout.viewerTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(splitLayout.treeBottom - splitLayout.viewerBottom)).toBeLessThanOrEqual(1);
  }
  if (testInfo.project.name === "desktop") {
    const beforeReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace caffold-git-log-commit-page > caffold-commit-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace caffold-git-log-commit-page > caffold-commit-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
    await resizeHandle.focus();
    await resizeHandle.press("Home");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "180");
    await resizeHandle.press("ArrowRight");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "204");
    await expect
      .poll(() =>
        elementWidth(
          page,
          "caffold-review-workspace caffold-git-log-commit-page > caffold-commit-changes-tree",
        ),
      )
      .toBeCloseTo(204, 0);
    const widthOwnership = await page.evaluate(() => {
      const commitPage = document.querySelector("caffold-git-log-commit-page");
      const reviewWorkspace = document.querySelector("caffold-review-workspace");
      return {
        pageWidth: commitPage?.style.getPropertyValue(
          "--git-log-commit-panel-width",
        ),
        workspaceWidth: reviewWorkspace?.style.getPropertyValue(
          "--review-left-panel-width",
        ),
      };
    });
    expect(widthOwnership.pageWidth).toBe("204px");
    expect(widthOwnership.workspaceWidth).toBe("");
  }

  await commitFileButton.click();
  await expect(commitFileButton).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".git-mode-log .viewer-subtitle")).toHaveText(
    "Modified · Commit abcdef1",
  );
  if (testInfo.project.name === "phone") {
    await expect(logView.locator("caffold-git-log-commit-page")).toHaveAttribute(
      "data-detail-view",
      "viewer",
    );
    await expectMobileReviewDetail(page, {
      backName: "Back to commit",
      detailSelector: ".git-mode-log caffold-review-file-viewer",
      listSelector: "caffold-commit-changes-tree",
      sharedFileViewer: true,
      viewerRefresh: true,
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-commit-changes-tree .commit-tree-panel > header",
      ".git-mode-log caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-commit-changes-tree .commit-tree-panel > header",
      ".git-mode-log caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await expect(page.locator("caffold-diff-viewer")).toContainText("old planner line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new planner line");
  await captureReviewScreenshot(page, testInfo, "log-commit-file-diff");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to commit" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(logView.locator("caffold-git-log-commit-page")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(commitTree).toBeVisible();
    await expect(page.locator(".git-mode-log caffold-review-file-viewer")).toBeHidden();
  }
  await backButton.click();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Log");
  await expect(page.locator("caffold-git-log-list-page")).toBeVisible();
  await expect(page.locator("caffold-git-log-commit-page")).toBeHidden();
  await expect(logEntry).not.toHaveAttribute("aria-current");

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
});
