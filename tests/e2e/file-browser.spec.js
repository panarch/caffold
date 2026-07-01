import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const LAST_DIRECTORY_KEY = `codger:last-directory-path:${resolve("tests/fixtures/home")}`;
const LONG_ROOT_FILE =
  "this-is-a-very-long-file-name-used-to-test-horizontal-scrolling-in-the-files-pane.md";
const LONG_CHANGE_FILE =
  "src/planner/this-is-a-very-long-change-file-name-used-to-test-horizontal-scrolling-in-the-changes-pane.rs";

test.beforeEach(async ({ page }) => {
  await page.route("https://esm.sh/**", (route) => {
    if (route.request().url() !== "https://esm.sh/lucide@1.22.0") {
      return route.abort();
    }

    return route.fulfill({
      contentType: "text/javascript",
      body: `
        export const File = [["path", { d: "M6 3h8l4 4v14H6z" }]];
        export const FileArchive = File;
        export const FileCode = [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "m10 9-3 3 3 3" }], ["path", { d: "m14 9 3 3-3 3" }]];
        export const FileCog = File;
        export const FileDiff = FileCode;
        export const FileImage = File;
        export const FileJson = FileCode;
        export const FileQuestion = File;
        export const FileTerminal = FileCode;
        export const FileText = [["path", { d: "M6 3h12v18H6z" }], ["path", { d: "M9 8h6" }], ["path", { d: "M9 12h6" }]];
        export const CircleDot = [["circle", { cx: "12", cy: "12", r: "10" }], ["circle", { cx: "12", cy: "12", r: "2" }]];
        export const ChevronFirst = [["path", { d: "m17 18-6-6 6-6" }], ["path", { d: "M7 6v12" }]];
        export const ChevronLast = [["path", { d: "m7 18 6-6-6-6" }], ["path", { d: "M17 6v12" }]];
        export const ChevronLeft = [["path", { d: "m15 18-6-6 6-6" }]];
        export const ChevronRight = [["path", { d: "m9 18 6-6-6-6" }]];
        export const Folder = [["path", { d: "M3 6h7l2 2h9v10H3z" }]];
        export const FolderGit2 = Folder;
        export const FolderOpen = Folder;
        export const FolderSymlink = Folder;
        export const GitCompare = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["path", { d: "M6 9v7a2 2 0 0 0 2 2h3" }]];
        export const ArrowLeft = [
          ["path", { d: "m12 19-7-7 7-7" }],
          ["path", { d: "M19 12H5" }],
        ];
        export const History = [["path", { d: "M3 12a9 9 0 1 0 3-6.7" }], ["path", { d: "M3 3v6h6" }], ["path", { d: "M12 7v5l3 2" }]];
        export const Info = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]];
        export const Database = [["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }], ["path", { d: "M4 5v10c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }]];
        export const Link = [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }]];
        export const Lock = [["rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 10V7a4 4 0 0 1 8 0v3" }]];
        export const PanelTopOpen = [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 9h18" }]];
        export const Pencil = [["path", { d: "M17 3a2.8 2.8 0 0 1 4 4L7 21H3v-4z" }]];
        export const Trash2 = [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 15H6L5 6" }]];
        export const X = [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]];
        export function createElement(iconNode, attrs = {}) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          const baseAttrs = {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            ...attrs,
          };
          for (const [name, value] of Object.entries(baseAttrs)) {
            svg.setAttribute(name, String(value));
          }
          for (const [tag, childAttrs] of iconNode) {
            const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [name, value] of Object.entries(childAttrs)) {
              child.setAttribute(name, String(value));
            }
            svg.appendChild(child);
          }
          return svg;
        }
      `,
    });
  });
});

test("delays file list loading feedback", async ({ page }) => {
  let resolveListRequest;
  let releaseListResponse;
  const listRequested = new Promise((resolve) => {
    resolveListRequest = resolve;
  });
  const listReleased = new Promise((resolve) => {
    releaseListResponse = resolve;
  });

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    resolveListRequest();
    await listReleased;
    await route.continue();
  });

  await page.goto("/");
  await listRequested;

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await page.waitForTimeout(120);
  await expect(page.getByText("Loading files...")).toHaveCount(0);

  await page.waitForTimeout(90);
  await expect(page.getByText("Loading files...")).toBeVisible();

  releaseListResponse();
  await expect(page.locator("codger-file-list")).toContainText("src");
});

test("keeps the file list visible while project metadata refresh is slow", async ({ page }) => {
  let releaseProjectResponses;
  const projectResponsesReleased = new Promise((resolve) => {
    releaseProjectResponses = resolve;
  });

  await page.route(/\/api\/(?:projects|project-candidate)(?:\?|$)/, async (route) => {
    await projectResponsesReleased;
    await route.continue();
  });

  await page.goto("/");
  await expect(page.locator("codger-file-list")).toContainText("src");

  await page.waitForTimeout(240);
  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("codger-file-list")).toContainText("src");

  releaseProjectResponses();
});

