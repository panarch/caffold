import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { expectDomainBackChrome } from "../support/domain-header.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const THREAD_ID = "thread_task_git_review";
const ROOT_PATH = "src";
const FIXTURE_HOME = resolve("tests/fixtures/home");
const COMMIT = {
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  shortSha: "abcdef1",
  subject: "Keep Git inside Task Detail",
  body: "",
  authorName: "Caffold",
  authorEmail: "caffold@example.test",
  authorTimeMs: 1_785_700_000_000,
};
const FETCH_FAILURES = [
  {
    name: "remote-not-found",
    status: 400,
    code: "git_remote_not_found",
    message: "no Git fetch remote is configured for: src",
  },
  {
    name: "remote-ambiguous",
    status: 409,
    code: "git_remote_ambiguous",
    message: "multiple Git fetch remotes are configured for: src",
  },
  {
    name: "remote-head-unavailable",
    status: 502,
    code: "git_remote_head_unavailable",
    message: "the default branch is unavailable for Git remote: origin",
  },
  {
    name: "fetch-failed",
    status: 502,
    code: "git_fetch_failed",
    message: "Git fetch failed for origin/main",
  },
  {
    name: "relationship-unavailable",
    status: 400,
    code: "git_command_failed",
    message: "git command failed while trying to compare the fetched branch: src",
  },
];

function taskRecord(
  threadId = THREAD_ID,
  { rootPath = ROOT_PATH, branch = "feature/review" } = {},
) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: `Task Git ${threadId}`,
    preview: "Task-owned Git review",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath,
      branch,
      headSha: COMMIT.sha,
      relativeCwd: "",
      linked: true,
    },
    createdMs: 1_785_700_000_000,
    updatedMs: 1_785_700_000_000,
    recencyMs: 1_785_700_000_000,
    lastEventSummary: "Task-owned Git review",
  };
}

