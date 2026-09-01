import { expect, test } from "@playwright/test";
import {
  actionHintBadgePresentation,
  actionHintDialog,
  activateActionHint,
  enterActionHints,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { TASK_PERMISSION_FIXTURE } from "../support/task-api-fixture.js";
import { expectDomainBackChrome } from "../support/domain-header.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const THREAD_ID = "thread_linked_worktree_github";
const WORKTREE_ROOT = "Users/taehoon/.codex/worktrees/4ce7/gluesql";
const PULL_FILE_PATH = `${WORKTREE_ROOT}/src/review.rs`;
const PULL_ROOT_FILE_PATH = `${WORKTREE_ROOT}/README.md`;
const PULL_BASE_OID = "1111111111111111111111111111111111111111";
const PULL_HEAD_OID = "2222222222222222222222222222222222222222";
const CREATED_THREAD_ID = "thread_github_task_created";
const LONG_GITHUB_NAME_WITH_OWNER =
  "owner-with-a-long-name/repository-with-a-long-name-that-must-stay-inside-the-task-detail-pane";
const CONSTRAINED_MARKDOWN_HTML = `
  <h1>Pane-owned GitHub Markdown</h1>
  <p>Ordinary paragraphs, headings, lists, and inline <code>contentOwnedByTheGitHubMarkdownParagraphEvenWhenTheInlineIdentifierIsLong</code> must reflow inside the Task Detail pane without making the page wider.</p>
  <ul>
    <li>Keep the complete GitHub detail readable in constrained master-detail layouts.</li>
    <li>Leave intrinsically wide content with its own bounded horizontal scrolling.</li>
  </ul>
  <pre><code>const intrinsicallyWideCodeLine = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";</code></pre>
  <table>
    <thead><tr><th>Owner</th><th>Intrinsically wide value</th></tr></thead>
    <tbody><tr><td>GitHub Markdown table</td><td>abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789</td></tr></tbody>
  </table>
`;
const LONG_ISSUE_TITLE =
  "Keep every Task-scoped GitHub Issue title, action, and ordinary Markdown descendant within the actual resizable detail pane";
const LONG_PULL_TITLE =
  "Keep every Task-scoped pull request title and all of its review actions reachable inside the actual resizable detail pane";

function linkedWorktreeTask() {
  const recencyMs = 1_785_700_000_000;
  return {
    id: THREAD_ID,
    threadId: THREAD_ID,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "테스트, 안녕",
    preview: "Linked worktree GitHub review",
    cwd: "Users/taehoon/Workspace/rust/gluesql",
    cwdPath: "Users/taehoon/Workspace/rust/gluesql",
    relativeCwd: "",
    worktree: {
      rootPath: WORKTREE_ROOT,
      branch: "query-plan-limit-offset",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      relativeCwd: "",
      linked: true,
    },
    createdMs: recencyMs,
    updatedMs: recencyMs,
    recencyMs,
    lastEventSummary: "Linked worktree GitHub review",
  };
}

async function installLinkedWorktreeGithubFixture(page, options = {}) {
  await installEventSourceMock(page, {
    registryKey: "__taskGithubEventSources",
    bootstrapFunctionKey: "__taskGithubDetailBootstrap",
  });
  await mockAgentModels(page);
  await page.route(/\/api\/agent\/permissions(?:\?|$)/, (route) =>
    route.fulfill({ json: TASK_PERMISSION_FIXTURE })
  );

  const task = linkedWorktreeTask();
  const repository = {
    rootPath: WORKTREE_ROOT,
    branch: "query-plan-limit-offset",
    dirty: false,
  };
  const github = {
    owner: "gluesql",
    name: "gluesql",
    nameWithOwner: options.githubNameWithOwner ?? "gluesql/gluesql",
    url: "https://github.com/gluesql/gluesql",
  };
  const counts = {
    issues: 0,
    issue: 0,
    pulls: 0,
    pull: 0,
    pullFiles: 0,
    pullFile: 0,
    gitRefs: 0,
    pullHeads: 0,
    taskCreates: 0,
    taskPrompts: 0,
  };
  const requests = {
    pullHeads: [],
    taskCreates: [],
    taskPrompts: [],
  };
  const controls = {
    pullHeadFailure: null,
    pullHeadGate: null,
  };
  const issue = {
    number: 1984,
    title: options.issueTitle ?? "Keep task GitHub lists fresh",
    state: "OPEN",
    author: "panarch",
    labels: [],
    comments: 0,
    body: "Fresh Task-owned Issue detail",
    bodyHtml: options.issueBodyHtml ?? "<p>Fresh Task-owned Issue detail</p>",
    createdAt: "2026-08-07T02:00:00Z",
    updatedAt: "2026-08-07T03:00:00Z",
    url: "https://github.com/gluesql/gluesql/issues/1984",
  };
  const pull = {
    number: 1983,
    title: options.pullTitle ?? "Reject unsupported table function arguments",
    state: "OPEN",
    draft: false,
    author: "kwondo1017",
    labels: [],
    comments: 1,
    reviews: 1,
    commits: 1,
    additions: 2,
    deletions: 1,
    changedFiles: 2,
    baseRefName: "main",
    baseRefOid: PULL_BASE_OID,
    baseRepository: {
      nameWithOwner: "gluesql/gluesql",
      url: "https://github.com/gluesql/gluesql",
    },
    headRefName: options.headRefName ?? "query-plan-limit-offset",
    headRefOid: PULL_HEAD_OID,
    headRepository: options.headRepository ?? {
      nameWithOwner: "gluesql/gluesql",
      url: "https://github.com/gluesql/gluesql",
    },
    body: "Task-owned Pull Request detail",
    bodyHtml: options.pullBodyHtml ?? "<p>Task-owned Pull Request detail</p>",
    createdAt: "2026-08-03T02:00:00Z",
    updatedAt: "2026-08-03T03:00:00Z",
    url: "https://github.com/gluesql/gluesql/pull/1983",
    conversationComments: [{
      author: "maintainer",
      body: "Please preserve the review workflow.",
      bodyHtml: "<p>Please preserve the review workflow.</p>",
      createdAt: "2026-08-03T02:30:00Z",
      updatedAt: "2026-08-03T02:30:00Z",
      url: "https://github.com/gluesql/gluesql/pull/1983#issuecomment-1",
    }],
    reviewComments: [{
      author: "reviewer",
      state: "CHANGES_REQUESTED",
      body: "Use the exact head.",
      bodyHtml: "<p>Use the exact head.</p>",
      submittedAt: "2026-08-03T02:45:00Z",
    }],
    commitSummaries: [],
  };
  const createdTask = {
    ...task,
    id: CREATED_THREAD_ID,
    threadId: CREATED_THREAD_ID,
    title: "Prepared GitHub source",
    preview: "Prepare this Caffold Task",
    createdMs: task.createdMs + 10,
    updatedMs: task.updatedMs + 10,
    recencyMs: task.recencyMs + 10,
  };
  const createdDetail = {
    threadId: CREATED_THREAD_ID,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task: createdTask,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: null,
    model: null,
    reasoningEffort: null,
  };
  const taskDetail = {
    threadId: THREAD_ID,
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
  };
  await page.exposeFunction("__taskGithubDetailBootstrap", (threadId) => {
    if (threadId === THREAD_ID) {
      return taskDetail;
    }
    return threadId === CREATED_THREAD_ID ? createdDetail : null;
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      counts.taskCreates += 1;
      requests.taskCreates.push(route.request().postDataJSON());
      return route.fulfill({ json: createdDetail });
    }
    const projection = activeTaskProjection([task]);
    if (options.sectionComposerSettings) {
      projection.sections[0].composerSettings = options.sectionComposerSettings;
    }
    return route.fulfill({ json: projection });
  });
  await page.route(new RegExp(`/api/tasks/${THREAD_ID}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail }),
  );
  await page.route(new RegExp(`/api/tasks/${CREATED_THREAD_ID}(?:\\?|$)`), (route) =>
    route.fulfill({ json: createdDetail }),
  );
  await page.route(
    new RegExp(`/api/tasks/${CREATED_THREAD_ID}/prompts(?:\\?|$)`),
    (route) => {
      counts.taskPrompts += 1;
      requests.taskPrompts.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          threadId: CREATED_THREAD_ID,
          turnId: "turn-created-github",
          userMessageId: "message-created-github",
          steered: false,
        },
      });
    },
  );
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({ json: { repository, additions: 0, deletions: 0, files: [] } }),
  );
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    counts.gitRefs += 1;
    return route.fulfill({
      json: {
        repository,
        refs: [
          { name: "query-plan-limit-offset", kind: "head" },
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "query-plan-limit-offset",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "query-plan-limit-offset",
      },
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path !== WORKTREE_ROOT) {
      return route.fulfill({
        json: {
          repository: null,
          github: null,
          ghAvailable: true,
          authenticated: true,
          issuesAvailable: false,
          pullsAvailable: false,
          message: "No GitHub remote detected",
        },
      });
    }
    return route.fulfill({
      json: {
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    counts.pulls += 1;
    const url = new URL(route.request().url());
    const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    return route.fulfill({
      json: {
        repository,
        github,
        state: "open",
        pulls: [
          {
            number: 1983,
            title: pull.title,
            state: "open",
            draft: false,
            author: "kwondo1017",
            labels: [],
            comments: 4,
            updatedAt: "2026-08-03T03:00:00Z",
            url: "https://github.com/gluesql/gluesql/pull/1983",
          },
        ],
        page: requestedPage,
        perPage: 50,
        totalPulls: 53,
        totalPages: 2,
        hasPrevious: requestedPage > 1,
        hasNext: requestedPage < 2,
      },
    });
  });

  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    counts.issues += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    return route.fulfill({
      json: {
        repository,
        github,
        state: "open",
        issues: [
          {
            number: 1984,
            title: issue.title,
            state: "open",
            author: "panarch",
            labels: [],
            comments: 0,
            updatedAt: "2026-08-07T03:00:00Z",
            url: "https://github.com/gluesql/gluesql/issues/1984",
          },
        ],
        page: 1,
        perPage: 50,
        totalIssues: 1,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      },
    });
  });
  await page.route(/\/api\/github\/issue(?:\?|$)/, (route) => {
    counts.issue += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1984");
    return route.fulfill({
      json: {
        repository,
        github,
        issue,
      },
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    counts.pull += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1983");
    return route.fulfill({
      json: {
        repository,
        github,
        pull,
      },
    });
  });
  await page.route(/\/api\/github\/pull-head(?:\?|$)/, async (route) => {
    counts.pullHeads += 1;
    const request = route.request().postDataJSON();
    requests.pullHeads.push(request);
    if (controls.pullHeadGate) {
      await controls.pullHeadGate;
    }
    if (controls.pullHeadFailure) {
      return route.fulfill({
        status: controls.pullHeadFailure.status,
        json: {
          error: {
            code: controls.pullHeadFailure.code,
            message: controls.pullHeadFailure.message,
          },
        },
      });
    }
    return route.fulfill({
      json: {
        repository,
        github,
        number: pull.number,
        headRef: `refs/caffold/github/pulls/${pull.number}/${pull.headRefOid}`,
        headOid: pull.headRefOid,
      },
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, (route) => {
    counts.pullFiles += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1983");
    return route.fulfill({
      json: {
        repository,
        github,
        number: 1983,
        files: [
          {
            path: PULL_FILE_PATH,
            repoRelativePath: "src/review.rs",
            previousPath: null,
            previousRepoRelativePath: null,
            status: "M",
            additions: 2,
            deletions: 1,
            changes: 3,
            patchAvailable: true,
            blobUrl: null,
            rawUrl: null,
          },
          {
            path: PULL_ROOT_FILE_PATH,
            repoRelativePath: "README.md",
            previousPath: null,
            previousRepoRelativePath: null,
            status: "M",
            additions: 0,
            deletions: 0,
            changes: 0,
            patchAvailable: false,
            blobUrl: null,
            rawUrl: null,
          },
        ],
        totalFiles: 2,
      },
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    counts.pullFile += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(WORKTREE_ROOT);
    expect(url.searchParams.get("number")).toBe("1983");
    expect(url.searchParams.get("file")).toBe(PULL_FILE_PATH);
    return route.fulfill({
      json: {
        repository,
        github,
        number: 1983,
        path: PULL_FILE_PATH,
        repoRelativePath: "src/review.rs",
        status: "M",
        kind: "PR #1983",
        additions: 2,
        deletions: 1,
        diff: "@@ -1 +1,2 @@\n-old review\n+new Task-owned review\n+fresh route",
        diffUnavailable: false,
        message: null,
      },
    });
  });

  return { task, repository, github, counts, requests, controls, pull };
}

async function chooseLinkedWorktreeGithubList(page, kind) {
  const summary = page.locator("caffold-task-detail-summary");
  const detailHeader = page.locator(".detail-layout-summary");
  await expect(summary).toContainText("query-plan-limit-offset");
  const popover = detailHeader.locator(
    "caffold-task-detail-github > .task-github-popover",
  );
  await detailHeader.getByRole("button", { name: "Open GitHub workspace" }).click();
  await expect(popover).toBeVisible();
  await detailHeader
    .locator(
      `caffold-task-detail-github button[data-github-button-action][data-review-kind="${kind}"]`,
    )
    .click();
  await expect(popover).toBeHidden();
}

async function openLinkedWorktreePullRequests(page) {
  await page.goto(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
}

async function openLinkedWorktreePull(page) {
  await openLinkedWorktreePullRequests(page);
  await page.locator('button[data-pull-number="1983"]').click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983`);
  return page.locator("caffold-github-pull-detail-page");
}

async function rootPullTreeNames(tree) {
  return tree
    .locator(
      ":scope .file-tree-rows > li:not([data-file-tree-parent-key]) .file-tree-name",
    )
    .allTextContents();
}

async function openLinkedWorktreeIssue(page) {
  await page.goto(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await activateActionHint(page, /Open issue #1984: Keep task GitHub lists fresh$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues/1984`);
  return page.locator("caffold-github-issue-detail-page");
}

async function taskGithubPaneGeometry(page, options = {}) {
  return page.locator("caffold-task-github-layout").evaluate((layout, geometryOptions) => {
    const detailPane = document.querySelector(".task-workspace-detail-pane");
    const navigationPane = document.querySelector(".task-workspace-master-pane");
    const detailBounds = detailPane.getBoundingClientRect();
    const elements = [
      ["layout", layout],
      ["surface", layout.querySelector(":scope > .task-github-surface")],
      ["domain header", layout.querySelector(".task-domain-header")],
      ["domain title", layout.querySelector(".task-domain-title")],
      ["domain subtitle", layout.querySelector(".task-domain-subtitle")],
      ["domain body", layout.querySelector(".task-domain-body")],
      ["mode", layout.querySelector(".github-review-view:not([hidden])")],
      ["page", layout.querySelector(geometryOptions.pageSelector)],
      ...geometryOptions.descendantSelectors.flatMap((selector) => {
        const matches = [...layout.querySelectorAll(selector)];
        return matches.length
          ? matches.map((element, index) => [`${selector} ${index}`, element])
          : [[`${selector} missing`, null]];
      }),
    ];
    const markdown = layout.querySelector(
      `${geometryOptions.pageSelector} caffold-github-markdown`,
    );
    const markdownRoot = markdown?.shadowRoot;
    const ordinaryMarkdownElements = [
      ...(markdownRoot?.querySelectorAll(".markdown-body, h1, p, ul") ?? []),
    ];
    for (const [index, element] of ordinaryMarkdownElements.entries()) {
      elements.push([`markdown ordinary ${index}`, element]);
    }
    const pre = markdownRoot?.querySelector("pre");
    const tableScroll = markdownRoot?.querySelector(".markdown-table-scroll");
    if (pre) {
      elements.push(["fenced code scroller", pre]);
    }
    if (tableScroll) {
      elements.push(["table scroller", tableScroll]);
    }

    const outsideDetail = elements
      .filter(([, element]) => {
        if (!element) {
          return true;
        }
        const bounds = element.getBoundingClientRect();
        return (
          bounds.width <= 0 ||
          bounds.left < detailBounds.left - 1 ||
          bounds.right > detailBounds.right + 1
        );
      })
      .map(([name]) => name);
    const title = layout.querySelector(geometryOptions.titleSelector);
    const domainSubtitle = layout.querySelector(".task-domain-subtitle");

    return {
      detailWidth: detailBounds.width,
      navigationWidth: navigationPane.getBoundingClientRect().width,
      outsideDetail,
      layoutHorizontalOverflow: layout.scrollWidth > layout.clientWidth + 1,
      pageHorizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      ordinaryMarkdownHorizontalOverflow: ordinaryMarkdownElements.some(
        (element) => element.scrollWidth > element.clientWidth + 1,
      ),
      domainSubtitleClipped:
        domainSubtitle.scrollWidth > domainSubtitle.clientWidth + 1,
      titleClipped: title.scrollWidth > title.clientWidth + 1,
      preOwnsOverflow: Boolean(pre && pre.scrollWidth > pre.clientWidth + 1),
      tableOwnsOverflow: Boolean(
        tableScroll && tableScroll.scrollWidth > tableScroll.clientWidth + 1,
      ),
    };
  }, options);
}

test("contains Issue list and detail content within the foldable Task pane", { tag: "@foldable" }, async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 933, height: 704 });
  await installLinkedWorktreeGithubFixture(page, {
    githubNameWithOwner: LONG_GITHUB_NAME_WITH_OWNER,
    issueTitle: LONG_ISSUE_TITLE,
    issueBodyHtml: CONSTRAINED_MARKDOWN_HTML,
  });
  await page.goto(`/tasks/${THREAD_ID}/github/issues`);

  const workspace = page.locator("caffold-task-workspace");
  const resizer = workspace.getByRole("separator", { name: "Resize navigation pane" });
  const issueButton = page.locator('button[data-issue-number="1984"]');
  await expect(resizer).toHaveAttribute("aria-valuenow", "380");
  await expect(issueButton).toContainText(LONG_ISSUE_TITLE);
  const listGeometry = await taskGithubPaneGeometry(page, {
    pageSelector: "caffold-github-issues-list-page",
    descendantSelectors: [
      "caffold-github-issues-layout",
      ".github-issues-panel",
      ".github-issues-list",
      ".github-issue-button",
    ],
    titleSelector: ".github-issue-title",
  });
  expect(listGeometry).toMatchObject({
    navigationWidth: 380,
    detailWidth: 553,
    outsideDetail: [],
    layoutHorizontalOverflow: false,
    pageHorizontalOverflow: false,
    ordinaryMarkdownHorizontalOverflow: false,
    domainSubtitleClipped: true,
    titleClipped: true,
  });

  await issueButton.click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues/1984`);
  const issueDetail = page.locator("caffold-github-issue-detail-page");
  await expect(issueDetail.getByRole("button", { name: "Start Task for issue #1984" })).toBeVisible();
  const detailGeometryOptions = {
    pageSelector: "caffold-github-issue-detail-page",
    descendantSelectors: [
      "caffold-github-issues-layout",
      ".github-issue-viewer-panel",
      ".github-issue-viewer-panel > header",
      ".github-issue-viewer-title-row",
      ".github-issue-actions",
      ".github-issue-actions > *",
      ".github-issue-body",
    ],
    titleSelector: ".github-issue-viewer-title-row h2",
  };
  const defaultGeometry = await taskGithubPaneGeometry(page, detailGeometryOptions);
  expect(defaultGeometry).toMatchObject({
    navigationWidth: 380,
    detailWidth: 553,
    outsideDetail: [],
    layoutHorizontalOverflow: false,
    pageHorizontalOverflow: false,
    ordinaryMarkdownHorizontalOverflow: false,
    domainSubtitleClipped: true,
    titleClipped: true,
    preOwnsOverflow: true,
    tableOwnsOverflow: true,
  });

  await resizer.focus();
  await resizer.press("End");
  await expect(resizer).toHaveAttribute("aria-valuenow", "413");
  const maximizedGeometry = await taskGithubPaneGeometry(page, detailGeometryOptions);
  expect(maximizedGeometry).toMatchObject({
    navigationWidth: 413,
    detailWidth: 520,
    outsideDetail: [],
    layoutHorizontalOverflow: false,
    pageHorizontalOverflow: false,
    ordinaryMarkdownHorizontalOverflow: false,
    domainSubtitleClipped: true,
    titleClipped: true,
    preOwnsOverflow: true,
    tableOwnsOverflow: true,
  });
  await captureReviewScreenshot(page, testInfo, "github-issue-detail-foldable-contained");

  await page.setViewportSize({ width: 900, height: 704 });
  await expect(resizer).toHaveAttribute("aria-valuenow", "380");
  const boundaryGeometry = await taskGithubPaneGeometry(page, detailGeometryOptions);
  expect(boundaryGeometry).toMatchObject({
    navigationWidth: 380,
    detailWidth: 520,
    outsideDetail: [],
    layoutHorizontalOverflow: false,
    pageHorizontalOverflow: false,
    ordinaryMarkdownHorizontalOverflow: false,
    domainSubtitleClipped: true,
    titleClipped: true,
    preOwnsOverflow: true,
    tableOwnsOverflow: true,
  });
});

test("keeps Pull Request headers, actions, and Markdown inside the foldable Task pane", { tag: "@foldable" }, async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 933, height: 704 });
  await installLinkedWorktreeGithubFixture(page, {
    githubNameWithOwner: LONG_GITHUB_NAME_WITH_OWNER,
    pullTitle: LONG_PULL_TITLE,
    pullBodyHtml: CONSTRAINED_MARKDOWN_HTML,
  });
  await page.goto(`/tasks/${THREAD_ID}/github/pulls`);

  const workspace = page.locator("caffold-task-workspace");
  const resizer = workspace.getByRole("separator", { name: "Resize navigation pane" });
  await resizer.focus();
  await resizer.press("End");
  await expect(resizer).toHaveAttribute("aria-valuenow", "413");
  const pullButton = page.locator('button[data-pull-number="1983"]');
  await expect(pullButton).toContainText(LONG_PULL_TITLE);
  const listGeometry = await taskGithubPaneGeometry(page, {
    pageSelector: "caffold-github-pulls-list-page",
    descendantSelectors: [
      "caffold-github-pulls-layout",
      ".github-pulls-panel",
      ".github-pulls-list",
      ".github-pull-button",
    ],
    titleSelector: ".github-pull-title > span",
  });
  expect(listGeometry).toMatchObject({
    navigationWidth: 413,
    detailWidth: 520,
    outsideDetail: [],
    layoutHorizontalOverflow: false,
    pageHorizontalOverflow: false,
    domainSubtitleClipped: true,
    titleClipped: true,
  });

  await pullButton.click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983`);
  const pullDetail = page.locator("caffold-github-pull-detail-page");
  await expect(pullDetail.getByRole("button", { name: "Start Task for pull request #1983" })).toBeVisible();
  await expect(pullDetail.getByRole("button", { name: "Open files for PR #1983" })).toBeVisible();
  await expect(pullDetail.getByRole("link", { name: "GitHub", exact: true }).first()).toBeVisible();
  const detailGeometry = await taskGithubPaneGeometry(page, {
    pageSelector: "caffold-github-pull-detail-page",
    descendantSelectors: [
      "caffold-github-pulls-layout",
      ".github-pull-viewer-panel",
      ".github-pull-viewer-panel > header",
      ".github-pull-viewer-title-row",
      ".github-pull-actions",
      ".github-pull-actions > *",
      ".github-pull-viewer-scroll",
      ".github-pull-body-section",
    ],
    titleSelector: ".github-pull-viewer-title-row h2",
  });
  expect(detailGeometry).toMatchObject({
    navigationWidth: 413,
    detailWidth: 520,
    outsideDetail: [],
    layoutHorizontalOverflow: false,
    pageHorizontalOverflow: false,
    ordinaryMarkdownHorizontalOverflow: false,
    domainSubtitleClipped: true,
    titleClipped: true,
    preOwnsOverflow: true,
    tableOwnsOverflow: true,
  });
  await captureReviewScreenshot(page, testInfo, "github-pull-detail-foldable-contained");
});