test("browses directories and opens a source file", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("codger-file-list")).toContainText(".codger-hidden");
  await expect(page.locator("codger-file-list")).toContainText("src");
  await expect(page.locator('button[data-entry-path="src"] .entry-icon')).toHaveAttribute(
    "title",
    "Git repository",
  );
  await expect(page.locator('button[data-entry-path=".codger-hidden"]')).toHaveClass(
    /is-hidden/,
  );
  await expect(page.locator(".parent-entry")).toHaveCount(0);

  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(page.locator(".parent-entry")).toBeVisible();
  await expect(page.locator("codger-file-list .git-summary")).toBeVisible();
  await expect(page.locator("codger-file-list .git-summary")).toHaveClass(/is-dirty/);
  await expect(page.locator('button[data-entry-path="src/ignored.log"]')).toHaveClass(
    /is-ignored/,
  );
  await expect(page.locator('button[data-entry-path="src/ignored.log"]')).toHaveAttribute(
    "title",
    "Ignored by Git",
  );
  await expect(page.locator('button[data-entry-path="src/ignored-output"]')).toHaveClass(
    /is-ignored/,
  );
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toHaveCount(0);

  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.getByText("Loading file...")).toHaveCount(0);
  await expect(page.locator("codger-file-viewer")).toContainText("example.rs");
  await expect(page.locator("codger-code-viewer")).toContainText("pub fn sample");
  await expect(page.locator("codger-code-viewer")).not.toContainText("Highlighted");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expect(page.locator(".entry-icon-svg").first()).toBeVisible();
  await expectGlobalScrollLocked(page);
  await expectPanelScrollContainers(page);
  await page.getByRole("button", { name: "Show details for example.rs" }).click();
  const details = page.locator("codger-file-viewer .viewer-meta-popover");
  await expect(details).toBeVisible();
  await expect(details.locator('[data-field="path"] dd')).toHaveText("src/example.rs");
  await expect(details.locator('[data-field="language"] dd')).toHaveText("Rust");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await page.locator('button[data-entry-path="src/planner"]').click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.locator('button[data-entry-path="src/planner/mod.rs"]').click();
  await expect(page.locator("codger-file-viewer")).toContainText("mod.rs");
  await expect(page.locator("codger-code-viewer")).toContainText("plan_review");
  await expect(page.locator(".line-number").first()).toHaveText("1");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "file-browser");
});

test("manages project records from the header switcher", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Project CRUD mutates shared fixture data.");

  await page.goto("/");
  const switcher = page.locator("codger-project-switcher");

  await page.locator('button[data-entry-path="src"]').click();
  await expect(switcher.locator(".project-switcher-button")).toContainText("Register");

  await openProjectPopover(switcher);
  await expect(switcher.locator(".project-candidate")).toContainText("src");
  await switcher.locator(".project-candidate button").click();
  await expect(switcher.locator(".project-switcher-button")).toContainText("src");
  await expect(switcher.locator(".project-popover")).toBeHidden();

  await openProjectPopover(switcher);
  await switcher.getByRole("button", { name: "Rename src" }).click();
  await switcher.locator('input[name="name"]').fill("Fixture Repo");
  await switcher.getByRole("button", { name: "Save" }).click();
  await expect(switcher.locator(".project-switcher-button")).toContainText("Fixture Repo");
  await page.keyboard.press("Escape");

  await page.locator('codger-pathbar button[data-path=""]').click();
  await expect(page.locator("codger-pathbar")).not.toContainText("src");
  await openProjectPopover(switcher);
  await switcher.locator(".project-open").filter({ hasText: "Fixture Repo" }).click();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(switcher.locator(".project-popover")).toBeHidden();

  await page.reload();
  await openProjectPopover(switcher);
  const projectRow = switcher.locator(".project-row").filter({ hasText: "Fixture Repo" });
  await expect(projectRow).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await projectRow.getByRole("button", { name: "Delete Fixture Repo" }).click();
  await expect(switcher.locator(".project-row").filter({ hasText: "Fixture Repo" })).toHaveCount(
    0,
  );
});