async function installTaskGitFixture(
  page,
  tasks = [taskRecord()],
  { rootPath = ROOT_PATH, branch = "feature/review", mockFetch = true } = {},
) {
  await installEventSourceMock(page, {
    registryKey: "__taskGitWatchSources",
    bootstrapFunctionKey: "__taskGitDetailBootstrap",
  });
  await mockCodexModels(page);
  const repository = { rootPath, branch, dirty: false };
  const counts = {
    repository,
    refs: 0,
    compare: 0,
    compareDiff: 0,
    fetch: 0,
    fetchBranch: "main",
    fetchCompleted: 0,
    fetchError: null,
    fetchWait: null,
    log: 0,
    commit: 0,
  };

  await page.exposeFunction("__taskGitDetailBootstrap", (threadId) => {
    const task = tasks.find((candidate) => candidate.threadId === threadId);
    return task
      ? {
          threadId,
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
        }
      : null;
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection(tasks) }),
  );
  for (const task of tasks) {
    await page.route(new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`), (route) =>
      route.fulfill({
        json: {
          threadId: task.threadId,
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
  }
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    counts.refs += 1;
    return route.fulfill({
      json: {
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "feature/review",
      },
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    counts.compare += 1;
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        repository,
        baseRef: url.searchParams.get("base") || "origin/main",
        headRef: url.searchParams.get("head") || "feature/review",
        additions: 2,
        deletions: 1,
        files: [
          { path: "src/alpha.rs", repoRelativePath: "alpha.rs", status: "A" },
          { path: "src/example.rs", repoRelativePath: "example.rs", status: "M" },
          {
            path: "src/nested/module.rs",
            repoRelativePath: "nested/module.rs",
            status: "M",
          },
        ],
      },
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    counts.compareDiff += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(rootPath);
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      json: {
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "origin/main...feature/review",
        additions: 1,
        deletions: 1,
        diff: "@@ -1 +1 @@\n-old compare\n+new compare",
      },
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) => {
    counts.log += 1;
    return route.fulfill({
      json: {
        repository,
        commits: [COMMIT],
        page: 1,
        perPage: 50,
        totalCommits: 1,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      },
    });
  });
  if (mockFetch) {
    await page.route(/\/api\/git\/fetch(?:\?|$)/, async (route) => {
      counts.fetch += 1;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ path: rootPath });
      if (counts.fetchWait) {
        await counts.fetchWait;
      }
      if (counts.fetchError) {
        const error = typeof counts.fetchError === "string"
          ? { status: 502, code: "git_fetch_failed", message: counts.fetchError }
          : counts.fetchError;
        await route.fulfill({
          status: error.status,
          json: { error: { code: error.code, message: error.message } },
        });
        counts.fetchCompleted += 1;
        return;
      }
      await route.fulfill({
        json: {
          repository,
          remote: "origin",
          branch: counts.fetchBranch,
          reference: `origin/${counts.fetchBranch}`,
          ahead: 3,
          behind: 2,
        },
      });
      counts.fetchCompleted += 1;
    });
  }
  await page.route(/\/api\/git\/commit(?:\?|$)/, (route) => {
    counts.commit += 1;
    return route.fulfill({
      json: {
        repository,
        commit: COMMIT,
        additions: 2,
        deletions: 1,
        files: [
          { path: "src/alpha.rs", repoRelativePath: "alpha.rs", status: "A" },
          { path: "src/example.rs", repoRelativePath: "example.rs", status: "M" },
          {
            path: "src/nested/module.rs",
            repoRelativePath: "nested/module.rs",
            status: "M",
          },
        ],
      },
    });
  });
  await page.route(/\/api\/git\/commit-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(rootPath);
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      json: {
        repository,
        sha: COMMIT.sha,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        status: "M",
        kind: COMMIT.shortSha,
        additions: 1,
        deletions: 1,
        diff: "@@ -1 +1 @@\n-old commit\n+new commit",
      },
    });
  });

  return counts;
}

async function chooseGitTool(page, kind) {
  const detailHeader = page.locator(".detail-layout-summary");
  const popover = detailHeader.locator(
    "caffold-task-detail-git > .task-git-popover",
  );
  await detailHeader.getByRole("button", { name: "Open Git workspace" }).click();
  await expect(popover).toBeVisible();
  await detailHeader
    .locator(
      `caffold-task-detail-git button[data-git-button-action][data-review-kind="${kind}"]`,
    )
    .click();
  await expect(popover).toBeHidden();
}

async function rootTreeNames(tree) {
  return tree
    .locator(
      ":scope .file-tree-rows > li:not([data-file-tree-parent-key]) .file-tree-name",
    )
    .allTextContents();
}

test("applies the global ordering to Compare and Commit without refetching", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const counts = await installTaskGitFixture(page);
  await page.goto(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  const compareTree = page.locator(
    "caffold-git-compare-page caffold-file-tree",
  );
  await expect(compareTree).toBeVisible();
  await expect
    .poll(() => rootTreeNames(compareTree))
    .toEqual(["nested", "alpha.rs", "example.rs"]);
  expect(counts.compare).toBe(1);

  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("name");
  });
  await expect
    .poll(() => rootTreeNames(compareTree))
    .toEqual(["alpha.rs", "example.rs", "nested"]);
  expect(counts.compare).toBe(1);

  await page.goto(`/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}`);
  const commitTree = page.locator("caffold-commit-changes-tree caffold-file-tree");
  await expect(commitTree).toBeVisible();
  await expect
    .poll(() => rootTreeNames(commitTree))
    .toEqual(["alpha.rs", "example.rs", "nested"]);
  expect(counts.commit).toBe(1);

  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("folders-first");
  });
  await expect
    .poll(() => rootTreeNames(commitTree))
    .toEqual(["nested", "alpha.rs", "example.rs"]);
  expect(counts.commit).toBe(1);
});

test("reloads Task-scoped Compare and releases its refs watch while inactive", { tag: "@all-viewports" }, async ({ page }) => {
  const counts = await installTaskGitFixture(page);
  const compareUrl =
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview`;
  await page.goto(compareUrl);

  const layout = page.locator("caffold-task-git-layout");
  await expect(layout).toBeVisible();
  await expect(page.locator("caffold-git-compare-page")).toContainText("example.rs");
  const compareHeaderGeometry = await layout
    .locator(":scope > .task-git-surface > .task-domain-header")
    .evaluate((header) => {
      const title = header.querySelector(".task-domain-title").getBoundingClientRect();
      const titleStyle = getComputedStyle(
        header.querySelector(".task-domain-title"),
      );
      const controls = header
        .querySelector("caffold-git-review-controls")
        .getBoundingClientRect();
      const bounds = header.getBoundingClientRect();
      const headerStyle = getComputedStyle(header);
      const paddingLeft = Number.parseFloat(headerStyle.paddingLeft);
      const paddingRight = Number.parseFloat(headerStyle.paddingRight);
      const taskHeader = document.querySelector(".detail-layout-summary");
      const taskHeaderStyle = getComputedStyle(taskHeader);
      const domainTitleStyle = getComputedStyle(
        header.querySelector(".task-domain-title h2"),
      );
      const taskTitleStyle = getComputedStyle(
        taskHeader.querySelector(".task-detail-heading > h2"),
      );
      const visibleControlRects = [
        ...header.querySelectorAll(
          ".review-compare-ref-controls label, .review-compare-ref-controls select, .review-compare-ref-separator, .git-review-refresh",
        ),
      ]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && rect.width > 0 && rect.height > 0;
        })
        .map((element) => element.getBoundingClientRect())
        .sort((left, right) => left.left - right.left);
      return {
        height: bounds.height,
        minimumHeight: Number.parseFloat(headerStyle.minHeight),
        overflow: header.scrollWidth > header.clientWidth,
        paddingMatchesTask:
          Math.abs(paddingRight - Number.parseFloat(taskHeaderStyle.paddingRight)) <= 1,
        symmetricPadding: Math.abs(paddingLeft - paddingRight) <= 1,
        titleSizeMatchesTask:
          Math.abs(
            Number.parseFloat(domainTitleStyle.fontSize) -
              Number.parseFloat(taskTitleStyle.fontSize),
          ) <= 0.1,
        responsiveTitle:
          window.innerWidth > 520 ||
          (titleStyle.position === "absolute" && titleStyle.overflow === "hidden"),
        titleBeforeControls:
          window.innerWidth <= 520 || title.right <= controls.left + 1,
        visibleControlsDoNotOverlap: visibleControlRects.every(
          (rect, index) =>
            index === 0 || visibleControlRects[index - 1].right <= rect.left + 1,
        ),
        controlsWithinHeader:
          controls.left >= bounds.left + paddingLeft - 1 &&
          controls.right <= bounds.right - paddingRight + 1,
        controlsAtTrailingEdge:
          Math.abs(bounds.right - paddingRight - controls.right) <= 1,
      };
    });
  expect(compareHeaderGeometry.height).toBeCloseTo(
    compareHeaderGeometry.minimumHeight,
    0,
  );
  expect(compareHeaderGeometry).toMatchObject({
    overflow: false,
    paddingMatchesTask: true,
    symmetricPadding: true,
    titleSizeMatchesTask: true,
    responsiveTitle: true,
    titleBeforeControls: true,
    visibleControlsDoNotOverlap: true,
    controlsWithinHeader: true,
    controlsAtTrailingEdge: true,
  });
  await expect.poll(() => counts.compare).toBe(1);
  await expect.poll(() => counts.refs).toBe(1);
  await emitGitTaskEvent(page, 2);
  await expect(page.locator("caffold-git-compare-page")).toContainText("example.rs");
  await expect(page.locator("caffold-git-compare-page")).not.toContainText(
    "Loading compare...",
  );
  expect(counts.compare).toBe(1);
  expect(counts.refs).toBe(1);
  await layout.evaluate((element) => {
    element.dataset.testIdentity = "retained";
  });
  await expect.poll(() => page.evaluate(() =>
    window.__taskGitWatchSources.filter((source) => source.url.includes("/api/watch")).length,
  )).toBe(1);

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await expect(layout).toBeHidden();
  await expect(layout).toHaveAttribute("data-test-identity", "retained");
  await expect.poll(() =>
    page.evaluate(() =>
      window.__taskGitWatchSources.find((source) => source.url.includes("/api/watch"))?.readyState,
    ),
  ).toBe(2);

  await chooseGitTool(page, "compare");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/compare`);
  await expect(layout).toHaveAttribute("data-test-identity", "retained");
  await expect.poll(() => counts.compare).toBe(2);
  await expect.poll(() => counts.refs).toBe(2);
  await expect.poll(() => page.evaluate(() =>
    window.__taskGitWatchSources.filter((source) => source.url.includes("/api/watch")).length,
  )).toBe(2);

  await page.reload();
  await expect(page.locator("caffold-git-compare-page")).toContainText("example.rs");
  await expect.poll(() => counts.compare).toBe(3);
});

test("reloads Section-scoped Log from the Section repository context", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const counts = await installTaskGitFixture(page);
  await page.goto("/?section=fixture-section-1&surface=git&tool=log");

  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=git&tool=log",
  );
  await expect(
    page.locator("caffold-section-detail-summary h2"),
  ).toHaveText(ROOT_PATH);
  const layout = page.locator("caffold-task-git-layout");
  await expect(layout).toBeVisible();
  await expect(page.locator("caffold-git-log-list-page")).toContainText(
    COMMIT.subject,
  );
  await expect.poll(() => counts.log).toBe(1);
  await expect.poll(() =>
    layout.evaluate((element) => element.repository?.rootPath ?? null)
  ).toBe(ROOT_PATH);
  expect(counts.fetch).toBe(0);
  await layout.getByRole("button", { name: "Fetch remote default branch" }).click();
  await expect(layout.locator(".task-domain-count")).toHaveText("1 commit");
  await expect(layout.locator(".task-domain-primary-meta")).toHaveText(
    "feature/review",
  );
  await expect(layout.locator(".task-domain-secondary-meta")).toHaveText(
    "3 ahead, 2 behind main",
  );
  expect(counts.fetch).toBe(1);
  expect(counts.log).toBe(1);
});

test("keeps the loaded Git route stable across unrelated Task stream updates", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const counts = await installTaskGitFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);
  const logPage = page.locator("caffold-git-log-list-page");
  await expect(logPage).toContainText(COMMIT.subject);
  expect(counts.log).toBe(1);

  await emitGitTaskEvent(page, 2);

  await expect(logPage).toContainText(COMMIT.subject);
  await expect(logPage).not.toContainText("Loading log...");
  expect(counts.log).toBe(1);
});

test("navigates Compare files and Log commits with deterministic domain Back", { tag: "@all-viewports" }, async ({ page }) => {
  await installTaskGitFixture(page);
  await page.goto(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  await page.locator('button[data-file-tree-path="src/example.rs"]').click();
  await expect(page).toHaveURL(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview&file=example.rs`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare");
  await page.reload();
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare");

  await chooseGitTool(page, "log");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log`);
  await page.reload();
  const logPage = page.locator("caffold-git-log-list-page");
  const logHeader = page.locator(
    "caffold-task-git-layout > .task-git-surface > .task-domain-header",
  );
  await expect(logPage).toContainText(COMMIT.subject);
  await expect(logPage.locator(".log-list-panel > header")).toHaveCount(0);
  await expect(logHeader.locator("h2")).toHaveText("Log");
  const logCount = logHeader.locator(".task-domain-count");
  const logBranch = logHeader.locator(".task-domain-primary-meta");
  const logRelationship = logHeader.locator(".task-domain-secondary-meta");
  await expect(logCount).toHaveText("1 commit");
  await expect(logBranch).toHaveText("feature/review");
  await expect(logBranch).toHaveAttribute("title", "feature/review");
  await expect(logRelationship).toBeHidden();
  await expect(
    logHeader.getByRole("button", { name: "Fetch remote default branch" }),
  ).toHaveClass(/git-review-refresh/);
  const logHeaderGeometry = await logHeader.evaluate((header) => {
    const titleRow = header.querySelector(".task-domain-title-row");
    const metaRow = header.querySelector(".task-domain-meta-row");
    const count = header.querySelector(".task-domain-count");
    const branch = header.querySelector(".task-domain-primary-meta");
    const titleRowBounds = titleRow.getBoundingClientRect();
    const metaRowBounds = metaRow.getBoundingClientRect();
    const countBounds = count.getBoundingClientRect();
    const branchBounds = branch.getBoundingClientRect();
    const refreshBounds = header
      .querySelector(".git-review-refresh")
      .getBoundingClientRect();
    const bounds = header.getBoundingClientRect();
    const paddingRight = Number.parseFloat(getComputedStyle(header).paddingRight);
    return {
      height: bounds.height,
      minimumHeight: Number.parseFloat(getComputedStyle(header).minHeight),
      branchClipped: branch.scrollWidth > branch.clientWidth,
      rowsSeparated: metaRowBounds.top >= titleRowBounds.bottom - 1,
      countOnTitleRow:
        countBounds.top >= titleRowBounds.top - 1 &&
        countBounds.bottom <= titleRowBounds.bottom + 1,
      branchOnMetaRow:
        branchBounds.top >= metaRowBounds.top - 1 &&
        branchBounds.bottom <= metaRowBounds.bottom + 1,
      refreshAfterTitle: refreshBounds.left >= titleRowBounds.right,
      refreshAtTrailingEdge:
        Math.abs(bounds.right - paddingRight - refreshBounds.right) <= 1,
      noHorizontalOverflow: header.scrollWidth <= header.clientWidth,
    };
  });
  expect(logHeaderGeometry.height).toBeCloseTo(logHeaderGeometry.minimumHeight, 0);
  expect(logHeaderGeometry).toMatchObject({
    branchClipped: false,
    rowsSeparated: true,
    countOnTitleRow: true,
    branchOnMetaRow: true,
    refreshAfterTitle: true,
    refreshAtTrailingEdge: true,
    noHorizontalOverflow: true,
  });
  await page
    .locator(`.log-entry[data-commit-sha="${COMMIT.sha}"]`)
    .getByRole("button", { name: /Open commit diff/ })
    .click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}`);
  await page.reload();
  await expect(page.locator("caffold-task-git-layout .task-domain-title h2")).toHaveText(
    "Commit",
  );
  await expectDomainBackChrome(logHeader, "Back to log");
  const commitFile = page.getByRole("button", {
    name: "Show commit diff for example.rs",
  });
  await expect(commitFile).toBeVisible();
  await commitFile.click();
  await expect(page).toHaveURL(
    `/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}&file=example.rs`,
  );
  const commitDiff = page.locator(".git-mode-log caffold-diff-viewer");
  await expect(commitDiff).toContainText("new commit");
  await page.reload();
  await expect(commitDiff).toContainText("new commit");
  const fileBack = page.getByRole("button", { name: "Back to commit" });
  if (await fileBack.isVisible()) {
    await fileBack.click();
  } else {
    await page.goBack();
  }
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}`);
  const back = page.getByRole("button", { name: "Back to log" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log`);
  await expect(page.locator("caffold-git-log-list-page")).toBeVisible();
});

