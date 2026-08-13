import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { expectDomainBackChrome } from "../support/domain-header.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const THREAD_ID = "thread_task_git_review";
const ROOT_PATH = "src";
const COMMIT = {
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  shortSha: "abcdef1",
  subject: "Keep Git inside Task Detail",
  body: "",
  authorName: "Caffold",
  authorEmail: "caffold@example.test",
  authorTimeMs: 1_785_700_000_000,
};

function taskRecord(threadId = THREAD_ID) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: `Task Git ${threadId}`,
    preview: "Task-owned Git review",
    cwd: ROOT_PATH,
    cwdPath: ROOT_PATH,
    relativeCwd: "",
    worktree: {
      rootPath: ROOT_PATH,
      branch: "feature/review",
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

async function installTaskGitFixture(page, tasks = [taskRecord()]) {
  await installEventSourceMock(page, { registryKey: "__taskGitWatchSources" });
  await mockCodexModels(page);
  const repository = { rootPath: ROOT_PATH, branch: "feature/review", dirty: false };
  const counts = { refs: 0, compare: 0, compareDiff: 0, log: 0, commit: 0 };

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
    expect(url.searchParams.get("path")).toBe(ROOT_PATH);
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
    expect(url.searchParams.get("path")).toBe(ROOT_PATH);
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
  const summary = page.locator("caffold-task-detail-summary");
  const popover = summary.locator(
    "caffold-task-detail-git > .task-git-popover",
  );
  await summary.getByRole("button", { name: "Open Git workspace" }).click();
  await expect(popover).toBeVisible();
  await summary
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

test("applies the global ordering to Compare and Commit without refetching", async ({
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
  expect(await rootTreeNames(compareTree)).toEqual([
    "nested",
    "alpha.rs",
    "example.rs",
  ]);
  expect(counts.compare).toBe(1);

  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("name");
  });
  expect(await rootTreeNames(compareTree)).toEqual([
    "alpha.rs",
    "example.rs",
    "nested",
  ]);
  expect(counts.compare).toBe(1);

  await page.goto(`/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}`);
  const commitTree = page.locator("caffold-commit-changes-tree caffold-file-tree");
  await expect(commitTree).toBeVisible();
  expect(await rootTreeNames(commitTree)).toEqual([
    "alpha.rs",
    "example.rs",
    "nested",
  ]);
  expect(counts.commit).toBe(1);

  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("folders-first");
  });
  expect(await rootTreeNames(commitTree)).toEqual([
    "nested",
    "alpha.rs",
    "example.rs",
  ]);
  expect(counts.commit).toBe(1);
});

test("reloads Task-scoped Compare and releases its refs watch while inactive", async ({ page }) => {
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
      const taskHeader = document.querySelector("caffold-task-detail-summary");
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

test("keeps the loaded Git route stable across unrelated Task stream updates", async ({
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

test("navigates Compare files and Log commits with deterministic domain Back", async ({ page }) => {
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
  const logSubtitle = logHeader.locator(".task-domain-subtitle");
  await expect(logSubtitle).toHaveText("feature/review · 1 commits");
  await expect(logSubtitle).toHaveAttribute("title", "feature/review · 1 commits");
  const logHeaderGeometry = await logHeader.evaluate((header) => {
    const subtitle = header.querySelector(".task-domain-subtitle");
    const subtitleBounds = subtitle.getBoundingClientRect();
    const refreshBounds = header
      .querySelector(".git-review-refresh")
      .getBoundingClientRect();
    const bounds = header.getBoundingClientRect();
    const paddingRight = Number.parseFloat(getComputedStyle(header).paddingRight);
    return {
      height: bounds.height,
      minimumHeight: Number.parseFloat(getComputedStyle(header).minHeight),
      subtitleClipped: subtitle.scrollWidth > subtitle.clientWidth,
      refreshAfterSubtitle: refreshBounds.left >= subtitleBounds.right,
      refreshAtTrailingEdge:
        Math.abs(bounds.right - paddingRight - refreshBounds.right) <= 1,
    };
  });
  expect(logHeaderGeometry.height).toBeCloseTo(logHeaderGeometry.minimumHeight, 0);
  expect(logHeaderGeometry).toMatchObject({
    subtitleClipped: false,
    refreshAfterSubtitle: true,
    refreshAtTrailingEdge: true,
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

test("destroys the Git child when the selected Task changes", async ({ page }) => {
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
  await expect(page.locator('caffold-task-git-layout[data-test-identity="first-task"]')).toHaveCount(0);
});

test("stops an older Compare activation before it opens a file after a Log route wins", async ({
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