test("previews image files in the viewer", async ({ page }) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="preview-image.svg"]').click();
  await expect(page.locator("codger-file-viewer")).toContainText("preview-image.svg");
  await expect(page.locator("codger-file-viewer")).toContainText("SVG image");
  await page.getByRole("button", { name: "Show details for preview-image.svg" }).click();
  const details = page.locator("codger-file-viewer .viewer-meta-popover");
  await expect(details.locator('[data-field="size"] dd')).toHaveText("325 B");
  await expect(details.locator('[data-field="type"] dd')).toHaveText("SVG image");

  const preview = page.locator("codger-file-viewer img.image-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("src", /\/api\/image\?path=preview-image\.svg$/);
  await expect(
    preview.evaluate((image) => image.complete && image.naturalWidth > 0),
  ).resolves.toBe(true);
});

test("keeps the toggled tree row anchored while expanding", async ({ page }) => {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      codger-file-list .file-list {
        max-height: 150px;
      }
    `,
  });

  await page.locator('button[data-entry-path="src"]').click();
  const planner = page.locator('button[data-entry-path="src/planner"]');
  await expect(planner).toBeVisible();

  const beforeTop = await planner.evaluate((element) => {
    const scroller = element.closest(".file-list");
    scroller.scrollTop = 0;
    return element.getBoundingClientRect().top;
  });

  await planner.click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.waitForTimeout(50);

  const afterTop = await planner.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
});

test("resizes the left file panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The phone layout stacks panels vertically.");

  await page.goto("/");
  const handle = page.locator(".panel-resizer");
  await expect(handle).toBeVisible();

  const beforeWidth = await leftPanelWidth(page);
  await dragHorizontalResizer(page, handle, 96);

  const afterWidth = await leftPanelWidth(page);
  expect(afterWidth).toBeGreaterThan(beforeWidth + 48);
});

test("scrolls long names horizontally in Files and Changes", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(`button[data-entry-path="${LONG_ROOT_FILE}"]`)).toBeVisible();
  await expectHorizontalScroller(page, ".file-list");

  await page.locator('button[data-entry-path="src"]').click();
  const gitButton = page.locator('codger-header-actions button[data-action="open-diff-workspace"]');
  await expect(gitButton).toBeVisible();
  await gitButton.click();
  await expect(page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`)).toBeVisible();
  await expectHorizontalScroller(page, ".changes-tree-list");
});

test("scrolls long source lines horizontally in the code viewer", async ({ page }) => {
  const longLine = "long-source-token-".repeat(48);

  await page.route(/\/api\/file(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "README.md") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        path: "README.md",
        name: "README.md",
        size: longLine.length,
        modifiedMs: null,
        languageHint: "markdown",
        content: `# Fixture Home\n\n${longLine}\n`,
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("codger-code-viewer")).toContainText("long-source-token");
  await expectHorizontalScroller(page, "codger-code-viewer .code-lines");
});

test("keeps list scroll positions when selecting files and changes", async ({ page }) => {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      codger-file-list .file-list,
      codger-changes-tree .changes-tree-list {
        max-height: 72px;
      }
    `,
  });

  const fileList = page.locator("codger-file-list .file-list");
  const fileTarget = page.locator('button[data-entry-path="README.md"]');
  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(page.locator("codger-file-viewer")).toContainText("README.md");
  await expectPreservedScroll(fileList, beforeFileScroll);

  await page.locator('button[data-entry-path="src"]').click();
  const gitButton = page.locator('codger-header-actions button[data-action="open-diff-workspace"]');
  await expect(gitButton).toBeVisible();
  await gitButton.click();

  const changesList = page.locator("codger-changes-tree .changes-tree-list");
  const changeTarget = page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`);
  await changeTarget.scrollIntoViewIfNeeded();
  const beforeChangesScroll = await scrollTop(changesList);
  expect(beforeChangesScroll).toBeGreaterThan(0);

  await changeTarget.click();
  await expect(page.locator("codger-diff-viewer")).toContainText("long_change_name_fixture");
  await expectPreservedScroll(changesList, beforeChangesScroll);
});

