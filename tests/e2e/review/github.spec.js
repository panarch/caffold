import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
  mockCodexModels,
} from "../support/task-fixtures.js";
import { taskDetailFixture } from "../support/task-api-fixture.js";
import {
  openHeaderActionGroup,
  expectFileTreeDensity,
} from "../support/header-actions.js";
import {
  expectGlobalScrollLocked,
  elementWidth,
  dragHorizontalResizer,
  expectMobileReviewDetail,
  expectAlignedWorkspaceHeaders,
  expectMatchingPaneTitleSizes,
} from "../support/review-layout.js";
import {
  FILES_HOME_URL,
} from "../support/file-browser-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("opens GitHub issues from the header", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "feature/review", dirty: false };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const issues = [
    {
      number: 42,
      title: "Track mobile review issues",
      state: "OPEN",
      author: "taehoon",
      labels: ["review", "mobile"],
      assignees: [],
      comments: 3,
      updatedAt: "2026-07-01T10:00:00Z",
      url: "https://github.com/example/caffold/issues/42",
    },
    {
      number: 41,
      title: "Keep readonly GitHub access narrow",
      state: "OPEN",
      author: "codex",
      labels: ["github"],
      assignees: ["taehoon"],
      comments: 0,
      updatedAt: "2026-07-01T09:00:00Z",
      url: "https://github.com/example/caffold/issues/41",
    },
  ];
  const olderIssues = [
    {
      number: 7,
      title: "Older issue still reachable by pagination",
      state: "OPEN",
      author: "taehoon",
      labels: ["pagination"],
      assignees: [],
      comments: 1,
      updatedAt: "2026-06-30T09:00:00Z",
      url: "https://github.com/example/caffold/issues/7",
    },
  ];

  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    });
  });

  await page.route(/\/api\/github\/issues(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    if (pageNumber === 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 260);
      });
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: pageNumber === 2 ? olderIssues : issues,
        page: pageNumber,
        perPage: 50,
        totalIssues: 75,
        totalPages: 2,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < 2,
      }),
    });
  });

  await page.route(/\/api\/github\/issue(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("42");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        issue: {
          ...issues[0],
          body: "**Review** GitHub issues without leaving the readonly console.\n\n```sh\ncargo test\n```",
          bodyHtml: `
            <h2>Review Steps</h2>
            <p><strong>Review</strong> GitHub issues without leaving the readonly console.</p>
            <pre><code>cargo test</code></pre>
            <table>
              <thead>
                <tr><th>Feature</th><th>Status</th><th>Notes</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Long markdown table support</td>
                  <td>Ready</td>
                  <td>Preserve readable columns without splitting words on phone-width review screens</td>
                </tr>
              </tbody>
            </table>
            <a href="https://example.com/docs">docs</a>
            <a href="javascript:alert(1)">unsafe</a>
            <script>alert(1)</script>
          `,
          createdAt: "2026-07-01T08:00:00Z",
        },
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-file-tree-path="src"]').click();

  const githubPopover = await openHeaderActionGroup(page, "github");
  const issuesButton = githubPopover.locator(
    'button[data-action="open-github-issues-workspace"]',
  );
  await expect(issuesButton.locator(".header-menu-label")).toHaveText("Issues");
  await issuesButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "github");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issues");
  await expect(workspace.locator(".review-workspace-subtitle")).toHaveText(
    "example/caffold · 75 issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Track mobile review issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep readonly GitHub access narrow",
  );
  await expect(page.locator("caffold-github-issues-list-page .github-issues-count")).toHaveText(
    "75 issues",
  );
  const issuePagination = page.locator("caffold-github-issues-list-page caffold-pagination");
  await expect(issuePagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(issuePagination.getByRole("button", { name: "Newest issue page" })).toBeDisabled();
  await expect(issuePagination.getByRole("button", { name: "Newer issue page" })).toBeDisabled();
  await expect(page.locator("caffold-github-issues-list-page")).toBeVisible();
  await expect(page.locator("caffold-github-issue-detail-page")).toBeHidden();
  await expectAlignedWorkspaceHeaders(page, [
    "caffold-review-workspace .review-workspace-header",
    "caffold-github-issues-list-page .github-issues-panel > header",
  ]);
  await expectMatchingPaneTitleSizes(page, [
    "caffold-github-issues-list-page .github-issues-panel > header",
  ]);
  await captureReviewScreenshot(page, testInfo, "github-issues-list");

  await page.locator('button[data-issue-number="42"]').click();
  const issueViewer = page.locator("caffold-github-issue-detail-page");
  await expect(workspace).toHaveAttribute("data-workspace-mode", "github");
  await expect(workspace.locator(".github-mode-issues")).toHaveAttribute(
    "data-issues-view",
    "detail",
  );
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issue");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "#42 Track mobile review issues",
  );
  await expect(workspace.getByRole("button", { name: "Back to issues" })).toBeVisible();
  await expect(page.locator("caffold-github-issues-list-page")).toBeHidden();
  await expect(issueViewer).toBeVisible();
  await expect(issueViewer).toContainText("Track mobile review issues");
  await expect(issueViewer).toContainText("3 comments");
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to issues",
      detailSelector: "caffold-github-issue-detail-page",
      listSelector: "caffold-github-issues-list-page",
    });
  }
  const markdownViewer = issueViewer.locator("caffold-github-markdown");
  await expect(markdownViewer).toBeVisible();
  await expect(markdownViewer.locator("h2")).toHaveText("Review Steps");
  await expect(markdownViewer.locator("strong")).toHaveText("Review");
  await expect(markdownViewer.locator("pre")).toContainText("cargo test");
  const markdownSafety = await markdownViewer.evaluate((element) => {
    const root = element.shadowRoot;
    const docsLink = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "docs",
    );
    const unsafeLink = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "unsafe",
    );

    return {
      scripts: root.querySelectorAll("script").length,
      docsTarget: docsLink?.getAttribute("target"),
      docsRel: docsLink?.getAttribute("rel"),
      unsafeLinkPresent: Boolean(unsafeLink),
      unsafeHref: unsafeLink?.getAttribute("href") ?? null,
    };
  });
  expect(markdownSafety).toEqual({
    scripts: 0,
    docsTarget: "_blank",
    docsRel: "noreferrer",
    unsafeLinkPresent: false,
    unsafeHref: null,
  });
  const markdownLayout = await markdownViewer.evaluate((element) => {
    const root = element.shadowRoot;
    const wrapper = root.querySelector(".markdown-table-scroll");
    const cell = root.querySelector("td");
    const hostStyle = getComputedStyle(element);
    const headingStyle = getComputedStyle(root.querySelector("h2"));
    const cellStyle = getComputedStyle(cell);

    return {
      hasTableScrollWrapper: Boolean(wrapper),
      tableScrolls: wrapper ? wrapper.scrollWidth > wrapper.clientWidth : false,
      cellWhiteSpace: cellStyle.whiteSpace,
      hostFontSize: hostStyle.fontSize,
      headingFontSize: headingStyle.fontSize,
    };
  });
  expect(markdownLayout).toMatchObject({
    hasTableScrollWrapper: true,
    cellWhiteSpace: "nowrap",
    hostFontSize: "14px",
  });
  expect(Number.parseFloat(markdownLayout.headingFontSize)).toBeGreaterThan(14);
  if (testInfo.project.name === "phone") {
    expect(markdownLayout.tableScrolls).toBe(true);
  }
  await expect(issueViewer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/example/caffold/issues/42",
  );
  await captureReviewScreenshot(page, testInfo, "github-issue-detail");

  if (testInfo.project.name === "phone") {
    await issueViewer.getByRole("button", { name: "Back to issues" }).click();
  } else {
    await workspace.getByRole("button", { name: "Back to issues" }).click();
  }
  await expect(workspace.locator(".github-mode-issues")).toHaveAttribute(
    "data-issues-view",
    "list",
  );
  await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issues");
  await expect(page.locator("caffold-github-issues-list-page")).toBeVisible();
  await expect(issueViewer).toBeHidden();

  await issuePagination.getByRole("button", { name: "Oldest issue page" }).click();
  await page.waitForTimeout(220);
  await expect(page.locator("caffold-github-issues-list-page .github-issues-loading-body")).toHaveText(
    "Loading issues...",
  );
  await expect(page.locator("caffold-github-issues-list-page")).not.toContainText(
    "Track mobile review issues",
  );
  await expect(issuePagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(issuePagination.getByRole("button", { name: "Newest issue page" })).toBeEnabled();
  await expect(issuePagination.getByRole("button", { name: "Oldest issue page" })).toBeDisabled();
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Older issue still reachable by pagination",
  );
  await expect(page.locator("caffold-github-issues-list-page")).not.toContainText("Loading issues...");
  await expect(issuePagination.getByRole("button", { name: "Older issue page" })).toBeDisabled();
  await expect(issuePagination.getByRole("button", { name: "Oldest issue page" })).toBeDisabled();
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "github-issues-page-2");
});