test("retains the same Task GitHub DOM and refreshes lists when reactivated", { tag: "@all-viewports" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);

  await openLinkedWorktreePullRequests(page);
  const githubLayout = page.locator("caffold-task-github-layout");
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText(
    "Reject unsupported table function arguments",
  );
  expect(fixture.counts.pulls).toBe(1);
  await githubLayout.evaluate((layout) => {
    layout.dataset.testIdentity = "retained";
  });

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await expect(githubLayout).toBeHidden();
  await expect(githubLayout).toHaveAttribute("data-test-identity", "retained");
  await page.waitForTimeout(150);
  expect(fixture.counts.pulls).toBe(1);

  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect.poll(() => fixture.counts.pulls).toBe(2);
  await expect(githubLayout).toHaveAttribute("data-test-identity", "retained");

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  const issuesPage = page.locator("caffold-github-issues-list-page");
  const domainHeader = githubLayout.locator(
    ":scope > .task-github-surface > .task-domain-header",
  );
  await expect(domainHeader.locator("h2")).toHaveText("Issues");
  await expect(domainHeader.locator(".task-domain-subtitle")).toHaveText(
    "gluesql/gluesql · 1 issues",
  );
  await expect(issuesPage).toContainText("Keep task GitHub lists fresh");
  await expect(issuesPage.locator(".github-issues-panel > header")).toHaveCount(0);
  expect(fixture.counts.issues).toBe(1);

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect.poll(() => fixture.counts.issues).toBe(2);
});