test("keeps long Log metadata inside the two-row header", { tag: "@all-viewports" }, async ({ page }) => {
  const longBranch =
    "feature/git-log-remote-status-with-an-inconveniently-long-local-branch-name";
  const longRemoteBranch =
    "release/remote-default-with-an-inconveniently-long-branch-name";
  const counts = await installTaskGitFixture(page);
  counts.repository.branch = longBranch;
  counts.fetchBranch = longRemoteBranch;
  await page.goto(`/tasks/${THREAD_ID}/git/log`);

  const header = page.locator(
    "caffold-task-git-layout > .task-git-surface > .task-domain-header",
  );
  const branch = header.locator(".task-domain-primary-meta");
  const relationship = header.locator(".task-domain-secondary-meta");
  await expect(branch).toHaveText(longBranch);
  await expect(branch).toHaveAttribute("title", longBranch);
  await header.getByRole("button", { name: "Fetch remote default branch" }).click();
  await expect(relationship).toHaveText(
    `3 ahead, 2 behind ${longRemoteBranch}`,
  );

  const geometry = await header.evaluate((element) => {
    const title = element.querySelector(".task-domain-title").getBoundingClientRect();
    const titleRow = element.querySelector(".task-domain-title-row").getBoundingClientRect();
    const metaRow = element.querySelector(".task-domain-meta-row").getBoundingClientRect();
    const branch = element.querySelector(".task-domain-primary-meta").getBoundingClientRect();
    const relationship = element
      .querySelector(".task-domain-secondary-meta")
      .getBoundingClientRect();
    return {
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      rowsSeparated: metaRow.top >= titleRow.bottom - 1,
      metadataWithinHeader:
        branch.left >= title.left &&
        relationship.right <= title.right &&
        branch.right <= relationship.left + 1,
    };
  });
  expect(geometry).toEqual({
    noHorizontalOverflow: true,
    rowsSeparated: true,
    metadataWithinHeader: true,
  });
});

