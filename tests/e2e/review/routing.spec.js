import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { clickHeaderAction } from "../support/header-actions.js";
import { FILES_HOME_URL } from "../support/file-browser-fixtures.js";
import {
  ROUTE_COMMIT,
  installStandaloneReviewRouteMocks,
} from "../support/review-route-fixtures.js";
import { installReviewContextMocks } from "../support/review-context-fixture.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

async function loadDirectory(page, path) {
  await page.locator("caffold-app-shell").evaluate(
    (shell, nextPath) => shell.loadDirectory(nextPath),
    path,
  );
}

async function expectLastPath(calls, path) {
  await expect.poll(() => calls.at(-1) ?? "").toBe(path);
}

async function expectViewerHeader(viewer, title, subtitle) {
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText(title);
  await expect(viewer.locator(".viewer-subtitle")).toHaveText(subtitle);
}

test("keeps every review file tree selection full-width and rail-free", async ({
  page,
}, testInfo) => {
  await installStandaloneReviewRouteMocks(page);

  const cases = [
    {
      route: "/git/diff?cwd=src",
      tree: "caffold-git-diff-changes-tree",
      scroller: ".file-tree-scroll",
      entry: 'button[data-file-tree-path="src/example.rs"]',
      rows: ".file-tree-rows",
      path: "src/example.rs",
    },
    {
      route: "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview",
      tree: "caffold-git-compare-tree",
      scroller: ".file-tree-scroll",
      entry: 'button[data-file-tree-path="src/example.rs"]',
      rows: ".file-tree-rows",
      path: "src/example.rs",
    },
    {
      route: `/git/log?cwd=src&page=2&sha=${ROUTE_COMMIT.sha}`,
      tree: "caffold-commit-changes-tree",
      scroller: ".file-tree-scroll",
      entry: 'button[data-file-tree-path="src/planner/mod.rs"]',
      rows: ".file-tree-rows",
      path: "src/planner/mod.rs",
    },
    {
      route: "/github/pulls/12/files?cwd=src&page=2",
      tree: "caffold-github-pull-files-tree",
      scroller: ".file-tree-scroll",
      entry: 'button[data-file-tree-path="src/planner/mod.rs"]',
      rows: ".file-tree-rows",
      path: "src/planner/mod.rs",
    },
  ];

  for (const treeCase of cases) {
    await page.goto(treeCase.route);
    const tree = page.locator(treeCase.tree);
    const entry = tree.locator(treeCase.entry);
    await expect(entry).toBeVisible();
    await tree.evaluate((element, path) => element.setSelectedPath(path), treeCase.path);
    await expect(entry).toHaveAttribute("aria-current", "true");
    await expect(entry).toHaveCSS("background-color", "rgb(229, 229, 229)");

    const fittedMetrics = await entry.evaluate((element, scrollerSelector) => {
      const scroller = element.closest(scrollerSelector);
      const style = getComputedStyle(element);
      return {
        borderLeftWidth: style.borderLeftWidth,
        clientWidth: scroller.clientWidth,
        rowHeight: element.getBoundingClientRect().height,
        rowWidth: element.getBoundingClientRect().width,
        scrollWidth: scroller.scrollWidth,
      };
    }, treeCase.scroller);
    expect(fittedMetrics.borderLeftWidth).toBe("0px");
    expect(Math.abs(fittedMetrics.rowWidth - fittedMetrics.scrollWidth)).toBeLessThanOrEqual(1);
    if (testInfo.project.name === "desktop") {
      expect(fittedMetrics.rowHeight).toBeCloseTo(24, 0);
    } else {
      expect(fittedMetrics.rowHeight).toBeCloseTo(36, 0);
    }

    const wideStyle = await page.addStyleTag({
      content: `${treeCase.tree} ${treeCase.rows} { width: 1400px; }`,
    });
    const overflowMetrics = await entry.evaluate((element, scrollerSelector) => {
      const scroller = element.closest(scrollerSelector);
      scroller.scrollLeft = scroller.scrollWidth;
      return {
        clientWidth: scroller.clientWidth,
        rowWidth: element.getBoundingClientRect().width,
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
      };
    }, treeCase.scroller);
    expect(overflowMetrics.scrollWidth).toBeGreaterThan(overflowMetrics.clientWidth);
    expect(overflowMetrics.scrollLeft).toBeGreaterThan(0);
    expect(Math.abs(overflowMetrics.rowWidth - overflowMetrics.scrollWidth)).toBeLessThanOrEqual(1);
    await wideStyle.evaluate((element) => element.remove());
  }
});