test("keeps loaded GitHub routes stable across unrelated Task stream updates", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.goto(`/tasks/${THREAD_ID}`);
  await chooseLinkedWorktreeGithubList(page, "issues");

  const issuesPage = page.locator("caffold-github-issues-list-page");
  await expect(issuesPage).toContainText("Keep task GitHub lists fresh");
  expect(fixture.counts.issues).toBe(1);
  await emitGithubTaskEvent(page, 2);
  await expect(issuesPage).toContainText("Keep task GitHub lists fresh");
  await expect(issuesPage).not.toContainText("Loading issues...");
  expect(fixture.counts.issues).toBe(1);

  await page.locator('button[data-issue-number="1984"]').click();
  const issueDetail = page.locator("caffold-github-issue-detail-page");
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  await expectDomainBackChrome(
    page.locator(
      "caffold-task-github-layout > .task-github-surface > .task-domain-header",
    ),
    "Back to issues",
  );
  expect(fixture.counts.issue).toBe(1);
  await emitGithubTaskEvent(page, 3);
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  expect(fixture.counts.issue).toBe(1);

  await chooseLinkedWorktreeGithubList(page, "pulls");
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  expect(fixture.counts.pulls).toBe(1);
  await emitGithubTaskEvent(page, 4);
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  await expect(pullsPage).not.toContainText("Loading pull requests...");
  expect(fixture.counts.pulls).toBe(1);

  await page.locator('button[data-pull-number="1983"]').click();
  const pullDetail = page.locator("caffold-github-pull-detail-page");
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");
  expect(fixture.counts.pull).toBe(1);
  await emitGithubTaskEvent(page, 5);
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");
  expect(fixture.counts.pull).toBe(1);

  await pullDetail.getByRole("button", { name: "Open files for PR #1983" }).click();
  const pullFile = page.locator(`button[data-file-tree-path="${PULL_FILE_PATH}"]`);
  await expect(pullFile).toBeVisible();
  expect(fixture.counts.pullFiles).toBe(1);
  await emitGithubTaskEvent(page, 6);
  await expect(pullFile).toBeVisible();
  expect(fixture.counts.pullFiles).toBe(1);

  await pullFile.click();
  const pullDiff = page.locator("caffold-github-pull-files-page caffold-diff-viewer");
  await expect(pullDiff).toContainText("new Task-owned review");
  expect(fixture.counts.pullFile).toBe(1);
  await emitGithubTaskEvent(page, 7);
  await expect(pullDiff).toContainText("new Task-owned review");
  expect(fixture.counts.pullFile).toBe(1);
});