test("starts a setup-only Task from a GitHub issue with a selected base", async (
  { page },
  testInfo,
) => {
  if (testInfo.project.name === "phone") {
    await page.addInitScript(() => {
      localStorage.setItem(
        "caffold:settings",
        JSON.stringify({
          appearanceVersion: 3,
          typefacePreset: "d2-coding",
          interfaceScalePercent: 120,
          conversationTextPx: 17,
          codeTextPx: 15,
        }),
      );
    });
  }
  const repository = { rootPath: "src", branch: "feature/review", dirty: true };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const issue = {
    number: 62,
    title: "Consolidate Files, Git, and GitHub under Task Detail ownership",
    state: "OPEN",
    author: "taehoon",
    labels: ["tasks"],
    assignees: [],
    comments: 0,
    updatedAt: "2026-08-11T08:00:00Z",
    createdAt: "2026-08-11T07:00:00Z",
    url: "https://github.com/example/caffold/issues/62",
    body: "Prepare a Task without starting implementation.",
    bodyHtml: "<p>Prepare a Task without starting implementation.</p>",
  };
  const submittedBodies = [];
  let releaseRefsRequest;
  let markRefsRequestStarted;
  let releaseFirstRequest;
  let markFirstRequestStarted;
  const refsRequestRelease = new Promise((resolve) => {
    releaseRefsRequest = resolve;
  });
  const refsRequestStarted = new Promise((resolve) => {
    markRefsRequestStarted = resolve;
  });
  const firstRequestRelease = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const firstRequestStarted = new Promise((resolve) => {
    markFirstRequestStarted = resolve;
  });
  const createdDetail = taskDetailFixture({
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    fastMode: true,
  });
  createdDetail.task.title = "GitHub issue #62";
  createdDetail.task.preview = "Prepare issue #62";
  createdDetail.events = [
    {
      id: "event-setup-62",
      threadId: "thread-1",
      type: "user_message",
      summary: "Task setup requested",
      payload: { turnId: "turn-1", text: "Prepare GitHub issue #62" },
      createdMs: 2,
    },
  ];

  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor() {
        this.listeners = new Map();
        this.readyState = 0;
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      close() {
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    }),
  );
  await page.route(/\/api\/github\/issue(?:\?|$)/, (route) =>
    route.fulfill({ json: { repository, github, issue } }),
  );
  await page.route(/\/api\/git\/refs(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    markRefsRequestStarted();
    await refsRequestRelease;
    return route.fulfill({
      json: {
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
          { name: "origin/release", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
      },
    });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          tasks: submittedBodies.length >= 2 ? [createdDetail.task] : [],
          nextCursor: null,
        },
      });
    }
    submittedBodies.push(route.request().postDataJSON());
    if (submittedBodies.length === 1) {
      markFirstRequestStarted();
      await firstRequestRelease;
      return route.fulfill({
        status: 422,
        json: { error: "Task setup failed" },
      });
    }
    return route.fulfill({ json: createdDetail });
  });
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: createdDetail }),
  );

  await page.goto("/github/issues/62?cwd=src");
  const issueViewer = page.locator("caffold-github-issue-detail-page");
  const opener = issueViewer.getByRole("button", {
    name: "Start Task for issue #62",
  });
  await expect(opener).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(opener.locator(".github-issue-start-label")).toBeVisible();
    const narrowDesktopHeader = await issueViewer.evaluate((element) => {
      const panel = element.querySelector(".github-issue-viewer-panel");
      const close = element.querySelector(".github-issue-close-button");
      const start = element.querySelector(".github-issue-start-button");
      const title = element.querySelector("h2");
      const startBox = start.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      const lineHeight = Number.parseFloat(titleStyle.lineHeight) || 1;

      return {
        closeVisible: getComputedStyle(close).display !== "none",
        startIsLabeled: startBox.width > startBox.height,
        titleIsClipped: title.scrollHeight > title.clientHeight + 1,
        titleLines: Math.round(titleBox.height / lineHeight),
        titleWhiteSpace: titleStyle.whiteSpace,
        panelOverflows: panel.scrollWidth > panel.clientWidth + 1,
      };
    });
    expect(narrowDesktopHeader).toMatchObject({
      closeVisible: true,
      startIsLabeled: true,
      titleIsClipped: false,
      titleWhiteSpace: "normal",
      panelOverflows: false,
    });
    expect(narrowDesktopHeader.titleLines).toBeGreaterThanOrEqual(1);
    expect(narrowDesktopHeader.titleLines).toBeLessThanOrEqual(2);
    await captureReviewScreenshot(
      page,
      testInfo,
      "github-issue-start-task-entry-narrow-desktop",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  if (testInfo.project.name === "phone") {
    await expect(opener.locator(".github-issue-start-label")).toBeHidden();
    const mobileHeader = await issueViewer.evaluate((element) => {
      const panel = element.querySelector(".github-issue-viewer-panel");
      const close = element.querySelector(".github-issue-close-button");
      const start = element.querySelector(".github-issue-start-button");
      const title = element.querySelector("h2");
      const closeStyle = getComputedStyle(close);
      const startStyle = getComputedStyle(start);
      const closePaint = getComputedStyle(close, "::before");
      const startPaint = getComputedStyle(start, "::before");
      const closeIcon = close.querySelector("svg").getBoundingClientRect();
      const startIcon = start.querySelector("svg").getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      const startBox = start.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      const number = (value) => Number.parseFloat(value) || 0;
      const visualWidth = (box, paint) =>
        box.width - number(paint.left) - number(paint.right);

      return {
        closeHitSize: closeBox.width,
        startHitSize: startBox.width,
        closeVisualSize: visualWidth(closeBox, closePaint),
        startVisualSize: visualWidth(startBox, startPaint),
        closeBorderWidth: closeStyle.borderTopWidth,
        startBorderWidth: startStyle.borderTopWidth,
        closePaintBorderWidth: closePaint.borderTopWidth,
        startPaintBorderWidth: startPaint.borderTopWidth,
        closeIconSize: closeIcon.width,
        startIconSize: startIcon.width,
        closeIconCenterDelta: Math.abs(
          closeIcon.left + closeIcon.width / 2 -
            (closeBox.left + closeBox.width / 2),
        ),
        startIconCenterDelta: Math.abs(
          startIcon.left + startIcon.width / 2 -
            (startBox.left + startBox.width / 2),
        ),
        titleLines: Math.round(titleBox.height / number(titleStyle.lineHeight)),
        titleLineClamp: titleStyle.webkitLineClamp,
        titleWhiteSpace: titleStyle.whiteSpace,
        panelOverflows: panel.scrollWidth > panel.clientWidth + 1,
      };
    });
    expect(mobileHeader.closeHitSize).toBeCloseTo(
      mobileHeader.startHitSize,
      3,
    );
    expect(mobileHeader.closeVisualSize).toBeCloseTo(
      mobileHeader.startVisualSize,
      3,
    );
    expect(mobileHeader.closeIconSize).toBeCloseTo(
      mobileHeader.startIconSize,
      3,
    );
    expect(mobileHeader.closeIconCenterDelta).toBeLessThanOrEqual(0.5);
    expect(mobileHeader.startIconCenterDelta).toBeLessThanOrEqual(0.5);
    expect(mobileHeader).toMatchObject({
      closeBorderWidth: "0px",
      startBorderWidth: "0px",
      closePaintBorderWidth: "1px",
      startPaintBorderWidth: "1px",
      titleLines: 2,
      titleLineClamp: "2",
      titleWhiteSpace: "normal",
      panelOverflows: false,
    });
    await captureReviewScreenshot(
      page,
      testInfo,
      "github-issue-start-task-entry",
    );
  }
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "Start Task for #62" });
  const baseSelect = dialog.getByRole("combobox", { name: "Base branch" });
  await expect(dialog).toBeVisible();
  await refsRequestStarted;
  await expect(baseSelect).toBeDisabled();
  await expect(baseSelect.locator("option")).toHaveText("Loading branches…");
  await expect(baseSelect).toHaveAttribute("aria-busy", "true");
  const refsStatus = dialog.locator(".github-issue-task-start-ref-status");
  await expect(refsStatus).toHaveClass(/sr-only/);
  await expect(refsStatus).toHaveText("Loading branches…");
  const loadingGeometry = await dialog.evaluate((element) => {
    const body = element.querySelector(".github-issue-task-start-body");
    const footer = element.querySelector("footer");
    const options = element.querySelector("caffold-task-turn-options");
    return {
      bodyHeight: body.getBoundingClientRect().height,
      footerTop: footer.getBoundingClientRect().top,
      optionsTop: options.getBoundingClientRect().top,
    };
  });
  await captureReviewScreenshot(
    page,
    testInfo,
    "github-issue-start-task-dialog-loading",
  );
  releaseRefsRequest();
  await expect(baseSelect).toHaveValue("origin/main");
  await expect(baseSelect.locator('option[value="origin/main"]')).toHaveText(
    "origin/main",
  );
  await expect(baseSelect).toHaveAttribute("aria-busy", "false");
  await expect(refsStatus).toBeEmpty();
  await expect(refsStatus).not.toHaveClass(/sr-only/);
  const loadedGeometry = await dialog.evaluate((element) => {
    const body = element.querySelector(".github-issue-task-start-body");
    const footer = element.querySelector("footer");
    const options = element.querySelector("caffold-task-turn-options");
    return {
      bodyHeight: body.getBoundingClientRect().height,
      footerTop: footer.getBoundingClientRect().top,
      optionsTop: options.getBoundingClientRect().top,
    };
  });
  expect(loadedGeometry.bodyHeight).toBeCloseTo(loadingGeometry.bodyHeight, 3);
  expect(loadedGeometry.footerTop).toBeCloseTo(loadingGeometry.footerTop, 3);
  expect(loadedGeometry.optionsTop).toBeCloseTo(loadingGeometry.optionsTop, 3);
  const visualPattern = await page.evaluate(() => {
    const issueAction = document.querySelector(".github-issue-start-button");
    const dialog = document.querySelector(
      "caffold-github-issue-task-start-dialog dialog",
    );
    const base = dialog?.querySelector("select[name='baseRef']");
    const footer = dialog?.querySelector("footer");
    const cancel = dialog?.querySelector(
      '[data-task-start-dialog-action="cancel"]',
    );
    const submit = dialog?.querySelector('button[type="submit"]');
    const model = dialog?.querySelector(".task-model-button");
    const contextTitle = dialog?.querySelector(
      "#github-issue-task-start-title",
    );
    const issueTitle = dialog?.querySelector(
      ".github-issue-task-start-issue",
    );
    return {
      issueActionRadius: getComputedStyle(issueAction).borderRadius,
      dialogRadius: getComputedStyle(dialog).borderRadius,
      baseRadius: getComputedStyle(base).borderRadius,
      footerBorder: getComputedStyle(footer).borderTopStyle,
      cancelRadius: getComputedStyle(cancel).borderRadius,
      submitRadius: getComputedStyle(submit).borderRadius,
      modelRadius: getComputedStyle(model).borderRadius,
      contextTitleFontSize: Number.parseFloat(
        getComputedStyle(contextTitle).fontSize,
      ),
      issueTitleFontSize: Number.parseFloat(
        getComputedStyle(issueTitle).fontSize,
      ),
      issueTitleWhiteSpace: getComputedStyle(issueTitle).whiteSpace,
      issueTitleTextOverflow: getComputedStyle(issueTitle).textOverflow,
    };
  });
  expect(visualPattern).toMatchObject({
    issueActionRadius: "4px",
    dialogRadius: "10px",
    baseRadius: "5px",
    footerBorder: "solid",
    cancelRadius: "5px",
    submitRadius: "5px",
    modelRadius: "999px",
    issueTitleWhiteSpace: "normal",
    issueTitleTextOverflow: "clip",
  });
  expect(visualPattern.contextTitleFontSize).toBeLessThan(
    visualPattern.issueTitleFontSize,
  );
  await captureReviewScreenshot(page, testInfo, "github-issue-start-task-dialog");
  await baseSelect.selectOption("origin/release");

  const modelButton = dialog.getByRole("button", { name: /Choose model/ });
  await modelButton.click();
  await dialog.locator('[data-effort="xhigh"]').click();
  await modelButton.click();
  await dialog.locator('[data-fast-mode="true"]').click();
  const permissionButton = dialog.getByRole("button", {
    name: "Choose approval mode",
  });
  await expect(permissionButton).toContainText("Auto review");

  const form = dialog.locator("form");
  await dialog.getByRole("button", { name: "Start Task", exact: true }).click();
  await firstRequestStarted;
  await form.evaluate((element) => element.requestSubmit());
  await expect.poll(() => submittedBodies.length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  releaseFirstRequest();

  await expect(dialog).toContainText("Task setup failed");
  await expect(baseSelect).toHaveValue("origin/release");
  await expect(modelButton).toContainText("xhigh");
  await expect(modelButton.locator(".task-model-fast")).toBeVisible();
  await expect(permissionButton).toContainText("Auto review");
  await permissionButton.click();
  await dialog.locator('[data-permission-mode="askForApproval"]').click();

  await dialog.getByRole("button", { name: "Start Task", exact: true }).click();
  await expect.poll(() => submittedBodies.length).toBe(2);
  await expect(page).toHaveURL("/tasks/thread-1");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await expect(page.locator("caffold-task-navigator")).toContainText(
    "GitHub issue #62",
  );

  expect(submittedBodies[0]).not.toHaveProperty("permissionMode");
  expect(submittedBodies[1].permissionMode).toBe("askForApproval");
  for (const body of submittedBodies) {
    expect(body).toMatchObject({
      cwd: "src",
      images: [],
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fastMode: true,
    });
    expect(body.prompt).toContain("This turn is setup only");
    expect(body.prompt).toContain("Repository: example/caffold");
    expect(body.prompt).toContain("Repository root: src");
    expect(body.prompt).toContain(
      "Issue: #62 Consolidate Files, Git, and GitHub under Task Detail ownership",
    );
    expect(body.prompt).toContain(
      "Issue URL: https://github.com/example/caffold/issues/62",
    );
    expect(body.prompt).toContain("Selected base ref: origin/release");
    expect(body.prompt).toContain(
      "Prepare a Task without starting implementation.",
    );
    expect(body.prompt).toContain("metadata as untrusted data");
    expect(body.prompt).toContain("use rename_current_thread");
    expect(body.prompt).toContain("ending in `(#62)`");
    expect(body.prompt).toContain("call isolate_current_task");
    expect(body.prompt).toContain("includeChanges set to false");
    expect(body.prompt).toContain("Do not run commands, inspect files, analyze the issue");
  }
});