test("opens changed diffs from Changes mode", async ({ page }, testInfo) => {
  const longContextLine = ` context line ${"long-diff-token-".repeat(36)}`;
  const repository = { rootPath: "src", branch: "main", dirty: true };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
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
        ],
      }),
    }),
  );

  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        kind: "unstaged",
        diff: [
          `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
          "index 1111111..2222222 100644",
          `--- a/${file.replace(/^src\//, "")}`,
          `+++ b/${file.replace(/^src\//, "")}`,
          "@@ -10,4 +10,5 @@ pub fn sample()",
          longContextLine,
          "-old line",
          "+new line",
          "+another line",
          " trailing line",
        ].join("\n"),
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const gitButton = page.locator('codger-header-actions button[data-action="open-diff-workspace"]');
  await expect(gitButton).toBeVisible();
  await expect(page.locator("codger-pathbar .header-action-button")).toHaveCount(0);
  await expect(gitButton.locator(".header-action-count")).not.toHaveText("");
  await expect(gitButton.locator(".header-action-icon")).toBeVisible();
  await expect(gitButton.locator(".header-action-label")).toHaveText("Diff");
  await expect(gitButton).not.toContainText("master");
  await expect(gitButton).toHaveAttribute("title", "Open Diff");

  await gitButton.click();
  const workspace = page.locator("codger-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "diff");
  await expect(workspace.getByRole("button", { name: "Close review workspace" })).toBeVisible();
  await expect(page.locator("codger-changes-tree")).toContainText("Unstaged");
  await expect(page.locator("codger-changes-tree")).toContainText("example.rs");
  await expect(page.locator("codger-changes-tree")).toContainText("deleted.rs");
  if (testInfo.project.name !== "phone") {
    const resizeHandle = workspace.locator(".workspace-mode-diff .review-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "codger-review-workspace .workspace-mode-diff > codger-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "codger-review-workspace .workspace-mode-diff > codger-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }

  await page.locator('button[data-change-path="src/example.rs"]').click();
  await expect(page.locator(".workspace-mode-diff codger-review-file-viewer")).toContainText(
    "example.rs",
  );
  await expect(page.locator(".workspace-mode-diff .viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  await expectAlignedWorkspaceHeaders(page, [
    "codger-review-workspace .review-workspace-header",
    "codger-changes-tree .changes-tree-panel > header",
    ".workspace-mode-diff codger-review-file-viewer .viewer-panel > header",
  ]);
  await expectMatchingPaneTitleSizes(page, [
    "codger-changes-tree .changes-tree-panel > header",
    ".workspace-mode-diff codger-review-file-viewer .viewer-panel > header",
  ]);
  await expect(page.locator("codger-diff-viewer")).toContainText("@@ -10,4 +10,5 @@");
  await expect(page.locator("codger-diff-viewer")).toContainText("old line");
  await expect(page.locator("codger-diff-viewer")).toContainText("new line");
  await expectHorizontalScroller(page, "codger-diff-viewer .diff-lines");
  await expectUnifiedDiffRowsShareScrollWidth(page);
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

  await page.locator('button[data-change-path="src/deleted.rs"]').click();
  await expect(page.locator(".workspace-mode-diff .viewer-subtitle")).toHaveText(
    "Deleted · Unstaged",
  );

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
  await expect(page.locator("codger-file-list")).toBeVisible();
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

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const compareButton = page.locator(
    'codger-header-actions button[data-action="open-compare-workspace"]',
  );
  await expect(compareButton.locator(".header-action-label")).toHaveText("Compare");
  await expect(compareButton).toHaveAttribute("title", "Open Compare");
  await compareButton.click();

  const workspace = page.locator("codger-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "compare");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Compare");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "2 files",
  );
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue(
    baseRef,
  );
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(
    headRef,
  );
  await expect(
    workspace.locator('select[data-compare-ref="head"] optgroup[label="Current"]'),
  ).toHaveCount(1);
  await expectCompareRefControlsFit(page, testInfo, { sameRefCss: true });
  await captureReviewScreenshot(page, testInfo, "compare-long-refs");
  await expect(page.locator("codger-compare-tree")).toContainText("2 files");
  await expect(page.locator("codger-compare-tree")).toContainText("planner");
  await expect(page.locator("codger-compare-tree")).toContainText("function.rs");
  await expect(page.locator("codger-compare-tree")).toContainText("new.rs");

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
  await expect(page.locator("codger-compare-tree")).toContainText("0 files");

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
  await expect(page.locator("codger-compare-tree")).toContainText("release.rs");

  await page.locator('button[data-compare-path="src/runtime/release.rs"]').click();
  await expect(page.locator('button[data-compare-path="src/runtime/release.rs"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(".workspace-mode-compare codger-review-file-viewer")).toContainText(
    "release.rs",
  );
  await expect(page.locator(".workspace-mode-compare .viewer-subtitle")).toHaveText(
    `Added · origin/release...${headRef}`,
  );
  await expect(page.locator("codger-diff-viewer")).toContainText("old compare line");
  await expect(page.locator("codger-diff-viewer")).toContainText("new compare line");
});

test("opens GitHub issues from the header", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "feature/review", dirty: false };
  const github = {
    owner: "example",
    name: "codger",
    nameWithOwner: "example/codger",
    url: "https://github.com/example/codger",
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
      url: "https://github.com/example/codger/issues/42",
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
      url: "https://github.com/example/codger/issues/41",
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
      url: "https://github.com/example/codger/issues/7",
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
          body: "Review GitHub issues without leaving the readonly console.",
          createdAt: "2026-07-01T08:00:00Z",
        },
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const issuesButton = page.locator(
    'codger-header-actions button[data-action="open-github-issues-workspace"]',
  );
  await expect(issuesButton).toBeVisible();
  await expect(issuesButton.locator(".header-action-label")).toHaveText("Issues");
  await issuesButton.click();

  const workspace = page.locator("codger-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "issues");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issues");
  await expect(workspace.locator(".review-workspace-subtitle")).toHaveText(
    "example/codger · 75 issues",
  );
  await expect(page.locator("codger-github-issues-list")).toContainText(
    "Track mobile review issues",
  );
  await expect(page.locator("codger-github-issues-list")).toContainText(
    "Keep readonly GitHub access narrow",
  );
  await expect(page.locator("codger-github-issues-list .github-issues-count")).toHaveText(
    "75 issues",
  );
  const issuePagination = page.locator("codger-github-issues-list codger-pagination");
  await expect(issuePagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(issuePagination.getByRole("button", { name: "Newest issue page" })).toBeDisabled();
  await expect(issuePagination.getByRole("button", { name: "Newer issue page" })).toBeDisabled();
  await expect(page.locator("codger-github-issue-viewer")).toContainText(
    "Select an issue to inspect it.",
  );
  await expectAlignedWorkspaceHeaders(page, [
    "codger-review-workspace .review-workspace-header",
    "codger-github-issues-list .github-issues-panel > header",
  ]);
  await expectMatchingPaneTitleSizes(page, [
    "codger-github-issues-list .github-issues-panel > header",
  ]);
  await captureReviewScreenshot(page, testInfo, "github-issues-list");

  await page.locator('button[data-issue-number="42"]').click();
  await expect(page.locator('button[data-issue-number="42"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  const issueViewer = page.locator("codger-github-issue-viewer");
  await expect(issueViewer).toContainText("Track mobile review issues");
  await expect(issueViewer).toContainText("Review GitHub issues without leaving");
  await expect(issueViewer).toContainText("3 comments");
  await expect(issueViewer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/example/codger/issues/42",
  );

  await issuePagination.getByRole("button", { name: "Oldest issue page" }).click();
  await page.waitForTimeout(220);
  await expect(page.locator("codger-github-issues-list .github-issues-loading-body")).toHaveText(
    "Loading issues...",
  );
  await expect(page.locator("codger-github-issues-list")).not.toContainText(
    "Track mobile review issues",
  );
  await expect(issuePagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(issuePagination.getByRole("button", { name: "Newest issue page" })).toBeEnabled();
  await expect(issuePagination.getByRole("button", { name: "Oldest issue page" })).toBeDisabled();
  await expect(page.locator("codger-github-issues-list")).toContainText(
    "Older issue still reachable by pagination",
  );
  await expect(page.locator("codger-github-issues-list")).not.toContainText("Loading issues...");
  await expect(issuePagination.getByRole("button", { name: "Older issue page" })).toBeDisabled();
  await expect(issuePagination.getByRole("button", { name: "Oldest issue page" })).toBeDisabled();
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "github-issue-detail");
});

test("opens commit diffs from Log mode", async ({ page }, testInfo) => {
  const commit = {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    shortSha: "abcdef1",
    subject: "Update planner function",
    body: "Explain the planner update.\n\nKeep review context visible in the log.",
    authorName: "Codger",
    authorEmail: "codger@example.test",
    authorTimeMs: 1_767_000_000_000,
  };
  const fillerCommits = Array.from({ length: 49 }, (_, index) => ({
    sha: `feed${index.toString(16).padStart(36, "0")}`,
    shortSha: `feed${index.toString(16).padStart(3, "0")}`,
    subject: `Earlier commit ${index + 1}`,
    body: "",
    authorName: "Codger",
    authorEmail: "codger@example.test",
    authorTimeMs: 1_766_000_000_000 - index * 1000,
  }));
  const olderCommits = Array.from({ length: 25 }, (_, index) => ({
    sha: `dead${index.toString(16).padStart(36, "0")}`,
    shortSha: `dead${index.toString(16).padStart(3, "0")}`,
    subject: `Oldest page commit ${index + 1}`,
    body: "",
    authorName: "Codger",
    authorEmail: "codger@example.test",
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

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const logButton = page.locator('codger-header-actions button[data-action="open-log-workspace"]');
  await expect(logButton.locator(".header-action-label")).toHaveText("Log");
  await expect(logButton).toHaveAttribute("title", "Open Log");
  await logButton.click();
  const workspace = page.locator("codger-review-workspace");
  const logView = workspace.locator(".workspace-mode-log");
  const backButton = workspace.locator('button[data-action="back-review-workspace"]');
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "log");
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(page.locator("codger-log-list")).toContainText("Update planner function");
  await expect(page.locator("codger-log-list")).toContainText("abcdef1");
  await expect(page.locator("codger-log-list")).toBeVisible();
  await expect(page.locator(".log-review-detail")).toBeHidden();
  const pagination = page.locator("codger-log-list codger-pagination");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(pagination.getByRole("button", { name: "Newest page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Newer page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Oldest page" }).click();
  await page.waitForTimeout(40);
  const preservedLogText = await page.locator("codger-log-list").textContent();
  expect(preservedLogText).toContain("Update planner function");
  expect(preservedLogText).not.toContain("Loading log...");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(page.locator("codger-log-list")).toContainText("Oldest page commit 1");
  await expect(pagination.getByRole("button", { name: "Older page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Oldest page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Newest page" }).click();
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(page.locator("codger-log-list")).toContainText("Update planner function");

  const logEntry = page.locator(
    'codger-log-list .log-entry[data-commit-sha="abcdef1234567890abcdef1234567890abcdef12"]',
  );
  const logList = page.locator("codger-log-list .log-list");
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
  await expect(page.locator("codger-log-list")).toBeHidden();
  await expect(page.locator(".log-review-detail")).toBeVisible();
  await expect(backButton).toBeVisible();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText("abcdef1");
  const commitTree = page.locator("codger-commit-changes-tree");
  await expect(commitTree).toContainText("2 files");
  await expect(commitTree).not.toContainText("Update planner function");
  await expect(commitTree).toContainText("planner");
  await expect(commitTree).toContainText("function.rs");
  await expect(page.locator('button[data-commit-path="src/planner/function.rs"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  if (testInfo.project.name === "desktop") {
    const resizeHandle = workspace.locator(".log-review-detail .review-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "codger-review-workspace .log-review-detail > codger-commit-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "codger-review-workspace .log-review-detail > codger-commit-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }
  await expect(page.locator(".workspace-mode-log .viewer-subtitle")).toHaveText(
    "Modified · Commit abcdef1",
  );
  await expectAlignedWorkspaceHeaders(page, [
    "codger-review-workspace .review-workspace-header",
    "codger-commit-changes-tree .commit-tree-panel > header",
    ".workspace-mode-log codger-review-file-viewer .viewer-panel > header",
  ]);
  await expectMatchingPaneTitleSizes(page, [
    "codger-commit-changes-tree .commit-tree-panel > header",
    ".workspace-mode-log codger-review-file-viewer .viewer-panel > header",
  ]);
  await expect(page.locator("codger-diff-viewer")).toContainText("old planner line");
  await expect(page.locator("codger-diff-viewer")).toContainText("new planner line");

  await backButton.click();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Log");
  await expect(page.locator("codger-log-list")).toBeVisible();
  await expect(page.locator(".log-review-detail")).toBeHidden();
  await expect(logEntry).not.toHaveAttribute("aria-current");

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
});

test("restores the last opened directory after reload", async ({ page }) => {
  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(page.locator("codger-file-list .git-summary")).toBeVisible();

  await page.reload();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(page.locator("codger-file-list .git-summary")).toBeVisible();
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "src",
  );
});

test("falls back when the stored directory no longer opens", async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(key, "missing-directory");
    },
    [LAST_DIRECTORY_KEY],
  );

  await page.goto("/");
  await expect(page.locator("codger-file-list")).toContainText("src");
  await expect(page.locator(".parent-entry")).toHaveCount(0);
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "",
  );
});

test("extends the line-number gutter for short files", async ({ page }, testInfo) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("codger-file-viewer")).toContainText("README.md");
  await expect(page.locator("codger-code-viewer")).toContainText("Fixture Home");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expectGlobalScrollLocked(page);

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "short-file-gutter");
});

async function captureReviewScreenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
  });
  await testInfo.attach(`${name}-${testInfo.project.name}`, {
    path,
    contentType: "image/png",
  });
}