test("fetches remote Log status only on explicit request and retains settled status on re-entry", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const counts = await installTaskGitFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);

  const layout = page.locator("caffold-task-git-layout");
  const count = layout.locator(".task-domain-count");
  const branch = layout.locator(".task-domain-primary-meta");
  const relationship = layout.locator(".task-domain-secondary-meta");
  const fetch = layout.locator(".git-review-refresh");
  await expect(count).toHaveText("1 commit");
  await expect(branch).toHaveText("feature/review");
  await expect(relationship).toBeHidden();
  await expect(fetch).toHaveAccessibleName("Fetch remote default branch");
  expect(counts.fetch).toBe(0);

  await fetch.click();
  await expect(count).toHaveText("1 commit");
  await expect(branch).toHaveText("feature/review");
  await expect(relationship).toHaveText("3 ahead, 2 behind main");
  if (testInfo.project.name === "foldable") {
    await captureReviewScreenshot(page, testInfo, "tasks-git-log-remote-status");
  }
  await expect(
    layout.getByRole("button", { name: "Fetch origin/main again" }),
  ).toBeEnabled();
  expect(counts.fetch).toBe(1);
  expect(counts.log).toBe(1);

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await chooseGitTool(page, "log");
  await expect(count).toHaveText("1 commit");
  await expect(branch).toHaveText("feature/review");
  await expect(relationship).toHaveText("3 ahead, 2 behind main");
  await expect(
    layout.getByRole("button", { name: "Fetch origin/main again" }),
  ).toBeEnabled();
  expect(counts.fetch).toBe(1);
});