test("applies the global ordering to GitHub PR Files without refetching", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  const pullDetail = await openLinkedWorktreePull(page);
  await pullDetail.getByRole("button", { name: "Open files for PR #1983" }).click();

  const tree = page.locator(
    "caffold-github-pull-files-tree caffold-file-tree",
  );
  await expect(tree).toBeVisible();
  await expect(
    tree.locator(`button[data-file-tree-path="${PULL_ROOT_FILE_PATH}"]`),
  ).toBeVisible();
  expect(await rootPullTreeNames(tree)).toEqual(["src", "README.md"]);
  expect(fixture.counts.pullFiles).toBe(1);

  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("name");
  });
  expect(await rootPullTreeNames(tree)).toEqual(["README.md", "src"]);
  expect(fixture.counts.pullFiles).toBe(1);
});

test("preserves Issue Start Task setup, focus return, and created Task selection", { tag: "@all-viewports" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  const issueDetail = await openLinkedWorktreeIssue(page);
  const opener = issueDetail.getByRole("button", {
    name: "Start Task for issue #1984",
  });
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  await opener.focus();
  await page.keyboard.press("f");
  const openerHint = actionHintDialog(page);
  const issueStartHint = openerHint.getByRole("button", {
    name: / — Start Task for issue #1984$/,
  });
  await expect(issueStartHint).toBeVisible();
  const issueStartCode = await issueStartHint.getAttribute(
    "data-action-hint-code",
  );
  expect(issueStartCode).toBeTruthy();
  await page.keyboard.type(issueStartCode.toLowerCase());
  await expect(openerHint).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("select[name='baseRef']")).toHaveValue("origin/main");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("f");
  const dialogHint = actionHintDialog(page);
  await expect(
    dialogHint.getByRole("button", { name: / — Start Task$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogHint).toBeHidden();
  await expect(dialog).toBeVisible();

  const modelButton = dialog.locator(".task-model-button");
  const modelPopover = dialog.locator(".task-model-popover");
  await modelButton.click();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("f");
  let hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — GPT-5\.6-Sol.*Selected$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modelPopover).toBeHidden();

  const permissionButton = dialog.locator(".task-permission-button");
  const permissionPopover = dialog.locator(".task-permission-popover");
  await permissionButton.click();
  await expect(permissionPopover).toBeVisible();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Approve for me.*Selected$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(permissionPopover).toBeVisible();

  await dialog.evaluate((element) => element.close("cancel"));
  await expect(dialog).toBeHidden();
  await expect(permissionPopover).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await dialog.locator("select[name='baseRef']").selectOption("main");
  const start = dialog.getByRole("button", { name: "Start Task" });
  await expect(start).toBeEnabled();
  await start.click();

  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
  const request = fixture.requests.taskCreates[0];
  expect(request.cwd).toBe(WORKTREE_ROOT);
  expect(request.titleSource).toContain("--- BEGIN UNTRUSTED ISSUE DATA ---");
  expect(request.titleSource).toContain("Selected base ref: main");
  expect(request.titleSource).toContain(
    "First, use rename_current_task to give this Task",
  );
  expect(request.titleSource).not.toContain("rename_current_thread");
  expect(request.titleSource).toContain('baseRef exactly "main"');
  expect(request.titleSource).toContain("includeChanges set to false");
  await expect.poll(() => fixture.counts.taskPrompts).toBe(1);
  expect(fixture.requests.taskPrompts[0]).toMatchObject({
    prompt: request.titleSource,
    activeTurnId: null,
  });
  await expect(page).toHaveURL(`/tasks/${CREATED_THREAD_ID}`);
});