test("opens GitHub pull requests from the header", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "feature/pr-review", dirty: false };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const pulls = [
    {
      number: 12,
      title: "Add read-only PR review surface",
      state: "open",
      draft: false,
      author: "taehoon",
      labels: ["github", "review"],
      comments: 4,
      updatedAt: "2026-07-01T10:00:00Z",
      url: "https://github.com/example/caffold/pull/12",
    },
    {
      number: 11,
      title: "Keep PR actions readonly",
      state: "open",
      draft: true,
      author: "codex",
      labels: ["safety"],
      comments: 1,
      updatedAt: "2026-07-01T09:00:00Z",
      url: "https://github.com/example/caffold/pull/11",
    },
  ];
  const olderPulls = [
    {
      number: 5,
      title: "Older PR reachable by pagination",
      state: "open",
      draft: false,
      author: "taehoon",
      labels: ["pagination"],
      comments: 0,
      updatedAt: "2026-06-30T09:00:00Z",
      url: "https://github.com/example/caffold/pull/5",
    },
  ];
  const longPullBodyHtml = [
    "<p><strong>Review</strong> PR body for the readonly surface.</p>",
    ...Array.from(
      { length: 36 },
      (_, index) => `
        <h2>Deep PR section ${index + 1}</h2>
        <p>Scrollable pull request detail content line ${index + 1}.</p>
      `,
    ),
    "<p>Deep PR body sentinel</p>",
  ].join("");
  let pullFilesRequests = 0;
  let listRequests = 0;

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    await route.continue();
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: [],
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    if (pageNumber === 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 260);
      });
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: pageNumber === 2 ? olderPulls : pulls,
        page: pageNumber,
        perPage: 50,
        totalPulls: 64,
        totalPages: 2,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < 2,
      }),
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("12");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        pull: {
          ...pulls[0],
          state: "OPEN",
          comments: 1,
          reviews: 1,
          commits: 2,
          additions: 12,
          deletions: 3,
          changedFiles: 2,
          baseRefName: "main",
          headRefName: "feature/pr-review",
          body: "**Review** PR body for the readonly surface.\n\nDeep PR body sentinel",
          bodyHtml: longPullBodyHtml,
          createdAt: "2026-07-01T08:00:00Z",
          conversationComments: [
            {
              author: "taehoon",
              body: "Conversation comment body",
              bodyHtml: "<p>Conversation comment body</p>",
              createdAt: "2026-07-01T08:30:00Z",
              updatedAt: "2026-07-01T08:30:00Z",
              url: "https://github.com/example/caffold/pull/12#issuecomment-1",
            },
          ],
          reviewComments: [
            {
              author: "codex",
              state: "COMMENTED",
              body: "Review summary body",
              bodyHtml: "<p>Review summary body</p>",
              submittedAt: "2026-07-01T09:00:00Z",
            },
          ],
          commitSummaries: [
            {
              sha: "1234567890abcdef1234567890abcdef12345678",
              shortSha: "1234567",
              subject: "Add PR files route",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:00:00Z",
              committedAt: "2026-07-01T09:00:00Z",
              url: "https://github.com/example/caffold/commit/1234567",
            },
            {
              sha: "abcdef1234567890abcdef1234567890abcdef12",
              shortSha: "abcdef1",
              subject: "Render PR conversation",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:10:00Z",
              committedAt: "2026-07-01T09:10:00Z",
              url: "https://github.com/example/caffold/commit/abcdef1",
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, (route) => {
    pullFilesRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("12");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            previousPath: null,
            status: "M",
            additions: 10,
            deletions: 2,
            changes: 12,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/planner/mod.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/planner/mod.rs",
          },
          {
            path: "src/runtime/lib.rs",
            repoRelativePath: "runtime/lib.rs",
            previousPath: null,
            status: "A",
            additions: 2,
            deletions: 0,
            changes: 2,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/runtime/lib.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/runtime/lib.rs",
          },
        ],
        totalFiles: 2,
      }),
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("12");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        status: file.endsWith("lib.rs") ? "A" : "M",
        kind: "PR #12",
        additions: file.endsWith("lib.rs") ? 2 : 10,
        deletions: file.endsWith("lib.rs") ? 0 : 2,
        diff: [
          `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
          "@@ -1,1 +1,2 @@",
          "-old PR review line",
          "+new PR review line",
          "+another PR review line",
        ].join("\n"),
        diffUnavailable: false,
        message: null,
      }),
    });
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-file-tree-path="src"]').click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");

  const githubPopover = await openHeaderActionGroup(page, "github");
  const pullsButton = githubPopover.locator('button[data-action="open-github-pulls-workspace"]');
  await expect(pullsButton.locator(".header-menu-label")).toHaveText("PRs");
  await pullsButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "github");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Pull Requests");
  await expect(workspace.locator(".review-workspace-subtitle")).toHaveText(
    "example/caffold · 64 PRs",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Add read-only PR review surface",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Keep PR actions readonly",
  );
  await expect(page.locator("caffold-github-pulls-list-page .github-pulls-count")).toHaveText(
    "64 PRs",
  );
  await expect(page.locator("caffold-github-pull-detail-page")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "github-pulls-list");

  await page.locator('button[data-pull-number="12"]').click();
  const pullViewer = page.locator("caffold-github-pull-detail-page");
  await expect(workspace.locator(".github-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "detail",
  );
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("PR");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "#12 Add read-only PR review surface",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toBeHidden();
  await expect(pullViewer).toBeVisible();
  await expect(pullViewer).toContainText("Conversation comment body");
  await expect(pullViewer).toContainText("Review summary body");
  await expect(pullViewer).toContainText("Add PR files route");
  await expect(pullViewer).toContainText("Deep PR body sentinel");
  await expect(pullViewer.locator("caffold-github-markdown").first().locator("strong")).toHaveText(
    "Review",
  );
  const pullDetailScroll = await pullViewer.locator(".github-pull-viewer-scroll").evaluate((el) => {
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
    };
  });
  expect(pullDetailScroll.overflowY).toBe("auto");
  expect(pullDetailScroll.scrollHeight).toBeGreaterThan(pullDetailScroll.clientHeight);
  expect(pullDetailScroll.scrollTop).toBe(0);
  const commitInterfaceText = await pullViewer.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;font-size:var(--interface-meta-font-size)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).fontSize;
    probe.remove();
    return {
      expected,
      actual: getComputedStyle(element.querySelector(".github-pull-commit a"))
        .fontSize,
    };
  });
  expect(commitInterfaceText.actual).toBe(commitInterfaceText.expected);

  const pullDetailScrollBox = await pullViewer
    .locator(".github-pull-viewer-scroll")
    .boundingBox();
  expect(pullDetailScrollBox).not.toBeNull();
  await page.mouse.move(
    pullDetailScrollBox.x + pullDetailScrollBox.width / 2,
    pullDetailScrollBox.y + pullDetailScrollBox.height / 2,
  );
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(100);
  const pullDetailScrollTop = await pullViewer
    .locator(".github-pull-viewer-scroll")
    .evaluate((el) => el.scrollTop);
  expect(pullDetailScrollTop).toBeGreaterThan(0);
  const pullContentLayout = await pullViewer.evaluate((element) => {
    const scroll = element.querySelector(".github-pull-viewer-scroll").getBoundingClientRect();
    const heading = element.querySelector(".github-pull-section > h3").getBoundingClientRect();
    const commits = element.querySelector(".github-pull-commits").getBoundingClientRect();

    return {
      scrollLeft: scroll.left,
      scrollWidth: scroll.width,
      headingLeft: heading.left,
      headingWidth: heading.width,
      commitsLeft: commits.left,
      commitsWidth: commits.width,
    };
  });
  expect(pullContentLayout.headingWidth).toBeLessThanOrEqual(
    Math.min(pullContentLayout.scrollWidth, 980) + 1,
  );
  expect(pullContentLayout.commitsWidth).toBeLessThanOrEqual(
    Math.min(pullContentLayout.scrollWidth, 980) + 1,
  );
  if (pullContentLayout.scrollWidth > 1040) {
    expect(pullContentLayout.headingLeft).toBeGreaterThan(
      pullContentLayout.scrollLeft + 40,
    );
    expect(pullContentLayout.commitsLeft).toBeGreaterThan(
      pullContentLayout.scrollLeft + 40,
    );
  }
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to pull requests",
      detailSelector: "caffold-github-pull-detail-page",
      listSelector: "caffold-github-pulls-list-page",
    });
  }
  await captureReviewScreenshot(page, testInfo, "github-pull-detail");

  await pullViewer.getByRole("button", { name: "Open files for PR #12" }).click();
  await expect(workspace.locator(".github-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "files",
  );
  await expect(page.locator("caffold-github-pull-files-tree")).toContainText("2 files");
  await expect(page.locator('button[data-file-tree-path="src/planner/mod.rs"]')).toBeVisible();
  await expectFileTreeDensity(
    page,
    page.locator('button[data-file-tree-path="src/planner/mod.rs"]'),
  );
  await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  const pullFilesPage = page.locator("caffold-github-pull-files-page");
  const pullResizeHandle = pullFilesPage.locator(
    ":scope > caffold-review-panel-resizer",
  );
  if (testInfo.project.name === "phone") {
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(page.locator("caffold-github-pull-files-tree")).toBeVisible();
    await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toBeHidden();
    await expect(pullResizeHandle).toBeHidden();
    await expect(pullFilesPage).toHaveCSS(
      "--github-pull-files-panel-width",
      "320px",
    );
  } else {
    await expect(pullResizeHandle).toBeVisible();
    await expect(pullResizeHandle).not.toHaveAttribute("resize-target");
    await expect(pullResizeHandle).toHaveAttribute("aria-valuemin", "180");
    const beforePullTreeWidth = await elementWidth(
      page,
      "caffold-github-pull-files-page > caffold-github-pull-files-tree",
    );
    await dragHorizontalResizer(page, pullResizeHandle, 72);
    const afterPullTreeWidth = await elementWidth(
      page,
      "caffold-github-pull-files-page > caffold-github-pull-files-tree",
    );
    expect(afterPullTreeWidth).toBeGreaterThan(beforePullTreeWidth + 36);
    await pullResizeHandle.focus();
    await pullResizeHandle.press("Home");
    await expect(pullResizeHandle).toHaveAttribute("aria-valuenow", "180");
    await pullResizeHandle.press("ArrowRight");
    await expect(pullResizeHandle).toHaveAttribute("aria-valuenow", "204");
    const widthOwnership = await page.evaluate(() => {
      const pullPage = document.querySelector("caffold-github-pull-files-page");
      const reviewWorkspace = document.querySelector("caffold-review-workspace");
      return {
        pageWidth: pullPage?.style.getPropertyValue(
          "--github-pull-files-panel-width",
        ),
        workspaceWidth: reviewWorkspace?.style.getPropertyValue(
          "--review-left-panel-width",
        ),
      };
    });
    expect(widthOwnership.pageWidth).toBe("204px");
    expect(widthOwnership.workspaceWidth).toBe("");
  }

  const listRequestsBeforeFileClick = listRequests;
  const pullFilesRequestsBeforeFileClick = pullFilesRequests;
  await page.locator('button[data-file-tree-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(
    "/github/pulls/12/files?cwd=src&file=planner%2Fmod.rs",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR review line");
  await expect(
    page.locator(".github-mode-pulls caffold-review-file-viewer .viewer-line-stats"),
  ).toHaveAttribute("aria-label", "10 additions and 2 deletions");
  expect(listRequests).toBe(listRequestsBeforeFileClick);
  expect(pullFilesRequests).toBe(pullFilesRequestsBeforeFileClick);
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to PR files",
      detailSelector: ".github-mode-pulls caffold-review-file-viewer",
      listSelector: "caffold-github-pull-files-tree",
      sharedFileViewer: true,
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-github-pull-files-tree .github-pull-files-panel > header",
      ".github-mode-pulls caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-github-pull-files-tree .github-pull-files-panel > header",
      ".github-mode-pulls caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await captureReviewScreenshot(page, testInfo, "github-pull-file-diff");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to PR files" }).click();
    await expect(page).toHaveURL("/github/pulls/12/files?cwd=src");
    await expect(page.locator("caffold-github-pull-files-page")).toBeVisible();
    await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toBeHidden();
    await page.locator('button[data-file-tree-path="src/planner/mod.rs"]').click();
    await expect(page).toHaveURL(
      "/github/pulls/12/files?cwd=src&file=planner%2Fmod.rs",
    );
    await page.getByRole("button", { name: "Back to PR files" }).click();
    await expect(page).toHaveURL("/github/pulls/12/files?cwd=src");
  }
  await workspace.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL("/github/pulls/12?cwd=src");
  await expect(pullViewer).toBeVisible();
  if (testInfo.project.name === "phone") {
    await pullViewer.getByRole("button", { name: "Back to pull requests" }).click();
  } else {
    await workspace.getByRole("button", { name: "Back to pull requests" }).click();
  }
  await expect(page).toHaveURL("/github/pulls?cwd=src");
  await expect(page.locator("caffold-github-pulls-list-page")).toBeVisible();

  const pullPagination = page.locator("caffold-github-pulls-list-page caffold-pagination");
  await pullPagination.getByRole("button", { name: "Oldest pull request page" }).click();
  await page.waitForTimeout(220);
  await expect(page.locator("caffold-github-pulls-list-page .github-pulls-loading-body")).toHaveText(
    "Loading pull requests...",
  );
  await expect(pullPagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Older PR reachable by pagination",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).not.toContainText(
    "Loading pull requests...",
  );
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "github-pulls-page-2");
});