test("keeps an in-flight Fetch isolated across Git route re-entry", { tag: "@all-viewports" }, async ({ page }) => {
  const counts = await installTaskGitFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);

  const layout = page.locator("caffold-task-git-layout");
  const fetch = layout.locator(".git-review-refresh");
  const relationship = layout.locator(".task-domain-secondary-meta");
  await fetch.click();
  await expect(relationship).toHaveText("3 ahead, 2 behind main");

  let releaseFetch;
  counts.fetchWait = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  await layout.evaluate((element) => {
    window.__gitFetchSettlementComplete = false;
    void element.fetchRemote().finally(() => {
      window.__gitFetchSettlementComplete = true;
    });
  });
  await expect(
    layout.getByRole("button", { name: "Fetching remote default branch" }),
  ).toBeDisabled();
  await expect.poll(() =>
    page.evaluate(() =>
      window.__taskGitWatchSources.filter(
        (source) => source.url.includes("/api/watch") && source.readyState !== 2,
      ).length
    )
  ).toBe(1);
  await expect(fetch).toHaveClass(/is-refreshing/);
  const refreshIcon = fetch.locator(".git-review-refresh-icon");
  await expect(refreshIcon).toBeVisible();
  const animation = await refreshIcon.evaluate(async (icon) => {
    const style = getComputedStyle(icon);
    const animationName = style.animationName;
    const before = style.transform;
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const after = getComputedStyle(icon).transform;
    return { animationName, before, after };
  });
  expect(animation.animationName).toBe("caffold-refresh-spin");
  expect(animation.after).not.toBe(animation.before);

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await chooseGitTool(page, "log");
  await expect(relationship).toHaveText("3 ahead, 2 behind main");
  releaseFetch();
  await expect.poll(() => counts.fetchCompleted).toBe(2);
  await expect.poll(() =>
    page.evaluate(() => window.__gitFetchSettlementComplete)
  ).toBe(true);
  await expect.poll(() =>
    page.evaluate(() =>
      window.__taskGitWatchSources.filter(
        (source) => source.url.includes("/api/watch") && source.readyState !== 2,
      ).length
    )
  ).toBe(1);
  await expect(relationship).toHaveText("3 ahead, 2 behind main");
  await expect(
    layout.getByRole("button", { name: "Fetch origin/main again" }),
  ).toBeEnabled();
});