test("keeps diff headers stable while every review surface loads", async ({ page }) => {
  const { delays } = await installStandaloneReviewRouteMocks(page);
  const cases = [
    {
      route: "/git/diff?cwd=src",
      tree: "caffold-git-diff-changes-tree",
      entry: 'button[data-file-tree-path="src/example.rs"]',
      delay: delays.gitDiff,
      viewer: ".git-mode-diff caffold-review-file-viewer",
      title: "example.rs",
      subtitle: "Modified · Unstaged",
      body: "new route line",
    },
    {
      route: "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview",
      tree: "caffold-git-compare-tree",
      entry: 'button[data-file-tree-path="src/example.rs"]',
      delay: delays.compareDiff,
      viewer: ".git-mode-compare caffold-review-file-viewer",
      title: "example.rs",
      subtitle: "Modified · origin/main...feature/review",
      body: "new compare route line",
    },
    {
      route: `/git/log?cwd=src&page=2&sha=${ROUTE_COMMIT.sha}`,
      tree: "caffold-commit-changes-tree",
      entry: 'button[data-file-tree-path="src/planner/mod.rs"]',
      delay: delays.commitDiff,
      viewer: ".git-mode-log caffold-review-file-viewer",
      title: "planner/mod.rs",
      subtitle: "Modified · Commit abcdef1",
      body: "new commit route line",
    },
    {
      route: "/github/pulls/12/files?cwd=src&page=2",
      tree: "caffold-github-pull-files-tree",
      entry: 'button[data-file-tree-path="src/planner/mod.rs"]',
      delay: delays.pullFile,
      viewer: ".github-mode-pulls caffold-review-file-viewer",
      title: "planner/mod.rs",
      subtitle: "Modified · PR #12",
      body: "new PR route line",
    },
  ];

  for (const routeCase of cases) {
    await test.step(routeCase.title + " on " + routeCase.route, async () => {
      await page.goto(routeCase.route);
      const requestStarted = routeCase.delay.holdNext();
      await page.locator(routeCase.tree).locator(routeCase.entry).click();
      await requestStarted;

      const viewer = page.locator(routeCase.viewer);
      await expect(viewer.locator(".surface-message")).toHaveText("Loading file...");
      await expectViewerHeader(viewer, routeCase.title, routeCase.subtitle);

      routeCase.delay.release();
      await expect(viewer.locator("caffold-diff-viewer")).toContainText(routeCase.body);
      await expectViewerHeader(viewer, routeCase.title, routeCase.subtitle);
    });
  }
});

test("restores standalone Changes routes without rebuilding list state", async ({ page }) => {
  const { counts, delays } = await installStandaloneReviewRouteMocks(page);
  const delayedListStarted = delays.list.holdNext();
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
  delays.list.release();
  await directDiffRoute;

  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  await page.goto("/git/diff?cwd=src");
  const changesTree = page.locator("caffold-git-diff-changes-tree");
  await expect(changesTree.locator('button[data-file-tree-path="src/example.rs"]')).toBeVisible();
  const statusRequestsBeforeClick = counts.gitStatus;
  await changesTree.locator('button[data-file-tree-path="src/example.rs"]').click();
  await expect(page).toHaveURL("/git/diff?cwd=src&file=example.rs");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  expect(counts.gitStatus).toBe(statusRequestsBeforeClick);

  const statusRequestsBeforeBack = counts.gitStatus;
  await page.goBack();
  await expect(page).toHaveURL("/git/diff?cwd=src");
  expect(counts.gitStatus).toBe(statusRequestsBeforeBack);
});

