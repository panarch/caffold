import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { repositoryPath } from "../../repository-paths.mjs";
import {
  actionHintBadgePresentation,
  actionHintDialog,
  activateActionHint,
  enterActionHints,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { expectDomainBackChrome } from "../support/domain-header.js";
import {
  activeTaskProjection,
  activeWatchSubscriptionId,
  captureReviewScreenshot,
  canonicalTaskState,
  installEventSourceMock,
  isWatchSubscriptionClosed,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const THREAD_ID = "thread_task_git_review";
const ROOT_PATH = "src";
const GIT_WATCH_REGISTRY_KEY = "__taskGitWatchSources";
const FIXTURE_HOME = repositoryPath("frontend/tests/e2e/fixtures/home");
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
  {
    rootPath = ROOT_PATH,
    branch = "feature/review",
    commitBody = "",
    largeCommit = false,
    largeCompare = false,
    largeLog = false,
    longDiff = false,
    mockFetch = true,
    logTotalPages = 1,
  } = {},
) {
  await installEventSourceMock(page, {
    registryKey: GIT_WATCH_REGISTRY_KEY,
    bootstrapFunctionKey: "__taskGitDetailBootstrap",
  });
  await mockAgentModels(page);
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
  const compareFiles = [
    { path: "src/alpha.rs", repoRelativePath: "alpha.rs", status: "A" },
    { path: "src/example.rs", repoRelativePath: "example.rs", status: "M" },
    {
      path: "src/nested/module.rs",
      repoRelativePath: "nested/module.rs",
      status: "M",
    },
    ...(largeCompare
      ? Array.from({ length: 80 }, (_, index) => ({
          path: `src/generated/compare-${`${index + 1}`.padStart(3, "0")}.rs`,
          repoRelativePath: `generated/compare-${`${index + 1}`.padStart(3, "0")}.rs`,
          status: "M",
        }))
      : []),
  ];
  const compareDiff = longDiff
    ? [
        "@@ -1,80 +1,80 @@",
        ...Array.from({ length: 80 }, (_, index) => [
          `-old compare ${index + 1}`,
          `+new compare ${index + 1}`,
        ]).flat(),
      ].join("\n")
    : "@@ -1 +1 @@\n-old compare\n+new compare";
  const fixtureCommit = { ...COMMIT, body: commitBody };
  const logCommits = [
    fixtureCommit,
    ...(largeLog
      ? Array.from({ length: 80 }, (_, index) => ({
          ...COMMIT,
          sha: `${index + 1}`.padStart(40, "0"),
          shortSha: `${index + 1}`.padStart(7, "0"),
          subject: `Scrollable commit ${index + 1}`,
          body: "",
          authorTimeMs: COMMIT.authorTimeMs - (index + 1) * 60_000,
        }))
      : []),
  ];
  const commitFiles = [
    { path: "src/alpha.rs", repoRelativePath: "alpha.rs", status: "A" },
    { path: "src/example.rs", repoRelativePath: "example.rs", status: "M" },
    {
      path: "src/nested/module.rs",
      repoRelativePath: "nested/module.rs",
      status: "M",
    },
    ...(largeCommit
      ? Array.from({ length: 80 }, (_, index) => ({
          path: `src/generated/commit-${`${index + 1}`.padStart(3, "0")}.rs`,
          repoRelativePath: `generated/commit-${`${index + 1}`.padStart(3, "0")}.rs`,
          status: "M",
        }))
      : []),
  ];

  await page.exposeFunction("__taskGitDetailBootstrap", (threadId) => {
    const task = tasks.find((candidate) => candidate.threadId === threadId);
    return task
      ? {
          threadId,
          syncState: "ready",
          revision: 1,
          eventRevision: 1,
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
          eventRevision: 1,
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
        files: compareFiles,
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
        diff: compareDiff,
      },
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) => {
    counts.log += 1;
    const requestedPage = Number.parseInt(
      new URL(route.request().url()).searchParams.get("page") ?? "1",
      10,
    );
    return route.fulfill({
      json: {
        repository,
        commits: logCommits,
        page: requestedPage,
        perPage: 50,
        totalCommits: largeLog ? logCommits.length : logTotalPages,
        totalPages: logTotalPages,
        hasPrevious: requestedPage > 1,
        hasNext: requestedPage < logTotalPages,
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
        commit: fixtureCommit,
        additions: 2,
        deletions: 1,
        files: commitFiles,
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
        diff: longDiff
          ? compareDiff.replaceAll("compare", "commit")
          : "@@ -1 +1 @@\n-old commit\n+new commit",
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

test("opens Git and selects its destination through declared keyboard contexts", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installTaskGitFixture(page);
  await page.goto(`/tasks/${THREAD_ID}`);

  await activateActionHint(page, /Open Git workspace$/);
  const popover = page.locator(
    ".detail-layout-summary caffold-task-detail-git > .task-git-popover",
  );
  await expect(popover).toBeVisible();
  await page.keyboard.press("s");
  await expect(
    popover.locator("caffold-scroll-mode-hud .scroll-mode-status"),
  ).toBeHidden();
  await expect(popover).toBeVisible();

  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Log$/ }),
  ).toBeVisible();
  const compare = hint.getByRole("button", { name: / — Compare$/ });
  await expect(compare).toBeVisible();
  await expect.poll(() => actionHintBadgePresentation(compare)).toEqual({
    backgroundMatches: true,
    borderVisible: true,
    colorMatches: true,
    hasBlockPadding: true,
    position: "absolute",
  });
  const compareCode = await compare.getAttribute("data-action-hint-code");
  expect(compareCode).toBeTruthy();
  await page.keyboard.type(compareCode.toLowerCase());

  await expect(popover).toBeHidden();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/compare`);
  await expect(page.locator("caffold-git-compare-page")).toContainText(
    "example.rs",
  );
});

test("hands Compare ref and separator Hints to their native controls", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installTaskGitFixture(page);
  await page.goto(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview`,
  );

  const gitLayout = page.locator("caffold-task-git-layout");
  const comparePage = page.locator("caffold-git-compare-page");
  const base = gitLayout.getByRole("combobox", { name: "Base ref" });
  const head = gitLayout.getByRole("combobox", { name: "Head ref" });
  const separator = comparePage.getByRole("separator", {
    name: "Resize review side panel",
  });
  await expect(base).toHaveValue("origin/main");
  await expect(head).toHaveValue("feature/review");

  const hint = await enterActionHints(page);
  await expect(
    hint.getByLabel(/ — Choose Base ref \(current origin\/main\)$/),
  ).toBeVisible();
  await expect(
    hint.getByLabel(/ — Choose Head ref \(current feature\/review\)$/),
  ).toBeVisible();
  if (testInfo.project.name === "phone") {
    await expect(
      hint.getByLabel(/ — Resize review side panel$/),
    ).toHaveCount(0);
  } else {
    await expect(
      hint.getByLabel(/ — Resize review side panel$/),
    ).toBeVisible();
  }
  await captureReviewScreenshot(
    page,
    testInfo,
    "git-compare-native-control-hints",
  );
  await page.keyboard.press("Escape");

  await activateActionHint(
    page,
    "Choose Base ref (current origin/main)",
  );
  await expect(base).toBeFocused();
  await base.selectOption("main");
  await expect(page).toHaveURL(
    new RegExp(`^.*\/tasks\/${THREAD_ID}\/git\/compare\\?base=main&head=feature%2Freview$`),
  );
  await expect(base).toHaveValue("main");

  await activateActionHint(
    page,
    "Choose Head ref (current feature/review)",
  );
  await expect(head).toBeFocused();
  await page.keyboard.press("Escape");

  if (testInfo.project.name === "phone") {
    await expect(separator).toBeHidden();
    return;
  }

  const before = Number(await separator.getAttribute("aria-valuenow"));
  await activateActionHint(page, "Resize review side panel");
  await expect(separator).toBeFocused();
  await separator.press("ArrowRight");
  await expect.poll(async () =>
    Number(await separator.getAttribute("aria-valuenow"))
  ).toBeGreaterThan(before);
});

test("refreshes Git and scrolls the exact visible Compare tree and diff from the root", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const viewport = page.viewportSize();
  await page.setViewportSize({ ...viewport, height: 360 });
  const counts = await installTaskGitFixture(page, [taskRecord()], {
    largeCompare: true,
    longDiff: true,
  });
  await page.goto(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview`,
  );

  const treeScroll = page.locator(
    "caffold-git-compare-page caffold-file-tree .file-tree-scroll",
  );
  const workspace = page.locator(".task-workspace-surface");
  const selector = page.locator("caffold-scroll-surface-selector > dialog:modal");
  const hud = page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await expect.poll(() => treeScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await activateActionHint(page, /Refresh compare$/);
  await expect.poll(() => counts.refs).toBe(2);
  await expect.poll(() => counts.compare).toBe(2);

  if (testInfo.project.name === "phone") {
    await workspace.focus();
    await page.keyboard.press("s");
    await expect(selector).toBeHidden();
    await expect(hud).toContainText("Scroll: Compared files");
    await page.keyboard.press("j");
    await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await treeScroll.evaluate((element) => {
      element.scrollTop = 0;
    });
  }

  await page
    .locator('caffold-git-compare-page button[data-file-tree-path="src/example.rs"]')
    .click();
  const diffScroll = page.locator(
    "caffold-git-compare-page caffold-review-file-viewer:not([hidden]) " +
      "caffold-diff-viewer .diff-lines",
  );
  await expect(diffScroll).toContainText("new compare 80");
  await expect.poll(() => diffScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  if (testInfo.project.name === "phone") {
    const refsBeforeFileRefresh = counts.refs;
    const compareBeforeFileRefresh = counts.compare;
    const compareDiffRequests = counts.compareDiff;
    await activateActionHint(page, /Refresh file$/);
    await expect.poll(() => counts.refs).toBe(refsBeforeFileRefresh + 1);
    await expect.poll(() => counts.compare).toBe(compareBeforeFileRefresh + 1);
    await expect.poll(() => counts.compareDiff).toBe(compareDiffRequests + 1);
  }

  await workspace.focus();
  await page.keyboard.press("s");
  if (testInfo.project.name === "phone") {
    await expect(selector).toBeHidden();
    await expect(hud).toContainText("Scroll: example.rs diff");
  } else {
    await expect(selector).toBeVisible();
    const badges = selector.locator("button[data-scroll-surface-code]");
    await expect(badges).toHaveCount(2);
    expect(new Set(await badges.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")
        .replace(/^[A-Z]+ — /, ""))
    ))).toEqual(new Set(["Compared files", "example.rs diff"]));

    await selector.getByLabel(/^[A-Z]+ — Compared files$/).click();
    const diffBeforeTreeScroll = await diffScroll.evaluate(
      (element) => element.scrollTop,
    );
    await page.keyboard.press("j");
    await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await diffScroll.evaluate((element) => element.scrollTop)).toBe(
      diffBeforeTreeScroll,
    );
    await page.keyboard.press("Escape");

    await workspace.focus();
    await page.keyboard.press("s");
    await selector.getByLabel(/^[A-Z]+ — example\.rs diff$/).click();
    await expect(hud).toContainText("Scroll: example.rs diff");
  }

  const treeBeforeDiffScroll = await treeScroll.evaluate(
    (element) => element.scrollTop,
  );
  await page.keyboard.press("j");
  await expect.poll(() => diffScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(
    treeBeforeDiffScroll,
  );
  await page.keyboard.press("Escape");
  await expect(hud).toBeHidden();
});

test("uses Log actions and scrolls the exact visible Commit tree and diff from the root", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const viewport = page.viewportSize();
  await page.setViewportSize({ ...viewport, height: 360 });
  await installTaskGitFixture(page, [taskRecord()], {
    commitBody: "Retained commit body for keyboard expansion.",
    largeCommit: true,
    largeLog: true,
    longDiff: true,
  });
  await page.goto(`/tasks/${THREAD_ID}/git/log`);

  const workspace = page.locator(".task-workspace-surface");
  const selector = page.locator("caffold-scroll-surface-selector > dialog:modal");
  const hud = page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  );
  const logScroll = page.locator("caffold-git-log-list-page .log-list");
  await expect.poll(() => logScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);

  await activateActionHint(page, /Expand commit body for abcdef1$/);
  const commitBodyToggle = page.locator(
    `caffold-git-log-list-page button[data-action="toggle-commit-body"]` +
      `[data-commit-sha="${COMMIT.sha}"]`,
  );
  await expect(commitBodyToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("caffold-git-log-list-page .log-body")).toHaveText(
    "Retained commit body for keyboard expansion.",
  );
  await activateActionHint(page, /Collapse commit body for abcdef1$/);
  await expect(commitBodyToggle).toHaveAttribute("aria-expanded", "false");

  await workspace.focus();
  await page.keyboard.press("s");
  await expect(selector).toBeHidden();
  await expect(hud).toContainText("Scroll: Git log");
  await page.keyboard.press("j");
  await expect.poll(() => logScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await logScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));

  await activateActionHint(
    page,
    new RegExp(`Open commit diff for ${COMMIT.shortSha} ${COMMIT.subject}$`),
  );
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}`);
  const treeScroll = page.locator(
    "caffold-git-log-commit-page caffold-file-tree .file-tree-scroll",
  );
  await expect.poll(() => treeScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  const commitSeparator = page.locator(
    "caffold-git-log-commit-page",
  ).getByRole("separator", { name: "Resize review side panel" });
  if (testInfo.project.name === "phone") {
    await expect(commitSeparator).toBeHidden();
    const commitHints = await enterActionHints(page);
    await expect(
      commitHints.getByLabel(/ — Resize review side panel$/),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  } else {
    const before = Number(
      await commitSeparator.getAttribute("aria-valuenow"),
    );
    await activateActionHint(page, "Resize review side panel");
    await expect(commitSeparator).toBeFocused();
    await commitSeparator.press("ArrowRight");
    await expect.poll(async () =>
      Number(await commitSeparator.getAttribute("aria-valuenow"))
    ).toBeGreaterThan(before);
  }

  const generatedDirectory = page.locator(
    'caffold-git-log-commit-page button[data-file-tree-path="generated"]',
  );
  const generatedFile = page.locator(
    'caffold-git-log-commit-page button[data-file-tree-relative-path="generated/commit-001.rs"]',
  );
  await expect(generatedDirectory).toHaveAccessibleName("Collapse generated");
  await expect(generatedDirectory).toHaveAttribute("aria-expanded", "true");
  await expect(generatedFile).toBeVisible();
  const directoryTop = await generatedDirectory.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const directoryHints = await enterActionHints(page);
  await expect(directoryHints.getByLabel(/Collapse generated$/)).toBeVisible();
  await captureReviewScreenshot(
    page,
    testInfo,
    "task-git-directory-disclosure-hints",
  );
  await page.keyboard.press("Escape");
  await activateActionHint(page, /Collapse generated$/);
  await expect(generatedDirectory).toHaveAccessibleName("Expand generated");
  await expect(generatedDirectory).toHaveAttribute("aria-expanded", "false");
  await expect(generatedFile).toHaveCount(0);
  await expect
    .poll(() =>
      generatedDirectory.evaluate(
        (element) => document.activeElement === element,
      )
    )
    .toBe(true);
  await expect
    .poll(() =>
      generatedDirectory.evaluate(
        (element) => element.getBoundingClientRect().top,
      )
    )
    .toBeCloseTo(directoryTop, 1);
  await activateActionHint(page, /Expand generated$/);
  await expect(generatedDirectory).toHaveAccessibleName("Collapse generated");
  await expect(generatedDirectory).toHaveAttribute("aria-expanded", "true");
  await expect(generatedFile).toBeVisible();

  if (testInfo.project.name === "phone") {
    await workspace.focus();
    await page.keyboard.press("s");
    await expect(selector).toBeHidden();
    await expect(hud).toContainText("Scroll: Commit files");
    await page.keyboard.press("j");
    await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await treeScroll.evaluate((element) => {
      element.scrollTop = 0;
    });
  }

  const exampleFile = page.locator(
    'caffold-git-log-commit-page button[data-file-tree-path="src/example.rs"]',
  );
  await exampleFile.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await activateActionHint(page, /Show commit diff for example\.rs$/);
  const diffScroll = page.locator(
    "caffold-git-log-commit-page caffold-review-file-viewer:not([hidden]) " +
      "caffold-diff-viewer .diff-lines",
  );
  await expect(diffScroll).toContainText("new commit 80");
  await expect.poll(() => diffScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await treeScroll.evaluate((element) => {
    element.scrollTop = 0;
  });

  await workspace.focus();
  await page.keyboard.press("s");
  if (testInfo.project.name === "phone") {
    await expect(selector).toBeHidden();
    await expect(hud).toContainText("Scroll: example.rs diff");
  } else {
    await expect(selector).toBeVisible();
    const badges = selector.locator("button[data-scroll-surface-code]");
    await expect(badges).toHaveCount(2);
    expect(new Set(await badges.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")
        .replace(/^[A-Z]+ — /, ""))
    ))).toEqual(new Set(["Commit files", "example.rs diff"]));
    await selector.getByLabel(/^[A-Z]+ — Commit files$/).click();
    await page.keyboard.press("j");
    await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await diffScroll.evaluate((element) => element.scrollTop)).toBe(0);
    await page.keyboard.press("Escape");

    await workspace.focus();
    await page.keyboard.press("s");
    await selector.getByLabel(/^[A-Z]+ — example\.rs diff$/).click();
  }
  const treeBeforeDiffScroll = await treeScroll.evaluate(
    (element) => element.scrollTop,
  );
  await page.keyboard.press("j");
  await expect.poll(() => diffScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(
    treeBeforeDiffScroll,
  );
  await page.keyboard.press("Escape");
  await expect(hud).toBeHidden();
});

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
  await expect
    .poll(() =>
      activeWatchSubscriptionId(page, {
        registryKey: GIT_WATCH_REGISTRY_KEY,
      }),
    )
    .not.toBeNull();
  const initialWatchSubscriptionId = await activeWatchSubscriptionId(page, {
    registryKey: GIT_WATCH_REGISTRY_KEY,
  });

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await expect(layout).toBeHidden();
  await expect(layout).toHaveAttribute("data-test-identity", "retained");
  await expect
    .poll(() =>
      isWatchSubscriptionClosed(page, initialWatchSubscriptionId, {
        registryKey: GIT_WATCH_REGISTRY_KEY,
      }),
    )
    .toBe(true);

  await chooseGitTool(page, "compare");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/compare`);
  await expect(layout).toHaveAttribute("data-test-identity", "retained");
  await expect.poll(() => counts.compare).toBe(2);
  await expect.poll(() => counts.refs).toBe(2);
  await expect
    .poll(() =>
      activeWatchSubscriptionId(page, {
        registryKey: GIT_WATCH_REGISTRY_KEY,
      }),
    )
    .not.toBeNull();
  const resumedWatchSubscriptionId = await activeWatchSubscriptionId(page, {
    registryKey: GIT_WATCH_REGISTRY_KEY,
  });
  expect(resumedWatchSubscriptionId).not.toBe(initialWatchSubscriptionId);

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
  await installTaskGitFixture(page, [taskRecord()], { logTotalPages: 2 });
  await page.goto(
    `/tasks/${THREAD_ID}/git/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  await waitForActionHintTarget(
    page,
    /Show compare diff for example\.rs$/,
  );
  await enterActionHints(page);
  await page.locator(".task-list-scroll").evaluate((scroller) => {
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(actionHintDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await activateActionHint(page, /Show compare diff for example\.rs$/);
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
  await expect(logCount).toHaveText("2 commits");
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
  await activateActionHint(page, /Older page$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log?page=2`);
  await activateActionHint(page, /Newest page$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log`);
  await expect(
    logPage.getByRole("button", { name: "Newest page" }),
  ).toBeDisabled();
  await activateActionHint(
    page,
    new RegExp(`Open commit diff for ${COMMIT.shortSha} ${COMMIT.subject}$`),
  );
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
  await activateActionHint(page, /Show commit diff for example\.rs$/);
  await expect(page).toHaveURL(
    `/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}&file=example.rs`,
  );
  const commitDiff = page.locator(".git-mode-log caffold-diff-viewer");
  await expect(commitDiff).toContainText("new commit");
  await page.reload();
  await expect(commitDiff).toContainText("new commit");

  await activateActionHint(page, /Show details for example\.rs$/);
  const fileViewer = page.locator(
    ".git-mode-log caffold-review-file-viewer:not([hidden])",
  );
  const detailsPopover = fileViewer.locator(".viewer-meta-popover");
  await expect(detailsPopover).toBeVisible();
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(detailsPopover).toBeVisible();
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await expect(detailsPopover).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(
    `/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}&file=example.rs`,
  );
  await expect(commitDiff).toContainText("new commit");

  const fileBack = page.getByRole("button", { name: "Back to commit" });
  if (await fileBack.isVisible()) {
    await activateActionHint(page, /Back to commit$/);
  } else {
    await page.goBack();
  }
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/git/log?sha=${COMMIT.sha}`);
  const back = page.getByRole("button", { name: "Back to log" });
  await expect(back).toBeVisible();
  await activateActionHint(page, /Back to log$/);
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

test("deactivates and rebinds the shared Git child when the selected Task changes", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const other = taskRecord("thread_task_git_other");
  await installTaskGitFixture(page, [taskRecord(), other]);
  await page.goto(`/tasks/${THREAD_ID}/git/log`);
  const layout = page.locator("caffold-task-git-layout");
  await expect(layout).toBeVisible();
  await layout.evaluate((element) => {
    element.dataset.testIdentity = "first-task";
  });

  const otherTask = page.locator(`.task-row[data-thread-id="${other.threadId}"]`);
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to tasks" }).click();
    await expect(page).toHaveURL("/");
  }
  await expect(otherTask).toBeVisible();
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
      eventRevision: revision,
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