test("clears fetched relationship when the local branch changes", { tag: "@all-viewports" }, async ({ page }) => {
  const counts = await installTaskGitFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);

  const layout = page.locator("caffold-task-git-layout");
  const fetch = layout.locator(".git-review-refresh");
  const branch = layout.locator(".task-domain-primary-meta");
  const relationship = layout.locator(".task-domain-secondary-meta");
  await fetch.click();
  await expect(relationship).toHaveText("3 ahead, 2 behind main");

  counts.repository.branch = "feature/next";
  await layout.evaluate((element) => element.logLayout.refresh());
  await expect(branch).toHaveText("feature/next");
  await expect(relationship).toBeHidden();
  await expect(fetch).toHaveAccessibleName("Fetch remote default branch");
});

test("connects the Fetch control to the actual backend Git boundary", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = createFetchScenario(testInfo.project.name);
  const task = taskRecord(THREAD_ID, {
    rootPath: scenario.rootPath,
    branch: "feature/review",
  });
  try {
    await installTaskGitFixture(page, [task], {
      rootPath: scenario.rootPath,
      branch: "feature/review",
      mockFetch: false,
    });
    await page.goto(`/tasks/${THREAD_ID}/git/log`);

    const layout = page.locator("caffold-task-git-layout");
    await layout.getByRole("button", { name: "Fetch remote default branch" }).click();
    await expect(layout.locator(".task-domain-secondary-meta")).toHaveText(
      "1 ahead, 1 behind main",
    );
    await expect(
      layout.getByRole("button", { name: "Fetch origin/main again" }),
    ).toBeEnabled();
    expect(gitOutput(scenario.local, ["rev-parse", "origin/main"])).toBe(
      gitOutput(scenario.seed, ["rev-parse", "main"]),
    );
  } finally {
    await page.goto("about:blank");
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test("exposes every Git fetch failure through the native Fetch tooltip", { tag: "@all-viewports" }, async ({ page }) => {
  const counts = await installTaskGitFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);

  const layout = page.locator("caffold-task-git-layout");
  const fetch = layout.locator(".git-review-refresh");
  const relationship = layout.locator(".task-domain-secondary-meta");
  for (const failure of FETCH_FAILURES) {
    counts.fetchError = failure;
    await fetch.click();
    const tooltip = `Fetch failed. ${failure.message}`;
    await expect(relationship).toHaveText("Remote unavailable");
    await expect(fetch).toHaveClass(/is-error/);
    await expect(fetch).toHaveAttribute("title", tooltip);
    await expect(fetch).toHaveAccessibleName(tooltip);
  }
});

test("deactivates and rebinds the shared Git child when the selected Task changes", { tag: "@all-viewports" }, async ({ page }) => {
  const other = taskRecord("thread_task_git_other");
  await installTaskGitFixture(page, [taskRecord(), other]);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);
  const layout = page.locator("caffold-task-git-layout");
  await expect(layout).toBeVisible();
  await layout.evaluate((element) => {
    element.dataset.testIdentity = "first-task";
  });

  const otherTask = page.locator(`.task-row[data-thread-id="${other.threadId}"]`);
  if (!(await otherTask.isVisible())) {
    await page.getByRole("button", { name: "Back to tasks" }).click();
    await expect(page).toHaveURL("/");
  }
  await otherTask.click();
  await expect(page).toHaveURL(`/tasks/${other.threadId}`);
  await expect(layout).toBeHidden();
  await expect(layout).not.toHaveAttribute("data-active", "true");
});