test("restores standalone Compare routes and preserves header actions", async ({ page }) => {
  const { counts } = await installStandaloneReviewRouteMocks(page);

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
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new compare route line",
  );

  await page.goto("/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview");
  const compareTree = page.locator("caffold-git-compare-tree");
  await expect(compareTree.locator('button[data-file-tree-path="src/example.rs"]')).toBeVisible();
  const headerSnapshot = await page.locator("caffold-header-actions").evaluate((element) => {
    window.__caffoldCompareGitGroupButton = element.querySelector(
      'button[data-action-group="git"]',
    );
    return {
      groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
        (button) => button.dataset.actionGroup,
      ),
      gitGroupButtonHtml: window.__caffoldCompareGitGroupButton?.outerHTML ?? "",
    };
  });
  const listRequestsBeforeRefChange = counts.list;
  const statusRequestsBeforeRefChange = counts.gitStatus;

  await page.locator('select[data-compare-ref="head"]').selectOption("main");
  await expect(page).toHaveURL("/git/compare?cwd=src&base=origin%2Fmain&head=main");
  await expect(page.locator("caffold-git-compare-page")).toContainText("0 files");
  expect(counts.list).toBe(listRequestsBeforeRefChange);
  expect(counts.gitStatus).toBe(statusRequestsBeforeRefChange);
  const headerAfterRefChange = await page
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
  expect(headerAfterRefChange).toEqual({
    ...headerSnapshot,
    sameGitGroupButton: true,
  });

  await page.locator('select[data-compare-ref="head"]').selectOption("feature/review");
  await expect(page).toHaveURL(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview",
  );
  await expect(compareTree.locator('button[data-file-tree-path="src/example.rs"]')).toBeVisible();
  const compareRequestsBeforeClick = counts.gitCompare;
  await compareTree.locator('button[data-file-tree-path="src/example.rs"]').click();
  await expect(page).toHaveURL(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview&file=example.rs",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new compare route line",
  );
  expect(counts.gitCompare).toBe(compareRequestsBeforeClick);

  const compareRequestsBeforeBack = counts.gitCompare;
  await page.goBack();
  await expect(page).toHaveURL(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview",
  );
  expect(counts.gitCompare).toBe(compareRequestsBeforeBack);
});