async function openProjectPopover(switcher) {
  const popover = switcher.locator(".project-popover");
  if (!(await popover.isVisible())) {
    await switcher.locator(".project-switcher-button").click();
  }

  await expect(popover).toBeVisible();
}

async function expectGlobalScrollLocked(page) {
  const scrollState = await page.evaluate(() => {
    const element = document.scrollingElement;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflow: window.getComputedStyle(document.body).overflow,
    };
  });

  expect(scrollState.overflow).toBe("hidden");
  expect(scrollState.scrollHeight).toBe(scrollState.clientHeight);
}

async function expectPanelScrollContainers(page) {
  const scrollState = await page.evaluate(() => {
    const fileList = document.querySelector(".file-list");
    const codeLines = document.querySelector(".code-lines");

    return {
      fileList: {
        clientHeight: fileList.clientHeight,
        scrollHeight: fileList.scrollHeight,
        overflowY: window.getComputedStyle(fileList).overflowY,
      },
      codeLines: {
        clientHeight: codeLines.clientHeight,
        scrollHeight: codeLines.scrollHeight,
        overflowY: window.getComputedStyle(codeLines).overflowY,
      },
    };
  });

  expect(scrollState.fileList.overflowY).toBe("auto");
  expect(scrollState.codeLines.overflowY).toBe("auto");
  expect(scrollState.codeLines.scrollHeight).toBeGreaterThan(scrollState.codeLines.clientHeight);
}

