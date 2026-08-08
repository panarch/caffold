import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
} from "../support/task-fixtures.js";
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
    hostFontSize: "15px",
  });
  expect(Number.parseFloat(markdownLayout.headingFontSize)).toBeGreaterThan(15);
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