test("owns Issue Task Start Hint, native select, Editing Escape, and Scroll contexts", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installLinkedWorktreeGithubFixture(page);
  const issueDetail = await openLinkedWorktreeIssue(page);
  const opener = issueDetail.getByRole("button", {
    name: "Start Task for issue #1984",
  });
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const select = dialog.locator("select[name='baseRef']");

  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(select).toHaveValue("origin/main");
  await cancel.focus();
  await page.keyboard.press("f");
  let hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(hint.locator('[data-action-hint-code="M"]')).toHaveAttribute(
    "aria-label",
    / — Choose model/,
  );
  for (const name of [
    / — Cancel$/,
    / — Start Task$/,
    / — Choose approval mode$/,
    / — Choose Base branch$/,
  ]) {
    await expect(hint.getByRole("button", { name })).toBeVisible();
  }
  await captureReviewScreenshot(
    page,
    testInfo,
    "github-issue-task-start-action-hints",
  );

  await page.keyboard.press("m");
  await expect(hint).toBeHidden();
  const modelPopover = dialog.locator(".task-model-popover");
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  await expect(
    hint.getByRole("button", { name: / — GPT-5\.6-Sol.*Selected$/ }),
  ).toBeVisible();
  await expect(hint.getByRole("button", { name: / — Start Task$/ }))
    .toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modelPopover).toBeHidden();

  await cancel.focus();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  const permissionHint = hint.getByRole("button", {
    name: / — Choose approval mode$/,
  });
  const permissionCode = await permissionHint.getAttribute(
    "data-action-hint-code",
  );
  expect(permissionCode).toBeTruthy();
  await page.keyboard.type(permissionCode.toLowerCase());
  await expect(hint).toBeHidden();
  const permissionPopover = dialog.locator(".task-permission-popover");
  await expect(permissionPopover).toBeVisible();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  await expect(
    hint.getByRole("button", { name: / — Approve for me.*Selected$/ }),
  ).toBeVisible();
  await expect(hint.getByRole("button", { name: / — Choose Base branch$/ }))
    .toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(permissionPopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(permissionPopover).toBeHidden();

  await cancel.focus();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  const baseHint = hint.getByRole("button", {
    name: / — Choose Base branch$/,
  });
  expect(await actionHintBadgePresentation(baseHint)).toEqual({
    backgroundMatches: true,
    borderVisible: true,
    colorMatches: true,
    hasBlockPadding: true,
    position: "absolute",
  });
  const baseCode = await baseHint.getAttribute("data-action-hint-code");
  expect(baseCode).toBeTruthy();
  await page.keyboard.type(baseCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(select).toBeFocused();
  await expect.poll(() => select.evaluate((element) => element.matches(":open")))
    .toBe(true);
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cancel).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(select).toHaveValue("origin/main");
  const body = dialog.locator(".github-task-start-body");
  const hud = dialog.locator(
    ":scope > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud",
  );
  await expect.poll(() => body.evaluate(
    (element) => element.scrollHeight <= element.clientHeight + 1,
  )).toBe(true);
  await cancel.focus();
  await page.keyboard.press("s");
  await expect(hud).toBeHidden();
  await body.evaluate((element) => {
    element.style.height = "120px";
    element.style.maxHeight = "120px";
  });
  await expect.poll(() => body.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await cancel.focus();
  await page.keyboard.press("s");
  await expect(hud).toContainText("Scroll: GitHub Task setup");
  await page.keyboard.press("j");
  await expect.poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(hud).toBeHidden();
  await expect(dialog).toBeVisible();
  await body.evaluate((element) => {
    if (element.scrollTop === 0) {
      return;
    }
    return new Promise((resolve) => {
      element.addEventListener("scroll", () => resolve(), { once: true });
      element.scrollTop = 0;
    });
  });

  await select.evaluate((element) => {
    element.showPicker = () => {
      throw new DOMException("Picker blocked by fixture", "NotAllowedError");
    };
  });
  await cancel.focus();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  const fallbackHint = hint.getByRole("button", {
    name: / — Choose Base branch$/,
  });
  const fallbackCode = await fallbackHint.getAttribute("data-action-hint-code");
  expect(fallbackCode).toBeTruthy();
  await page.keyboard.type(fallbackCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(select).toBeFocused();
  expect(await select.evaluate((element) => element.matches(":open"))).toBe(false);
  await select.evaluate((element) => {
    delete element.showPicker;
  });
  await page.keyboard.press("Escape");
  await expect(cancel).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("starts a Task from a Section-scoped GitHub Issue", { tag: "@desktop" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page, {
    sectionComposerSettings: {
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fastMode: true,
    },
  });
  await page.goto(
    "/?section=fixture-section-1&surface=github&tool=issues&number=1984",
  );

  await expect(
    page.locator("caffold-section-detail-summary h2"),
  ).toHaveText(WORKTREE_ROOT);
  const issueDetail = page.locator("caffold-github-issue-detail-page");
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  const opener = issueDetail.getByRole("button", {
    name: "Start Task for issue #1984",
  });
  await opener.click();

  const dialog = page.locator("caffold-github-task-start-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(() =>
    dialog.locator("caffold-task-turn-options").evaluate((options) =>
      options.submissionOptions()
    )
  ).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fastMode: true,
  });
  await dialog.locator("select[name='baseRef']").selectOption("main");
  await dialog.getByRole("button", {
    name: "Start Task",
    exact: true,
  }).click();

  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
  expect(fixture.requests.taskCreates[0].cwd).toBe(WORKTREE_ROOT);
  expect(fixture.requests.taskCreates[0]).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fastMode: true,
  });
  expect(fixture.requests.taskCreates[0].titleSource).toContain(
    "--- BEGIN UNTRUSTED ISSUE DATA ---",
  );
  await expect(page).toHaveURL(`/tasks/${CREATED_THREAD_ID}`);
});