test("stops an older Compare activation before it opens a file after a Log route wins", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const counts = await installTaskGitFixture(page);
  await page.unroute(/\/api\/git\/compare(?:\?|$)/);
  const pendingCompare = [];
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    counts.compare += 1;
    pendingCompare.push(route);
  });

  await page.goto(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview&file=example.rs`,
  );
  await expect.poll(() => pendingCompare.length).toBe(1);
  await chooseGitTool(page, "log");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log`);
  await expect(page.locator("caffold-git-log-list-page")).toContainText(COMMIT.subject);

  await pendingCompare[0].fulfill({
    json: {
      repository: { rootPath: ROOT_PATH, branch: "feature/review", dirty: false },
      baseRef: "origin/main",
      headRef: "feature/review",
      additions: 2,
      deletions: 1,
      files: [{ path: "src/example.rs", repoRelativePath: "example.rs", status: "M" }],
    },
  });
  await page.waitForTimeout(100);
  expect(counts.compareDiff).toBe(0);
  await expect(page.locator("caffold-task-git-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
});

async function emitGitTaskEvent(page, revision) {
  await page.evaluate(({ threadId, revision }) => {
    const source = window.__taskGitWatchSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    if (!source) {
      throw new Error(`Missing detail stream for ${threadId}`);
    }
    source.emit("task-event", {
      threadId,
      revision,
      event: {
        id: `event_git_domain_render_${revision}`,
        threadId,
        type: "assistant_message",
        payload: { text: `Unrelated Task update ${revision}` },
      },
    });
  }, { threadId: THREAD_ID, revision });
}