test("restores standalone Log routes without rebuilding commit state", async ({ page }) => {
  const { counts } = await installStandaloneReviewRouteMocks(page);
  const commitRoute = `/git/log?cwd=src&page=2&sha=${ROUTE_COMMIT.sha}`;

  await page.goto(`${commitRoute}&file=planner%2Fmod.rs`);
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

  await page.goto(commitRoute);
  const commitTree = page.locator("caffold-commit-changes-tree");
  await expect(commitTree.locator('button[data-file-tree-path="src/planner/mod.rs"]')).toBeVisible();
  const commitRequestsBeforeClick = counts.gitCommit;
  await commitTree.locator('button[data-file-tree-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(`${commitRoute}&file=planner%2Fmod.rs`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  expect(counts.gitCommit).toBe(commitRequestsBeforeClick);

  const commitRequestsBeforeBack = counts.gitCommit;
  await page.goBack();
  await expect(page).toHaveURL(commitRoute);
  expect(counts.gitCommit).toBe(commitRequestsBeforeBack);
  await page.getByRole("button", { name: "Back to log" }).click();
  await expect(page).toHaveURL("/git/log?cwd=src&page=2");
});

test("restores standalone GitHub issue routes before list state loads", async ({ page }) => {
  const { counts, delays } = await installStandaloneReviewRouteMocks(page);
  const delayedIssueStarted = delays.issue.holdNext();
  const issueRequestsBeforeDetail = counts.githubIssues;
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
  expect(counts.githubIssues).toBe(issueRequestsBeforeDetail);
  delays.issue.release();
  await directIssueRoute;
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText(
    "Route issue body",
  );

  const issueRequestsBeforeBack = counts.githubIssues;
  await page.getByRole("button", { name: "Back to issues" }).click();
  await expect(page).toHaveURL("/github/issues?cwd=src&page=2");
  await expect(page.locator('button[data-issue-number="42"]')).toBeVisible();
  expect(counts.githubIssues).toBe(issueRequestsBeforeBack + 1);
  const issueRequestsBeforeClick = counts.githubIssues;
  await page.locator('button[data-issue-number="42"]').click();
  await expect(page).toHaveURL("/github/issues/42?cwd=src&page=2");
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText(
    "Route issue body",
  );
  expect(counts.githubIssues).toBe(issueRequestsBeforeClick);
});

test("restores standalone GitHub pull file routes before parent state loads", async ({
  page,
}) => {
  const { counts, delays } = await installStandaloneReviewRouteMocks(page);
  const delayedPullFilesStarted = delays.pullFiles.holdNext();
  const pullsBeforeFileRoute = counts.githubPulls;
  const pullBeforeFileRoute = counts.githubPull;
  const directPullFileRoute = page.goto(
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
  expect(counts.githubPulls).toBe(pullsBeforeFileRoute);
  expect(counts.githubPull).toBe(pullBeforeFileRoute);
  delays.pullFiles.release();
  await directPullFileRoute;
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(counts.githubPulls).toBe(pullsBeforeFileRoute);
  expect(counts.githubPull).toBe(pullBeforeFileRoute);

  await page.goto("/github/pulls/12/files?cwd=src&page=2");
  await expect(
    page.locator(".github-mode-pulls caffold-review-file-viewer"),
  ).toContainText("Select a file to inspect it.");
  await expect(
    page
      .locator("caffold-github-pull-files-tree")
      .locator('button[data-file-tree-path="src/planner/mod.rs"]'),
  ).toBeVisible();
  const pullFilesBeforeClick = counts.githubPullFiles;
  await page
    .locator("caffold-github-pull-files-tree")
    .locator('button[data-file-tree-path="src/planner/mod.rs"]')
    .click();
  await expect(page).toHaveURL(
    "/github/pulls/12/files?cwd=src&page=2&file=planner%2Fmod.rs",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(counts.githubPullFiles).toBe(pullFilesBeforeClick);
  await page.goBack();
  await expect(page).toHaveURL("/github/pulls/12/files?cwd=src&page=2");

  const pullBeforeBack = counts.githubPull;
  await page.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL("/github/pulls/12?cwd=src&page=2");
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText(
    "Route PR body",
  );
  expect(counts.githubPull).toBe(pullBeforeBack + 1);
  const pullsBeforeBack = counts.githubPulls;
  await page.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL("/github/pulls?cwd=src&page=2");
  await expect(page.locator('button[data-pull-number="12"]')).toBeVisible();
  expect(counts.githubPulls).toBe(pullsBeforeBack + 1);
  await page.locator('button[data-pull-number="12"]').click();
  await expect(page).toHaveURL("/github/pulls/12?cwd=src&page=2");
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText(
    "Route PR body",
  );
});

test("refreshes GitHub lists on header re-entry without reloading on internal back", async ({
  page,
}) => {
  const { counts } = await installStandaloneReviewRouteMocks(page);

  await page.goto("/github/issues?cwd=src&page=2");
  await expect(page.locator('button[data-issue-number="42"]')).toBeVisible();
  const issueRequestsBeforeHeaderEntry = counts.githubIssues;

  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL("/files?cwd=src");
  await clickHeaderAction(page, "github", "open-github-issues-workspace");
  await expect.poll(() => counts.githubIssues).toBe(issueRequestsBeforeHeaderEntry + 1);
  await expect(page).toHaveURL("/github/issues?cwd=src&page=2");

  const issueRequestsBeforeSameRouteEntry = counts.githubIssues;
  await page.locator("caffold-header-actions").evaluate((headerActions) => {
    headerActions.dispatchEvent(
      new CustomEvent("caffold:open-github-issues-workspace", { bubbles: true }),
    );
  });
  await expect.poll(() => counts.githubIssues).toBe(issueRequestsBeforeSameRouteEntry + 1);
  await expect(page).toHaveURL("/github/issues?cwd=src&page=2");

  await page.locator('button[data-issue-number="42"]').click();
  await expect(page).toHaveURL("/github/issues/42?cwd=src&page=2");
  const issueRequestsBeforeBack = counts.githubIssues;
  await page.getByRole("button", { name: "Back to issues" }).click();
  await expect(page).toHaveURL("/github/issues?cwd=src&page=2");
  expect(counts.githubIssues).toBe(issueRequestsBeforeBack);

  await page.goto("/github/pulls?cwd=src&page=2");
  await expect(page.locator('button[data-pull-number="12"]')).toBeVisible();
  const pullRequestsBeforeHeaderEntry = counts.githubPulls;

  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL("/files?cwd=src");
  await clickHeaderAction(page, "github", "open-github-pulls-workspace");
  await expect.poll(() => counts.githubPulls).toBe(pullRequestsBeforeHeaderEntry + 1);
  await expect(page).toHaveURL("/github/pulls?cwd=src&page=2");

  const pullRequestsBeforeSameRouteEntry = counts.githubPulls;
  await page.locator("caffold-header-actions").evaluate((headerActions) => {
    headerActions.dispatchEvent(
      new CustomEvent("caffold:open-github-pulls-workspace", { bubbles: true }),
    );
  });
  await expect.poll(() => counts.githubPulls).toBe(pullRequestsBeforeSameRouteEntry + 1);
  await expect(page).toHaveURL("/github/pulls?cwd=src&page=2");

  await page.locator('button[data-pull-number="12"]').click();
  await expect(page).toHaveURL("/github/pulls/12?cwd=src&page=2");
  const pullRequestsBeforeBack = counts.githubPulls;
  await page.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL("/github/pulls?cwd=src&page=2");
  expect(counts.githubPulls).toBe(pullRequestsBeforeBack);
});

test("switches directly between standalone review route owners", async ({ page }) => {
  await installStandaloneReviewRouteMocks(page);

  await page.goto("/git/diff?cwd=src&file=example.rs");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");

  await page.goto(
    "/git/compare?cwd=src&base=origin%2Fmain&head=feature%2Freview&file=example.rs",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new compare route line",
  );

  await page.goto(
    `/git/log?cwd=src&page=2&sha=${ROUTE_COMMIT.sha}&file=planner%2Fmod.rs`,
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
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

test("reloads Changes when the directory context changes", async ({ page }) => {
  const { paths } = await installReviewContextMocks(page);
  await page.goto(FILES_HOME_URL);

  await loadDirectory(page, "src");
  await expectLastPath(paths.gitStatus, "src");
  await clickHeaderAction(page, "git", "open-diff-workspace");
  const changesTree = page.locator("caffold-git-diff-changes-tree");
  await expect(changesTree.locator('button[data-file-tree-path="src/example.rs"]')).toBeVisible();

  await loadDirectory(page, "src/planner");
  await expectLastPath(paths.gitStatus, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(
    changesTree.locator('button[data-file-tree-path="src/planner/mod.rs"]'),
  ).toBeVisible();
});

test("reloads Compare when the directory context changes", async ({ page }) => {
  const { paths } = await installReviewContextMocks(page);
  await page.goto(FILES_HOME_URL);

  await loadDirectory(page, "src");
  await clickHeaderAction(page, "git", "open-compare-workspace");
  await expectLastPath(paths.gitRefs, "src");
  await expectLastPath(paths.gitCompare, "src");
  const compareTree = page.locator("caffold-git-compare-tree");
  await expect(compareTree.locator('button[data-file-tree-path="src/example.rs"]')).toBeVisible();

  await loadDirectory(page, "src/planner");
  await expectLastPath(paths.gitRefs, "src/planner");
  await expectLastPath(paths.gitCompare, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner/mod.rs"]'),
  ).toBeVisible();
});

test("reloads Log when the directory context changes", async ({ page }) => {
  const { paths } = await installReviewContextMocks(page);
  await page.goto(FILES_HOME_URL);

  await loadDirectory(page, "src");
  await clickHeaderAction(page, "git", "open-log-workspace");
  await expectLastPath(paths.gitLog, "src");
  await expect(page.locator("caffold-git-log-list-page")).toContainText(
    "Source context commit",
  );

  await loadDirectory(page, "src/planner");
  await expectLastPath(paths.gitLog, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(page.locator("caffold-git-log-list-page")).toContainText(
    "Planner context commit",
  );
});

test("reloads GitHub Issues when the directory context changes", async ({ page }) => {
  const { paths } = await installReviewContextMocks(page);
  await page.goto(FILES_HOME_URL);

  await loadDirectory(page, "src");
  await clickHeaderAction(page, "github", "open-github-issues-workspace");
  await expectLastPath(paths.githubIssues, "src");
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Source context issue",
  );

  await loadDirectory(page, "src/planner");
  await expectLastPath(paths.githubIssues, "src/planner");
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Planner context issue",
  );
});

test("reloads GitHub Pulls when the directory context changes", async ({ page }) => {
  const { paths } = await installReviewContextMocks(page);
  await page.goto(FILES_HOME_URL);

  await loadDirectory(page, "src");
  await clickHeaderAction(page, "github", "open-github-pulls-workspace");
  await expectLastPath(paths.githubPulls, "src");
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Source context pull",
  );

  await loadDirectory(page, "src/planner");
  await expectLastPath(paths.githubPulls, "src/planner");
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "pulls",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Planner context pull",
  );
});