test("names the tools a Claude Task actually has in its issue setup prompt", { tag: "@desktop" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page, {
    sectionComposerSettings: { model: "claude-opus-5" },
  });
  await page.route(/\/api\/agent\/models(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: "Latest frontier agentic coding model.",
            isDefault: true,
            defaultEffort: "low",
            efforts: ["low", "medium", "high"],
            supportsFastMode: true,
          },
          {
            provider: "claude",
            model: "claude-opus-5",
            displayName: "Claude Opus 5",
            description: "Anthropic's frontier agentic coding model.",
            isDefault: false,
            defaultEffort: "medium",
            efforts: ["low", "medium", "high"],
            supportsFastMode: false,
          },
        ],
        unavailable: [],
      }),
    }),
  );
  await page.goto(
    "/?section=fixture-section-1&surface=github&tool=issues&number=1984",
  );

  const issueDetail = page.locator("caffold-github-issue-detail-page");
  const opener = issueDetail.getByRole("button", {
    name: "Start Task for issue #1984",
  });
  await opener.click();
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(() =>
    dialog.locator("caffold-task-turn-options").evaluate((options) =>
      options.submissionOptions()
    )
  ).toMatchObject({ model: "claude-opus-5", provider: "claude" });
  await dialog.locator("select[name='baseRef']").selectOption("main");
  await dialog.getByRole("button", { name: "Start Task" }).click();

  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
  const request = fixture.requests.taskCreates[0];
  expect(request.provider).toBe("claude");
  expect(request.titleSource).toContain(
    "First, use mcp__caffold__rename_current_task to give this Task",
  );
  expect(request.titleSource).toContain(
    'call mcp__caffold__isolate_current_task with that branchName, baseRef exactly "main"',
  );
  expect(request.titleSource).not.toContain("rename_current_thread");
  await expect(page).toHaveURL(`/tasks/${CREATED_THREAD_ID}`);
});

test("starts a same-repository PR Task from the exact prepared head", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  const pullDetail = await openLinkedWorktreePull(page);
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  const opener = pullDetail.getByRole("button", {
    name: "Start Task for pull request #1983",
  });
  await opener.focus();
  await page.keyboard.press("f");
  const openerHint = actionHintDialog(page);
  await expect(
    openerHint.getByRole("button", { name: / — Open files for PR #1983$/ }),
  ).toBeVisible();
  const pullStartHint = openerHint.getByRole("button", {
    name: / — Start Task for pull request #1983$/,
  });
  await expect(pullStartHint).toBeVisible();
  const pullStartCode = await pullStartHint.getAttribute(
    "data-action-hint-code",
  );
  expect(pullStartCode).toBeTruthy();
  await page.keyboard.type(pullStartCode.toLowerCase());
  await expect(openerHint).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-pull-ref="base"]')).toContainText(
    "gluesql/gluesql:main @ 111111111111",
  );
  await expect(dialog.locator('[data-pull-ref="head"]')).toContainText(
    "gluesql/gluesql:query-plan-limit-offset @ 222222222222",
  );
  await expect(dialog.locator("select[name='baseRef']")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "github-pr-start-task-dialog");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  const startHint = hint.getByRole("button", { name: / — Start Task$/ });
  const startCode = await startHint.getAttribute("data-action-hint-code");
  expect(startCode).toBeTruthy();
  await page.keyboard.type(startCode.toLowerCase());
  await expect(hint).toBeHidden();

  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
  expect(fixture.requests.pullHeads).toEqual([{
    path: WORKTREE_ROOT,
    number: 1983,
    headOid: PULL_HEAD_OID,
    baseRepository: "gluesql/gluesql",
  }]);
  const prompt = fixture.requests.taskCreates[0].titleSource;
  expect(prompt).toContain("First, use rename_current_task to give this Task");
  expect(prompt).not.toContain("rename_current_thread");
  expect(prompt).toContain(`Head: gluesql/gluesql:query-plan-limit-offset @ ${PULL_HEAD_OID}`);
  expect(prompt).toContain(
    `Prepared local head ref: refs/caffold/github/pulls/1983/${PULL_HEAD_OID}`,
  );
  expect(prompt).toContain("Please preserve the review workflow.");
  expect(prompt).toContain("Use the exact head.");
  expect(prompt).toContain("do not review, analyze, or implement");
  expect(prompt).not.toContain("Review PR versus Continue work");
  await expect(page).toHaveURL(`/tasks/${CREATED_THREAD_ID}`);
});

test("keeps long PR refs in one shared horizontal scroll with sticky labels", { tag: "@all-viewports" }, async ({ page }) => {
  await installLinkedWorktreeGithubFixture(page, {
    headRefName:
      "perf/memory-storage-lazy-scan-with-an-intentionally-long-review-branch-name",
    headRepository: {
      nameWithOwner: "contributor-with-a-long-name/gluesql-experimental-fork",
      url: "https://github.com/contributor-with-a-long-name/gluesql-experimental-fork",
    },
  });
  const pullDetail = await openLinkedWorktreePull(page);
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  await pullDetail.getByRole("button", {
    name: "Start Task for pull request #1983",
  }).click();
  const relationship = dialog.locator("caffold-github-pull-task-source dl");
  await expect(relationship).toHaveAttribute("tabindex", "0");
  await expect(relationship.locator("dd").first()).toHaveCSS("white-space", "nowrap");

  const before = await relationship.evaluate((element) => {
    const [baseRow, headRow] = element.querySelectorAll(":scope > div");
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      baseLabelLeft: baseRow.querySelector("dt").getBoundingClientRect().left,
      headLabelLeft: headRow.querySelector("dt").getBoundingClientRect().left,
      baseValueLeft: baseRow.querySelector("dd").getBoundingClientRect().left,
      headValueLeft: headRow.querySelector("dd").getBoundingClientRect().left,
    };
  });
  expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);

  await relationship.evaluate((element) => {
    element.scrollLeft = 120;
  });
  await expect.poll(() => relationship.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const after = await relationship.evaluate((element) => {
    const [baseRow, headRow] = element.querySelectorAll(":scope > div");
    return {
      scrollLeft: element.scrollLeft,
      baseLabelLeft: baseRow.querySelector("dt").getBoundingClientRect().left,
      headLabelLeft: headRow.querySelector("dt").getBoundingClientRect().left,
      baseValueLeft: baseRow.querySelector("dd").getBoundingClientRect().left,
      headValueLeft: headRow.querySelector("dd").getBoundingClientRect().left,
    };
  });

  expect(after.baseLabelLeft).toBeCloseTo(before.baseLabelLeft, 0);
  expect(after.headLabelLeft).toBeCloseTo(before.headLabelLeft, 0);
  expect(before.baseValueLeft - after.baseValueLeft).toBeCloseTo(after.scrollLeft, 0);
  expect(before.headValueLeft - after.headValueLeft).toBeCloseTo(after.scrollLeft, 0);
});