async function leftPanelWidth(page) {
  return page.locator("codger-file-list").evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

async function elementWidth(page, selector) {
  return page.locator(selector).evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

async function dragHorizontalResizer(page, handle, deltaX) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  const x = box.x + box.width / 2;
  const y = box.y + Math.min(40, Math.max(1, box.height / 2));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y);
  await page.mouse.up();
}

async function scrollTop(locator) {
  return locator.evaluate((element) => element.scrollTop);
}

async function expectPreservedScroll(locator, beforeScroll) {
  const afterScroll = await scrollTop(locator);
  expect(afterScroll).toBeGreaterThan(0);
  expect(afterScroll).toBeGreaterThanOrEqual(beforeScroll - 32);
}

async function expectHorizontalScroller(page, selector) {
  const scrollState = await page.locator(selector).evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return {
      clientWidth: element.clientWidth,
      overflowX: window.getComputedStyle(element).overflowX,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    };
  });

  expect(scrollState.overflowX).toBe("auto");
  expect(scrollState.scrollWidth).toBeGreaterThan(scrollState.clientWidth);
  expect(scrollState.scrollLeft).toBeGreaterThan(0);
}

async function expectUnifiedDiffRowsShareScrollWidth(page) {
  const scrollState = await page.locator("codger-diff-viewer .diff-lines").evaluate((element) => {
    element.scrollLeft = Math.min(220, element.scrollWidth - element.clientWidth);

    const table = element.querySelector(".diff-table");
    const rows = Array.from(element.querySelectorAll(".diff-row"));
    const gutters = Array.from(element.querySelectorAll(".diff-gutter"));
    const rowWidths = rows.map((row) => row.getBoundingClientRect().width);
    const transparentGutters = gutters.filter((gutter) => {
      const backgroundColor = window.getComputedStyle(gutter).backgroundColor;
      return backgroundColor === "rgba(0, 0, 0, 0)" || backgroundColor === "transparent";
    });

    return {
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      tableWidth: table.getBoundingClientRect().width,
      minRowWidth: Math.min(...rowWidths),
      maxRowWidth: Math.max(...rowWidths),
      transparentGutterCount: transparentGutters.length,
    };
  });

  expect(scrollState.scrollWidth).toBeGreaterThan(scrollState.clientWidth);
  expect(scrollState.scrollLeft).toBeGreaterThan(0);
  expect(scrollState.minRowWidth).toBeGreaterThanOrEqual(scrollState.tableWidth - 1);
  expect(scrollState.maxRowWidth).toBeLessThanOrEqual(scrollState.tableWidth + 1);
  expect(scrollState.transparentGutterCount).toBe(0);
}