function createFetchScenario(projectName) {
  const root = mkdtempSync(resolve(FIXTURE_HOME, `.git-fetch-${projectName}-`));
  const seed = resolve(root, "seed");
  const remote = resolve(root, "remote.git");
  const local = resolve(root, "local");
  mkdirSync(seed);
  mkdirSync(remote);
  git(seed, ["init"]);
  writeFileSync(resolve(seed, "base.txt"), "base\n");
  git(seed, ["add", "base.txt"]);
  gitCommit(seed, "Add base");
  git(seed, ["branch", "-M", "main"]);
  git(remote, ["init", "--bare"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", remote, local]);
  git(local, ["checkout", "-b", "feature/review"]);
  writeFileSync(resolve(local, "feature.txt"), "feature\n");
  git(local, ["add", "feature.txt"]);
  gitCommit(local, "Add feature");
  writeFileSync(resolve(seed, "remote.txt"), "remote\n");
  git(seed, ["add", "remote.txt"]);
  gitCommit(seed, "Advance main");
  git(seed, ["push", "origin", "main"]);
  return {
    root,
    seed,
    local,
    rootPath: relative(FIXTURE_HOME, local).split("\\").join("/"),
  };
}

function git(path, args) {
  execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
}

function gitCommit(path, message) {
  git(path, [
    "-c",
    "user.name=Caffold Test",
    "-c",
    "user.email=caffold@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

function gitOutput(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}