test("starts a fork PR Task through the base repository pull ref", { tag: "@all-viewports" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page, {
    headRepository: {
      nameWithOwner: "contributor/gluesql",
      url: "https://github.com/contributor/gluesql",
    },
  });
  const pullDetail = await openLinkedWorktreePull(page);
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  await pullDetail.getByRole("button", {
    name: "Start Task for pull request #1983",
  }).click();
  await expect(dialog.locator('[data-pull-ref="base"]')).toContainText(
    "gluesql/gluesql:main",
  );
  await expect(dialog.locator('[data-pull-ref="head"]')).toContainText(
    "contributor/gluesql:query-plan-limit-offset",
  );
  await dialog.getByRole("button", { name: "Start Task" }).click();

  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
  expect(fixture.requests.pullHeads[0]).toEqual({
    path: WORKTREE_ROOT,
    number: 1983,
    headOid: PULL_HEAD_OID,
    baseRepository: "gluesql/gluesql",
  });
  expect(fixture.requests.taskCreates[0].titleSource).toContain(
    `Head: contributor/gluesql:query-plan-limit-offset @ ${PULL_HEAD_OID}`,
  );
});

test("keeps PR Task setup recoverable when the canonical head is unavailable", { tag: "@all-viewports" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  fixture.controls.pullHeadFailure = {
    status: 502,
    code: "github_pull_head_unavailable",
    message: "Pull request head is unavailable. Refresh the PR details and try again.",
  };
  const pullDetail = await openLinkedWorktreePull(page);
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  await pullDetail.getByRole("button", {
    name: "Start Task for pull request #1983",
  }).click();
  await dialog.getByRole("button", { name: "Start Task" }).click();
  await expect(dialog).toContainText("Pull request head is unavailable");
  await expect(dialog).toBeVisible();
  expect(fixture.counts.taskCreates).toBe(0);

  fixture.controls.pullHeadFailure = null;
  await dialog.getByRole("button", { name: "Start Task" }).click();
  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
});

test("requires an explicit PR refresh after the head moves", { tag: "@all-viewports" }, async ({ page }) => {
  const movedOid = "3333333333333333333333333333333333333333";
  const fixture = await installLinkedWorktreeGithubFixture(page);
  fixture.controls.pullHeadFailure = {
    status: 409,
    code: "github_pull_head_stale",
    message: `Pull request head moved from ${PULL_HEAD_OID} to ${movedOid}. Refresh the PR details before starting a Task.`,
  };
  const pullDetail = await openLinkedWorktreePull(page);
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  await pullDetail.getByRole("button", {
    name: "Start Task for pull request #1983",
  }).click();
  await dialog.getByRole("button", { name: "Start Task" }).click();
  await expect(dialog).toContainText("Pull request head moved");
  expect(fixture.counts.taskCreates).toBe(0);

  fixture.pull.headRefOid = movedOid;
  fixture.controls.pullHeadFailure = null;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  const refreshHint = hint.getByRole("button", { name: / — Refresh PR$/ });
  await expect(refreshHint).toBeVisible();
  await expect(hint.getByRole("button", { name: / — Choose Base branch$/ }))
    .toHaveCount(0);
  const refreshCode = await refreshHint.getAttribute("data-action-hint-code");
  expect(refreshCode).toBeTruthy();
  await page.keyboard.type(refreshCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(dialog.locator('[data-pull-ref="head"]')).toContainText(
    "@ 333333333333",
  );
  await dialog.getByRole("button", {
    name: "Start Task",
    exact: true,
  }).click();
  await expect.poll(() => fixture.counts.taskCreates).toBe(1);
  expect(fixture.requests.pullHeads.at(-1).headOid).toBe(movedOid);
});

test("invalidates a pending GitHub Task start when the GitHub surface deactivates", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  let releasePullHead;
  fixture.controls.pullHeadGate = new Promise((resolve) => {
    releasePullHead = resolve;
  });
  const pullDetail = await openLinkedWorktreePull(page);
  const dialog = page.locator("caffold-github-task-start-dialog > dialog");

  await pullDetail.getByRole("button", {
    name: "Start Task for pull request #1983",
  }).click();
  await dialog.getByRole("button", { name: "Start Task" }).click();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await page.locator("caffold-task-github-layout").evaluate((layout) => layout.deactivate());
  await expect(dialog).toBeHidden();

  releasePullHead();
  await expect.poll(() => fixture.counts.pullHeads).toBe(1);
  await page.waitForTimeout(50);
  expect(fixture.counts.taskCreates).toBe(0);
});

test("reloads a Task-scoped GitHub route from canonical Task context", { tag: "@all-viewports" }, async ({ page }) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.goto(`/tasks/${THREAD_ID}/github/pulls`);
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  const domainHeader = page.locator(
    "caffold-task-github-layout > .task-github-surface > .task-domain-header",
  );
  await expect(domainHeader.locator("h2")).toHaveText("Pull Requests");
  await expect(domainHeader.locator(".task-domain-subtitle")).toHaveText(
    "gluesql/gluesql · 53 PRs",
  );
  const domainHeaderGeometry = await domainHeader.evaluate((header) => {
    const headerStyle = getComputedStyle(header);
    const taskHeader = document.querySelector(".detail-layout-summary");
    const taskHeaderStyle = getComputedStyle(taskHeader);
    const domainTitleStyle = getComputedStyle(
      header.querySelector(".task-domain-title h2"),
    );
    const taskTitleStyle = getComputedStyle(
      taskHeader.querySelector(".task-detail-heading > h2"),
    );
    return {
      height: header.getBoundingClientRect().height,
      minimumHeight: Number.parseFloat(headerStyle.minHeight),
      paddingMatchesTask:
        Math.abs(
          Number.parseFloat(headerStyle.paddingRight) -
            Number.parseFloat(taskHeaderStyle.paddingRight),
        ) <= 1,
      symmetricPadding:
        Math.abs(
          Number.parseFloat(headerStyle.paddingLeft) -
            Number.parseFloat(headerStyle.paddingRight),
        ) <= 1,
      titleSizeMatchesTask:
        Math.abs(
          Number.parseFloat(domainTitleStyle.fontSize) -
            Number.parseFloat(taskTitleStyle.fontSize),
        ) <= 0.1,
    };
  });
  expect(domainHeaderGeometry.height).toBeCloseTo(
    domainHeaderGeometry.minimumHeight,
    0,
  );
  expect(domainHeaderGeometry).toMatchObject({
    paddingMatchesTask: true,
    symmetricPadding: true,
    titleSizeMatchesTask: true,
  });
  await expect(pullsPage.locator(".github-pulls-panel > header")).toHaveCount(0);
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await expect(page.locator("caffold-review-workspace")).toHaveCount(0);
  expect(fixture.counts.pulls).toBe(1);

  await page.reload();
  await expect(pullsPage).toContainText("Reject unsupported table function arguments");
  await expect.poll(() => fixture.counts.pulls).toBe(2);
});