async function expectCompareRefControlsFit(page, testInfo, options = {}) {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector("codger-review-workspace .review-workspace-header");
    const title = document.querySelector("codger-review-workspace .review-workspace-title");
    const controls = document.querySelector(
      "codger-review-workspace .review-compare-ref-controls",
    );
    const baseSelect = document.querySelector('select[data-compare-ref="base"]');
    const headSelect = document.querySelector('select[data-compare-ref="head"]');
    const separator = controls.querySelector(".review-compare-ref-separator");
    const subtitle = document.querySelector(
      "codger-review-workspace .review-workspace-subtitle",
    );
    const titleHeading = document.querySelector(
      "codger-review-workspace .review-workspace-title h2",
    );

    function box(element) {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    }

    function scrollBox(element) {
      return {
        ...box(element),
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
      };
    }

    function selectMetrics(element) {
      const style = window.getComputedStyle(element);
      return {
        ...scrollBox(element),
        css: {
          fieldSizing: style.fieldSizing,
          fontSize: style.fontSize,
          height: style.height,
          maxWidth: style.maxWidth,
          minWidth: style.minWidth,
          width: style.width,
        },
        hasInlineStyle: element.hasAttribute("style"),
      };
    }

    return {
      baseSelect: selectMetrics(baseSelect),
      controls: box(controls),
      headSelect: selectMetrics(headSelect),
      header: scrollBox(header),
      separator: box(separator),
      subtitle: box(subtitle),
      title: scrollBox(title),
      titleHeading: box(titleHeading),
    };
  });

  expect(metrics.header.scrollWidth).toBeLessThanOrEqual(metrics.header.clientWidth + 1);
  expect(metrics.title.scrollWidth).toBeLessThanOrEqual(metrics.title.clientWidth + 1);
  expect(metrics.controls.left).toBeGreaterThanOrEqual(metrics.header.left - 1);
  expect(metrics.controls.right).toBeLessThanOrEqual(metrics.header.right + 1);
  expect(metrics.subtitle.right).toBeLessThanOrEqual(metrics.header.right + 1);
  expect(metrics.subtitle.width).toBeGreaterThan(32);
  expect(metrics.baseSelect.right).toBeLessThanOrEqual(metrics.header.right + 1);
  expect(metrics.headSelect.right).toBeLessThanOrEqual(metrics.header.right + 1);
  for (const box of [
    metrics.baseSelect,
    metrics.controls,
    metrics.headSelect,
    metrics.subtitle,
    metrics.titleHeading,
  ]) {
    expect(box.top).toBeGreaterThanOrEqual(metrics.header.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(metrics.header.bottom + 1);
  }
  expect(metrics.baseSelect.width).toBeGreaterThan(70);
  expect(metrics.headSelect.width).toBeGreaterThan(70);
  if (options.sameRefCss) {
    expect(metrics.baseSelect.hasInlineStyle).toBe(false);
    expect(metrics.headSelect.hasInlineStyle).toBe(false);
    expect(metrics.baseSelect.css.fieldSizing).toBe(metrics.headSelect.css.fieldSizing);
    expect(metrics.baseSelect.css.fontSize).toBe(metrics.headSelect.css.fontSize);
    expect(metrics.baseSelect.css.height).toBe(metrics.headSelect.css.height);
    expect(metrics.baseSelect.css.maxWidth).toBe(metrics.headSelect.css.maxWidth);
    expect(metrics.baseSelect.css.minWidth).toBe(metrics.headSelect.css.minWidth);
  }
  if (options.compactRefs && testInfo.project.name !== "phone") {
    expect(metrics.baseSelect.width).toBeLessThan(180);
    expect(metrics.headSelect.width).toBeLessThan(220);
  }
  if (options.mixedRefs && testInfo.project.name !== "phone") {
    expect(metrics.baseSelect.width).toBeLessThan(180);
    expect(metrics.headSelect.width).toBeGreaterThan(metrics.baseSelect.width + 120);
  }
  if (options.tightRefGaps && testInfo.project.name !== "phone") {
    expect(metrics.separator.left - metrics.baseSelect.right).toBeLessThanOrEqual(16);
    expect(metrics.headSelect.left - metrics.separator.right).toBeLessThanOrEqual(72);
  }
  if (options.visibleHeadRef && testInfo.project.name !== "phone") {
    expect(metrics.headSelect.scrollWidth).toBeLessThanOrEqual(
      metrics.headSelect.clientWidth + 4,
    );
  }

  if (testInfo.project.name === "phone") {
    expect(metrics.header.height).toBeLessThanOrEqual(84);
  } else {
    expect(metrics.header.height).toBeLessThanOrEqual(44);
  }
}