test("navigates and reloads Task-scoped Issue, PR, and PR file routes", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.goto(`/tasks/${THREAD_ID}`);
  await activateActionHint(page, /Open GitHub workspace$/);
  const githubPopover = page.locator(
    ".detail-layout-summary caffold-task-detail-github > .task-github-popover",
  );
  await expect(githubPopover).toBeVisible();
  await page.keyboard.press("s");
  await expect(
    githubPopover.locator("caffold-scroll-mode-hud .scroll-mode-status"),
  ).toBeHidden();
  await page.keyboard.press("f");
  const githubHint = actionHintDialog(page);
  await expect(githubHint).toBeVisible();
  await expect(
    githubHint.getByRole("button", { name: / — Pull Requests$/ }),
  ).toBeVisible();
  const issues = githubHint.getByRole("button", { name: / — Issues$/ });
  await expect(issues).toHaveAttribute("data-match", "true");
  await expect.poll(() => actionHintBadgePresentation(issues)).toEqual({
    backgroundMatches: true,
    borderVisible: true,
    colorMatches: true,
    hasBlockPadding: true,
    position: "absolute",
  });
  const issuesCode = await issues.getAttribute("data-action-hint-code");
  expect(issuesCode).toBeTruthy();
  await page.keyboard.type(issuesCode.toLowerCase());
  await expect(githubPopover).toBeHidden();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues`);
  await page.reload();
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  await page.locator('button[data-issue-number="1984"]').click();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues/1984`);
  const issueDetail = page.locator("caffold-github-issue-detail-page");
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");

  await page.goBack();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues`);
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  await page.goForward();
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues/1984`);
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  await page.reload();
  await expect(issueDetail).toContainText("Fresh Task-owned Issue detail");
  expect(fixture.counts.issue).toBeGreaterThanOrEqual(3);

  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
  await activateActionHint(page, /Older pull request page$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls?page=2`);
  await activateActionHint(page, /Newest pull request page$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
  await activateActionHint(
    page,
    /Open pull request #1983: Reject unsupported table function arguments$/,
  );
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983`);
  const pullDetail = page.locator("caffold-github-pull-detail-page");
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");
  await page.reload();
  await expect(pullDetail).toContainText("Task-owned Pull Request detail");

  const pullHints = await enterActionHints(page);
  await expect(
    pullHints.getByLabel(/Start Task for pull request #1983$/),
  ).toBeVisible();
  await expect(pullHints.getByLabel(/GitHub$/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await activateActionHint(page, /Open files for PR #1983$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983/files`);
  const pullFile = page.locator(`button[data-file-tree-path="${PULL_FILE_PATH}"]`);
  await expect(pullFile).toBeVisible();
  await page.reload();
  await expect(pullFile).toBeVisible();

  await activateActionHint(page, /Show pull request diff for src\/review\.rs$/);
  await expect(page).toHaveURL(
    `/tasks/${THREAD_ID}/github/pulls/1983/files?file=src%2Freview.rs`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new Task-owned review",
  );
  await page.reload();
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new Task-owned review",
  );
  expect(fixture.counts.pullFile).toBeGreaterThanOrEqual(2);

  await activateActionHint(page, /Show details for .*review\.rs$/);
  const fileViewer = page.locator(
    "caffold-github-pull-files-page caffold-review-file-viewer:not([hidden])",
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
    `/tasks/${THREAD_ID}/github/pulls/1983/files?file=src%2Freview.rs`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText(
    "new Task-owned review",
  );

  const fileBack = page.getByRole("button", { name: "Back to files" });
  if (await fileBack.isVisible()) {
    await activateActionHint(page, /Back to files$/);
  } else {
    await page.goBack();
  }
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983/files`);
  await expect(pullFile).toBeVisible();
  await activateActionHint(page, /Back to PR$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls/1983`);
  await expect(pullDetail).toBeVisible();
  await expect(page.locator("caffold-github-pull-files-page")).toBeHidden();
  const backToPulls = page.getByRole("button", {
    name: "Back to pull requests",
  });
  await backToPulls.scrollIntoViewIfNeeded();
  await expect(backToPulls).toBeInViewport();
  await activateActionHint(page, /Back to pull requests$/);
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/pulls`);
});

test("rejects an inactive GitHub list response before the cached child is reactivated", { tag: "@all-viewports" }, async ({ page }) => {
  await installLinkedWorktreeGithubFixture(page);
  await page.unroute(/\/api\/github\/pulls(?:\?|$)/);
  const pendingRoutes = [];
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    pendingRoutes.push(route);
  });
  await openLinkedWorktreePullRequests(page);
  await expect.poll(() => pendingRoutes.length).toBe(1);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await pendingRoutes[0].fulfill({
    json: githubPullsResponse("Stale pull request"),
  });

  await chooseLinkedWorktreeGithubList(page, "pulls");
  await expect.poll(() => pendingRoutes.length).toBe(2);
  await pendingRoutes[1].fulfill({
    json: githubPullsResponse("Fresh pull request"),
  });
  const pullsPage = page.locator("caffold-github-pulls-list-page");
  await expect(pullsPage).toContainText("Fresh pull request");
  await expect(pullsPage).not.toContainText("Stale pull request");
});

test("stops an older GitHub activation before it loads content for a replaced route", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const fixture = await installLinkedWorktreeGithubFixture(page);
  await page.unroute(/\/api\/github\/status(?:\?|$)/);
  const pendingStatus = [];
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    pendingStatus.push(route);
  });

  await page.goto(`/tasks/${THREAD_ID}/github/pulls`);
  await expect.poll(() => pendingStatus.length).toBe(1);
  await chooseLinkedWorktreeGithubList(page, "issues");
  await expect(page).toHaveURL(`/tasks/${THREAD_ID}/github/issues`);
  await expect.poll(() => pendingStatus.length).toBe(2);

  await pendingStatus[0].fulfill({
    json: githubStatusResponse(fixture.repository, fixture.github),
  });
  await page.waitForTimeout(100);
  expect(fixture.counts.pulls).toBe(0);
  expect(fixture.counts.issues).toBe(0);

  await pendingStatus[1].fulfill({
    json: githubStatusResponse(fixture.repository, fixture.github),
  });
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep task GitHub lists fresh",
  );
  expect(fixture.counts.pulls).toBe(0);
  expect(fixture.counts.issues).toBe(1);
});

function githubStatusResponse(repository, github) {
  return {
    repository,
    github,
    ghAvailable: true,
    authenticated: true,
    issuesAvailable: true,
    pullsAvailable: true,
    message: null,
  };
}

function githubPullsResponse(title) {
  return {
    repository: {
      rootPath: WORKTREE_ROOT,
      branch: "query-plan-limit-offset",
      dirty: false,
    },
    github: {
      owner: "gluesql",
      name: "gluesql",
      nameWithOwner: "gluesql/gluesql",
      url: "https://github.com/gluesql/gluesql",
    },
    state: "open",
    pulls: [{
      number: 1983,
      title,
      state: "open",
      draft: false,
      author: "panarch",
      labels: [],
      comments: 0,
      updatedAt: "2026-08-03T03:00:00Z",
      url: "https://github.com/gluesql/gluesql/pull/1983",
    }],
    page: 1,
    perPage: 50,
    totalPulls: 1,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  };
}

async function emitGithubTaskEvent(page, revision) {
  await page.evaluate(({ threadId, revision }) => {
    const source = window.__taskGithubEventSources.find((candidate) =>
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
        id: `event_domain_render_${revision}`,
        threadId,
        type: "assistant_message",
        payload: { text: `Task update ${revision}` },
      },
    });
  }, { threadId: THREAD_ID, revision });
}