async function expectAlignedWorkspaceHeaders(page, selectors) {
  const metrics = await page.evaluate((headerSelectors) => {
    return headerSelectors.map((selector) => {
      const element = document.querySelector(selector);
      return {
        height: element?.getBoundingClientRect().height ?? 0,
        clientHeight: element?.clientHeight ?? 0,
        scrollHeight: element?.scrollHeight ?? 0,
      };
    });
  }, selectors);
  const heights = metrics.map((metric) => metric.height);

  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);

  expect(minHeight).toBeGreaterThan(0);
  expect(maxHeight - minHeight).toBeLessThanOrEqual(1);
  for (const metric of metrics) {
    expect(metric.scrollHeight).toBeLessThanOrEqual(metric.clientHeight + 1);
  }
}

async function expectMatchingPaneTitleSizes(page, selectors) {
  const fontSizes = await page.evaluate((headerSelectors) => {
    return headerSelectors.map((selector) => {
      const heading = document.querySelector(`${selector} h2`);
      return Number.parseFloat(window.getComputedStyle(heading).fontSize);
    });
  }, selectors);
  const minSize = Math.min(...fontSizes);
  const maxSize = Math.max(...fontSizes);

  expect(minSize).toBeGreaterThan(0);
  expect(maxSize - minSize).toBeLessThanOrEqual(0.1);
}

async function stabilizeDynamicText(page) {
  await page.addStyleTag({
    content: `
      [data-field="modified"] dd {
        color: transparent !important;
        font-size: 0 !important;
      }

      [data-field="modified"] dd::after {
        content: "fixture time";
        color: var(--text);
        font-size: 0.8rem;
      }
    `,
  });
}
