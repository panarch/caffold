import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const LAST_DIRECTORY_KEY = `caffold:last-directory-path:${resolve("tests/fixtures/home")}`;
const LONG_ROOT_FILE =
  "this-is-a-very-long-file-name-used-to-test-horizontal-scrolling-in-the-files-pane.md";
const LONG_CHANGE_FILE =
  "src/planner/this-is-a-very-long-change-file-name-used-to-test-horizontal-scrolling-in-the-changes-pane.rs";

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus()),
    }),
  );

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
        export const GitPullRequest = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M6 9v12" }], ["path", { d: "M18 15V5" }], ["path", { d: "M18 5h-5" }]];
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

test("serves PWA manifest and icon assets", async ({ page, request }) => {
  await page.goto("/");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/assets/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/assets/icons/caffold.svg",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/assets/icons/apple-touch-icon.png",
  );
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    "content",
    "default",
  );

  const manifestResponse = await request.get("/assets/manifest.webmanifest");
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe("Caffold");
  expect(manifest.id).toBe("/");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon) => icon.src)).toEqual(
    expect.arrayContaining([
      "/assets/icons/caffold.svg",
      "/assets/icons/icon-192.png",
      "/assets/icons/icon-512.png",
      "/assets/icons/maskable-192.png",
      "/assets/icons/maskable-512.png",
    ]),
  );

  const svgResponse = await request.get("/assets/icons/caffold.svg");
  expect(svgResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(await svgResponse.text()).toContain('rx="48"');

  const markResponse = await request.get("/assets/icons/caffold-mark.svg");
  expect(markResponse.headers()["content-type"]).toContain("image/svg+xml");
  const markSvg = await markResponse.text();
  expect(markSvg).toContain('viewBox="40 40 176 176"');
  expect(markSvg).not.toContain("<rect");

  const gitBrandResponse = await request.get("/assets/brand/git-logomark-light.svg");
  expect(gitBrandResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(await gitBrandResponse.text()).toContain("#100f0d");

  const githubBrandResponse = await request.get(
    "/assets/brand/github-invertocat-light.svg",
  );
  expect(githubBrandResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(await githubBrandResponse.text()).toContain("<svg");

  const codexBrandResponse = await request.get("/assets/brand/codex-template@2x.png");
  expect(codexBrandResponse.headers()["content-type"]).toContain("image/png");
  const codexBrand = await codexBrandResponse.body();
  expect([...codexBrand.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  const pngResponse = await request.get("/assets/icons/icon-192.png");
  expect(pngResponse.headers()["content-type"]).toContain("image/png");
  const png = await pngResponse.body();
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  const serviceWorkerResponse = await request.get("/service-worker.js");
  expect(serviceWorkerResponse.headers()["content-type"]).toContain("text/javascript");
  expect(serviceWorkerResponse.headers()["cache-control"]).toContain("no-cache");
  expect(serviceWorkerResponse.headers()["service-worker-allowed"]).toBe("/");
  const serviceWorker = await serviceWorkerResponse.text();
  expect(serviceWorker).toMatch(/const CACHE_NAME = "caffold-shell-v\d+"/);
  expect(serviceWorker).toContain("/assets/icons/caffold-mark.svg");
  expect(serviceWorker).toContain("/assets/brand/git-logomark-light.svg");
  expect(serviceWorker).toContain("/assets/brand/github-invertocat-light.svg");
  expect(serviceWorker).toContain("/assets/brand/codex-template@2x.png");
  expect(serviceWorker).toContain("/assets/pages/app-shell/layout.js");
  expect(serviceWorker).toContain("/assets/pages/app-shell/layout.css");
  expect(serviceWorker).toContain("/assets/pages/app-shell/files/page.js");
  expect(serviceWorker).toContain("/assets/components/file-list.js");
  expect(serviceWorker).toContain("/assets/pages/app-shell/review-workspace/layout.js");
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/git/working-tree/page.js",
  );
  expect(serviceWorker).not.toContain("/assets/components/changes-tree.js");
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/issues/layout.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/issues/list/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/issues/detail/page.js",
  );
  expect(serviceWorker).not.toContain("/assets/components/github-issues-list.js");
  expect(serviceWorker).not.toContain("/assets/components/github-issue-viewer.js");
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/pulls/layout.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/pulls/list/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/pulls/detail/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/pulls/files/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/app-shell/review-workspace/github/pulls/files/components/tree.js",
  );
  expect(serviceWorker).not.toContain("/assets/components/github-pulls-list.js");
  expect(serviceWorker).not.toContain("/assets/components/github-pull-viewer.js");
  expect(serviceWorker).not.toContain("/assets/components/github-pull-files-tree.js");
  expect(serviceWorker).not.toContain("/assets/components/app-shell.js");
  expect(serviceWorker).not.toContain("/assets/components/review-workspace.js");
  expect(serviceWorker).toContain("/assets/components/header-actions/codex-status.css");
  expect(serviceWorker).toContain("/assets/components/header-actions/codex-status.js");
  expect(serviceWorker).toContain("/assets/components/header-actions/git-status.js");
  expect(serviceWorker).toContain("/assets/components/header-actions/github-status.js");
  expect(serviceWorker).toContain("/assets/components/header-actions/shared.js");
  expect(serviceWorker).toContain('url.pathname.startsWith("/api/")');
  expect(serviceWorker).toContain("networkFirst(request, \"/\")");
  expect(serviceWorker).toContain('url.pathname.startsWith("/assets/")');
  expect(serviceWorker).toContain("networkFirst(request)");
  expect(serviceWorker).not.toContain("cacheFirst");

  const serviceWorkerScope = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) {
      return null;
    }

    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(serviceWorkerScope).toBe("http://127.0.0.1:18765/");
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
  await expect(page.locator("caffold-file-list")).toContainText("src");
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
  await expect(page.locator("caffold-file-list")).toContainText("src");

  await page.waitForTimeout(240);
  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("caffold-file-list")).toContainText("src");

  releaseProjectResponses();
});

test("browses directories and opens a source file", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("caffold-file-list")).toContainText(".caffold-hidden");
  await expect(page.locator("caffold-file-list")).toContainText("src");
  await expect(page.locator('button[data-entry-path="src"] .entry-icon')).toHaveAttribute(
    "title",
    "Git repository",
  );
  await expect(page.locator('button[data-entry-path=".caffold-hidden"]')).toHaveClass(
    /is-hidden/,
  );
  await expect(page.locator(".parent-entry")).toHaveCount(0);

  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator(".parent-entry")).toBeVisible();
  await expect(page.locator("caffold-file-list .git-summary")).toBeVisible();
  await expect(page.locator("caffold-file-list .git-summary")).toHaveClass(/is-dirty/);
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
  await expect(page.locator("caffold-file-list .entry-icon-svg").first()).toBeVisible();

  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.getByText("Loading file...")).toHaveCount(0);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");
  await expect(page.locator("caffold-code-viewer")).not.toContainText("Highlighted");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expectGlobalScrollLocked(page);
  await expectPanelScrollContainers(page);
  await page.getByRole("button", { name: "Show details for example.rs" }).click();
  const details = page.locator("caffold-file-viewer .viewer-meta-popover");
  await expect(details).toBeVisible();
  await expect(details.locator('[data-field="path"] dd')).toHaveText("src/example.rs");
  await expect(details.locator('[data-field="language"] dd')).toHaveText("Rust");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page.locator("caffold-file-list")).toBeVisible();
    await expect(page.locator("caffold-file-viewer")).toBeHidden();
  }
  await page.locator('button[data-entry-path="src/planner"]').click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.locator('button[data-entry-path="src/planner/mod.rs"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("mod.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("plan_review");
  await expect(page.locator(".line-number").first()).toHaveText("1");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "file-browser");
});

test("manages project records from the header switcher", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Project CRUD mutates shared fixture data.");

  await page.goto("/");
  const switcher = page.locator("caffold-project-switcher");

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

  await page.locator('caffold-pathbar button[data-path=""]').click();
  await expect(page.locator("caffold-pathbar")).not.toContainText("src");
  await openProjectPopover(switcher);
  await switcher.locator(".project-open").filter({ hasText: "Fixture Repo" }).click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
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

test("groups header review actions into Git, GitHub, and Codex popovers", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "main", dirty: true };
  let gitFileCount = 0;
  const githubStatus = {
    repository,
    github: {
      owner: "example",
      name: "caffold",
      nameWithOwner: "example/caffold",
      url: "https://github.com/example/caffold",
    },
    ghAvailable: true,
    authenticated: true,
    issuesAvailable: true,
    pullsAvailable: true,
    message: null,
  };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: Array.from({ length: gitFileCount }, (_, index) => ({
          path: `src/header-${index}.rs`,
          repoRelativePath: `header-${index}.rs`,
          status: " M",
          category: "unstaged",
          staged: false,
          unstaged: true,
          untracked: false,
        })),
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(githubStatus),
    }),
  );

  const openSourceDirectoryWithGitCount = async (count) => {
    gitFileCount = count;
    await page.goto("/");
    const expectedTitle = `Git actions, ${count} changed ${count === 1 ? "file" : "files"}`;
    const gitButton = headerActionGroupButton(page, "git");
    const entryPoint = await page
      .waitForFunction((title) => {
        const git = document.querySelector(
          'caffold-header-actions button[data-action-group="git"]',
        );
        if (git?.getAttribute("title") === title) {
          return "git";
        }

        if (document.querySelector('button[data-entry-path="src"]')) {
          return "src";
        }

        return null;
      }, expectedTitle)
      .then((handle) => handle.jsonValue());

    if (entryPoint === "src") {
      const sourceDirectory = page.locator('button[data-entry-path="src"]');
      await expect(sourceDirectory).toBeVisible();
      await sourceDirectory.click();
    }
    await expect(gitButton).toHaveAttribute("title", expectedTitle);
  };

  await openSourceDirectoryWithGitCount(0);

  const gitButton = headerActionGroupButton(page, "git");
  const githubButton = headerActionGroupButton(page, "github");
  const codexButton = headerActionGroupButton(page, "codex");
  await expect(gitButton.locator(".header-action-badge")).toHaveCount(0);
  const gitBrandIcon = gitButton.locator("img.header-action-brand-icon");
  const githubBrandIcon = githubButton.locator("img.header-action-brand-icon");
  const codexBrandIcon = codexButton.locator("img.header-action-brand-icon");
  await expect(gitBrandIcon).toBeVisible();
  await expect(githubBrandIcon).toBeVisible();
  await expect(codexBrandIcon).toBeVisible();
  await expect(gitBrandIcon).toHaveAttribute(
    "src",
    "/assets/brand/git-logomark-light.svg",
  );
  await expect(githubBrandIcon).toHaveAttribute(
    "src",
    "/assets/brand/github-invertocat-light.svg",
  );
  await expect(codexBrandIcon).toHaveAttribute(
    "src",
    "/assets/brand/codex-template@2x.png",
  );
  await expectHeaderBrand(page);
  await expectHeaderActionsFit(page);
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "header-actions-badge-zero");

  await openSourceDirectoryWithGitCount(13);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("13");
  const gitPopover = await openHeaderActionGroup(page, "git");
  await expectHeaderGroupOpenVisualState(page, "git");
  await expect(gitPopover.locator(".header-actions-popover-header")).toContainText(
    "13 changed files",
  );
  await expect(
    gitPopover.locator('button[data-action="open-diff-workspace"] .header-menu-metric'),
  ).toHaveText("13");
  await expect(gitPopover.locator('button[data-action="open-compare-workspace"]')).toContainText(
    "Compare",
  );
  await expect(gitPopover.locator('button[data-action="open-log-workspace"]')).toContainText(
    "Log",
  );
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "git");
  await captureReviewScreenshot(page, testInfo, "header-actions-git-popover");

  await openSourceDirectoryWithGitCount(120);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("99+");
  const githubPopover = await openHeaderActionGroup(page, "github");
  await expectHeaderGroupOpenVisualState(page, "github");
  await expect(githubPopover.locator(".header-actions-popover-header")).toContainText(
    "example/caffold",
  );
  await expect(githubPopover.locator('button[data-action="open-github-pulls-workspace"]')).toContainText(
    "PRs",
  );
  await expect(githubPopover.locator('button[data-action="open-github-issues-workspace"]')).toContainText(
    "Issues",
  );
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "github");
  await captureReviewScreenshot(page, testInfo, "header-actions-github-popover");

  const codexPopover = await openHeaderActionGroup(page, "codex");
  await expectHeaderGroupOpenVisualState(page, "codex");
  await expect(codexPopover.locator(".header-actions-popover-header")).toContainText(
    "Connected",
  );
  await expect(codexPopover.locator(".header-status-panel")).toContainText(
    "user@example.com",
  );
  await expect(codexPopover.locator(".header-status-panel")).toContainText("pro");
  await expect(codexPopover.locator(".header-status-panel")).toContainText(
    "Remaining usage",
  );
  await expect(codexPopover.locator(".header-status-panel")).toContainText("5 hours");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("17%");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("1 week");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("69%");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("3 available");
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "codex");
  await captureReviewScreenshot(page, testInfo, "header-actions-codex-popover");
});

test("keeps header action slots stable while status checks resolve", async ({ page }) => {
  const repository = { rootPath: "src", branch: "main", dirty: false };
  let resolveGitStatus;
  let resolveGithubStatus;
  const gitStatusResponse = new Promise((resolve) => {
    resolveGitStatus = resolve;
  });
  const githubStatusResponse = new Promise((resolve) => {
    resolveGithubStatus = resolve;
  });

  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    const body = await gitStatusResponse;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, async (route) => {
    const body = await githubStatusResponse;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto("/");
  const sourceDirectory = page.locator('button[data-entry-path="src"]');
  await expect(sourceDirectory).toBeVisible();
  await sourceDirectory.click();

  const gitButton = headerActionGroupButton(page, "git");
  const githubButton = headerActionGroupButton(page, "github");
  const codexButton = headerActionGroupButton(page, "codex");
  await expect(gitButton).toBeVisible();
  await expect(githubButton).toBeVisible();
  await expect(codexButton).toBeVisible();
  await expect(gitButton).toHaveAttribute("data-state", "available");
  await expect(gitButton).toHaveAttribute("title", "Git actions, Checking...");
  await expect(githubButton).toHaveAttribute("data-state", "pending");
  await expect(codexButton).toHaveAttribute("data-state", "available");
  await expectHeaderButtonOpacity(page, "git", 1);
  await expectHeaderButtonOpacity(page, "github", 1);

  const githubPendingPopover = await openHeaderActionGroup(page, "github");
  await expect(githubPendingPopover).toContainText("Checking GitHub status");

  resolveGithubStatus({
    repository,
    github: null,
    ghAvailable: true,
    authenticated: true,
    issuesAvailable: false,
    pullsAvailable: false,
    message: "No GitHub remote detected",
  });
  await expect(githubButton).toHaveAttribute("data-state", "unavailable");
  await expect(githubButton).toHaveAttribute("title", "No GitHub remote detected");
  await expectHeaderButtonOpacity(page, "github", 0.72);
  await expect(githubPendingPopover).toContainText("No GitHub remote detected");
  await expect(
    githubPendingPopover.locator('button[data-action="open-github-pulls-workspace"]'),
  ).toHaveCount(0);

  resolveGitStatus({
    repository,
    files: Array.from({ length: 7 }, (_, index) => ({
      path: `src/pending-${index}.rs`,
      repoRelativePath: `pending-${index}.rs`,
      status: " M",
      category: "unstaged",
      staged: false,
      unstaged: true,
      untracked: false,
    })),
  });
  await expect(gitButton).toHaveAttribute("data-state", "available");
  await expect(gitButton).toHaveAttribute("title", "Git actions, 7 changed files");
  await expect(gitButton.locator(".header-action-badge")).toHaveText("7");
  await expectHeaderActionsFit(page);
});

test("restores project file routes and browser navigation", async ({ page }, testInfo) => {
  const project = await mockRegisteredProject(page);
  let gitStatusRequests = 0;
  let listRequests = 0;

  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    gitStatusRequests += 1;
    await route.continue();
  });
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    await route.continue();
  });

  await page.goto(`/projects/${project.id}/files/example.rs`);
  await expect(page).toHaveURL(`/projects/${project.id}/files/example.rs`);
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");

  await page.reload();
  await expect(page).toHaveURL(`/projects/${project.id}/files/example.rs`);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page).toHaveURL(`/projects/${project.id}/files`);
    await expect(page.locator("caffold-file-list")).toBeVisible();
  }

  await page.goto(`/projects/${project.id}/files`);
  await expect(page.locator("caffold-file-list")).toBeVisible();
  const gitGroupButton = headerActionGroupButton(page, "git");
  await expect(gitGroupButton.locator(".header-action-badge")).toHaveText(/\d+/);
  const headerActionsHtml = await page.locator("caffold-header-actions").evaluate((element) => {
    window.__caffoldGitGroupButton = element.querySelector('button[data-action-group="git"]');
    return element.innerHTML;
  });
  const listRequestsBeforeFileClick = listRequests;
  const gitStatusRequestsBeforeFileClick = gitStatusRequests;
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/files/example.rs`);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  expect(listRequests).toBe(listRequestsBeforeFileClick);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeFileClick);
  const headerActionsState = await page.locator("caffold-header-actions").evaluate((element) => {
    const gitGroupButton = element.querySelector('button[data-action-group="git"]');
    return {
      html: element.innerHTML,
      sameGitGroupButton: gitGroupButton === window.__caffoldGitGroupButton,
    };
  });
  expect(headerActionsState.sameGitGroupButton).toBe(true);
  expect(headerActionsState.html).toBe(headerActionsHtml);
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/files`);
  await expect(page.locator("caffold-file-list")).toBeVisible();

  await page.goto(`/projects/${project.id}/files/planner`);
  await expect(page).toHaveURL(`/projects/${project.id}/files/planner`);
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/files`);
  await expect(page.locator('button[data-entry-path="src/example.rs"]')).toBeVisible();
});

test("restores project review routes", async ({ page }) => {
  const project = await mockRegisteredProject(page);
  const repository = { rootPath: "src", branch: "feature/review", dirty: true };
  const commit = {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    shortSha: "abcdef1",
    subject: "Route review state",
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_767_000_000_000,
  };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  let gitStatusRequests = 0;
  let gitCompareRequests = 0;
  let gitCommitRequests = 0;
  let githubIssuesRequests = 0;
  let githubPullsRequests = 0;
  let githubPullRequests = 0;
  let githubPullFilesRequests = 0;
  let listRequests = 0;

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    await route.continue();
  });

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
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
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "unstaged",
        diff: [
          "diff --git a/example.rs b/example.rs",
          "index 1111111..2222222 100644",
          "--- a/example.rs",
          "+++ b/example.rs",
          "@@ -1,1 +1,2 @@",
          "-old route line",
          "+new route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "feature/review",
      }),
    }),
  );
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/main");
    const head = url.searchParams.get("head");
    expect(["feature/review", "main"]).toContain(head);
    const files =
      head === "main"
        ? []
        : [
            {
              path: "src/example.rs",
              repoRelativePath: "example.rs",
              status: "M",
            },
          ];

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef: "origin/main",
        headRef: head,
        files,
      }),
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/main");
    expect(url.searchParams.get("head")).toBe("feature/review");
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "origin/main...feature/review",
        diff: [
          "diff --git a/example.rs b/example.rs",
          "@@ -1,1 +1,2 @@",
          "-old compare route line",
          "+new compare route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits: [commit],
        page: 2,
        perPage: 50,
        totalCommits: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    }),
  );
  await page.route(/\/api\/git\/commit(?:\?|$)/, (route) => {
    gitCommitRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commit,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            status: "M",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/commit-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("sha")).toBe(commit.sha);
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        kind: "commit abcdef1",
        diff: [
          "diff --git a/planner/mod.rs b/planner/mod.rs",
          "@@ -1,1 +1,2 @@",
          "-old commit route line",
          "+new commit route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
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
    }),
  );
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    githubIssuesRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: [
          {
            number: 42,
            title: "Route issue detail",
            state: "OPEN",
            author: "Caffold",
            labels: ["routing"],
            assignees: [],
            comments: 1,
            updatedAt: "2026-07-01T10:00:00Z",
            url: "https://github.com/example/caffold/issues/42",
          },
        ],
        page: 2,
        perPage: 50,
        totalIssues: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/issue(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("42");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        issue: {
          number: 42,
          title: "Route issue detail",
          state: "OPEN",
          author: "Caffold",
          labels: ["routing"],
          assignees: [],
          comments: 1,
          body: "Route issue body",
          bodyHtml: "<p>Route issue body</p>",
          createdAt: "2026-07-01T08:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          url: "https://github.com/example/caffold/issues/42",
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    githubPullsRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("page")).toBe("2");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: [
          {
            number: 12,
            title: "Route pull request detail",
            state: "open",
            draft: false,
            author: "Caffold",
            labels: ["routing"],
            comments: 2,
            updatedAt: "2026-07-01T10:00:00Z",
            url: "https://github.com/example/caffold/pull/12",
          },
        ],
        page: 2,
        perPage: 50,
        totalPulls: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    githubPullRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        pull: {
          number: 12,
          title: "Route pull request detail",
          state: "OPEN",
          draft: false,
          author: "Caffold",
          labels: ["routing"],
          comments: 1,
          reviews: 1,
          commits: 1,
          additions: 4,
          deletions: 2,
          changedFiles: 1,
          baseRefName: "main",
          headRefName: "feature/pr-route",
          body: "Route PR body",
          bodyHtml: "<p>Route PR body</p>",
          createdAt: "2026-07-01T08:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          url: "https://github.com/example/caffold/pull/12",
          conversationComments: [
            {
              author: "taehoon",
              body: "Conversation route comment",
              bodyHtml: "<p>Conversation route comment</p>",
              createdAt: "2026-07-01T08:30:00Z",
              updatedAt: "2026-07-01T08:30:00Z",
              url: "https://github.com/example/caffold/pull/12#issuecomment-1",
            },
          ],
          reviewComments: [
            {
              author: "codex",
              state: "COMMENTED",
              body: "Review summary route comment",
              bodyHtml: "<p>Review summary route comment</p>",
              submittedAt: "2026-07-01T09:00:00Z",
            },
          ],
          commitSummaries: [
            {
              sha: "1234567890abcdef1234567890abcdef12345678",
              shortSha: "1234567",
              subject: "Route PR commit",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:00:00Z",
              committedAt: "2026-07-01T09:00:00Z",
              url: "https://github.com/example/caffold/commit/1234567",
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, (route) => {
    githubPullFilesRequests += 1;
    const url = new URL(route.request().url());
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
            additions: 4,
            deletions: 2,
            changes: 6,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/planner/mod.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/planner/mod.rs",
          },
        ],
        totalFiles: 1,
      }),
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: "M",
        kind: "PR #12",
        diff: [
          "diff --git a/planner/mod.rs b/planner/mod.rs",
          "@@ -1,1 +1,2 @@",
          "-old PR route line",
          "+new PR route line",
        ].join("\n"),
        diffUnavailable: false,
        message: null,
      }),
    });
  });

  await page.goto(`/projects/${project.id}/diff/example.rs`);
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "diff",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  await page.goto(`/projects/${project.id}/diff`);
  await expect(page.locator('button[data-change-path="src/example.rs"]')).toBeVisible();
  const gitStatusRequestsBeforeDiffClick = gitStatusRequests;
  await page.locator('button[data-change-path="src/example.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/diff/example.rs`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeDiffClick);
  const gitStatusRequestsBeforeDiffBack = gitStatusRequests;
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/diff`);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeDiffBack);

  await page.goto(
    `/projects/${project.id}/compare/example.rs?base=origin%2Fmain&head=feature%2Freview`,
  );
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "compare",
  );
  await expect(page.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(page.locator('select[data-compare-ref="head"]')).toHaveValue("feature/review");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");
  await page.goto(`/projects/${project.id}/compare?base=origin%2Fmain&head=feature%2Freview`);
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  const compareHeaderActionsHtml = await page
    .locator("caffold-header-actions")
    .evaluate((element) => {
      window.__caffoldCompareGitGroupButton = element.querySelector(
        'button[data-action-group="git"]',
      );
      return element.innerHTML;
    });
  const listRequestsBeforeCompareRefChange = listRequests;
  const gitStatusRequestsBeforeCompareRefChange = gitStatusRequests;
  await page.locator('select[data-compare-ref="head"]').selectOption("main");
  await expect(page).toHaveURL(`/projects/${project.id}/compare?base=origin%2Fmain&head=main`);
  await expect(page.locator("caffold-git-compare-page")).toContainText("0 files");
  expect(listRequests).toBe(listRequestsBeforeCompareRefChange);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeCompareRefChange);
  const compareHeaderActionsState = await page
    .locator("caffold-header-actions")
    .evaluate((element) => {
      const gitGroupButton = element.querySelector('button[data-action-group="git"]');
      return {
        html: element.innerHTML,
        sameGitGroupButton: gitGroupButton === window.__caffoldCompareGitGroupButton,
      };
    });
  expect(compareHeaderActionsState.sameGitGroupButton).toBe(true);
  expect(compareHeaderActionsState.html).toBe(compareHeaderActionsHtml);

  await page.locator('select[data-compare-ref="head"]').selectOption("feature/review");
  await expect(page).toHaveURL(
    `/projects/${project.id}/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  const gitCompareRequestsBeforeClick = gitCompareRequests;
  await page.locator('button[data-compare-path="src/example.rs"]').click();
  await expect(page).toHaveURL(
    `/projects/${project.id}/compare/example.rs?base=origin%2Fmain&head=feature%2Freview`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");
  expect(gitCompareRequests).toBe(gitCompareRequestsBeforeClick);
  const gitCompareRequestsBeforeBack = gitCompareRequests;
  await page.goBack();
  await expect(page).toHaveURL(
    `/projects/${project.id}/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  expect(gitCompareRequests).toBe(gitCompareRequestsBeforeBack);

  await page.goto(`/projects/${project.id}/log/${commit.sha}/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "log",
  );
  await expect(page.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  await page.goto(`/projects/${project.id}/log/${commit.sha}?page=2`);
  await expect(page.locator('button[data-commit-path="src/planner/mod.rs"]')).toBeVisible();
  const gitCommitRequestsBeforeClick = gitCommitRequests;
  await page.locator('button[data-commit-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/log/${commit.sha}/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  expect(gitCommitRequests).toBe(gitCommitRequestsBeforeClick);
  const gitCommitRequestsBeforeBack = gitCommitRequests;
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/log/${commit.sha}?page=2`);
  expect(gitCommitRequests).toBe(gitCommitRequestsBeforeBack);
  await page.getByRole("button", { name: "Back to log" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/log?page=2`);

  await page.goto(`/projects/${project.id}/issues/42?page=2`);
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "issues",
  );
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText("Route issue body");
  const githubIssuesRequestsBeforeBack = githubIssuesRequests;
  await page.getByRole("button", { name: "Back to issues" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/issues?page=2`);
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeBack);
  await expect(page.locator('button[data-issue-number="42"]')).toBeVisible();
  const githubIssuesRequestsBeforeIssueClick = githubIssuesRequests;
  await page.locator('button[data-issue-number="42"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/issues/42?page=2`);
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText("Route issue body");
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeIssueClick);

  await page.goto(`/projects/${project.id}/pulls/12/files/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "pulls",
  );
  await expect(page.locator(".workspace-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "files",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  await page.goto(`/projects/${project.id}/pulls/12/files?page=2`);
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files?page=2`);
  await expect(page.locator("caffold-github-pull-files-page")).toBeVisible();
  await expect(page.locator(".workspace-mode-pulls caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  const githubPullFilesRequestsBeforeFileClick = githubPullFilesRequests;
  await page.locator('button[data-pull-file-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(githubPullFilesRequests).toBe(githubPullFilesRequestsBeforeFileClick);
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files?page=2`);
  await page.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12?page=2`);
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText("Route PR body");
  const githubPullRequestsBeforeBack = githubPullRequests;
  await page.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls?page=2`);
  expect(githubPullRequests).toBe(githubPullRequestsBeforeBack);
  await expect(page.locator('button[data-pull-number="12"]')).toBeVisible();
  await page.locator('button[data-pull-number="12"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12?page=2`);
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText("Route PR body");
});

test("previews image files in the viewer", async ({ page }) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="preview-image.svg"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("preview-image.svg");
  await expect(page.locator("caffold-file-viewer")).toContainText("SVG image");
  await page.getByRole("button", { name: "Show details for preview-image.svg" }).click();
  const details = page.locator("caffold-file-viewer .viewer-meta-popover");
  await expect(details.locator('[data-field="size"] dd')).toHaveText("325 B");
  await expect(details.locator('[data-field="type"] dd')).toHaveText("SVG image");

  const preview = page.locator("caffold-file-viewer img.image-preview");
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
      caffold-file-list .file-list {
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
  await clickHeaderAction(page, "git", "open-diff-workspace");
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
  await expect(page.locator("caffold-code-viewer")).toContainText("long-source-token");
  await expectHorizontalScroller(page, "caffold-code-viewer .code-lines");
  await expectCodeViewerGutterSeparated(page);
});

test("uses a single-pane file viewer on phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Only the phone layout switches browser panes.");

  await page.goto("/");
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list {
        max-height: 140px;
      }
    `,
  });

  const shell = page.locator("caffold-app-shell");
  const fileList = page.locator("caffold-file-list .file-list");
  const fileTarget = page.locator(`button[data-entry-path="${LONG_ROOT_FILE}"]`);
  await expect(shell).toHaveAttribute("data-browser-view", "list");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toBeHidden();

  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(shell).toHaveAttribute("data-browser-view", "viewer");
  await expect(page.locator("caffold-file-list")).toBeHidden();
  await expect(page.locator("caffold-file-viewer")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toContainText(LONG_ROOT_FILE);
  await expect(page.getByRole("button", { name: "Back to files" })).toBeVisible();
  await expectMobileBrowserViewerOverlay(page);
  await expectMobileViewerCompactHeader(page);
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "mobile-file-viewer-single-pane");

  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(shell).toHaveAttribute("data-browser-view", "list");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toBeHidden();
  await expect(fileTarget).toHaveAttribute("aria-current", "true");
  await expectPreservedScroll(fileList, beforeFileScroll);
});

test("keeps list scroll positions when selecting files and changes", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list,
      caffold-git-working-tree-page .changes-tree-list {
        max-height: 72px;
      }
    `,
  });

  const fileList = page.locator("caffold-file-list .file-list");
  const fileTarget = page.locator('button[data-entry-path="README.md"]');
  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page.locator("caffold-file-list")).toBeVisible();
  }
  await expectPreservedScroll(fileList, beforeFileScroll);

  await page.locator('button[data-entry-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");

  const changesList = page.locator("caffold-git-working-tree-page .changes-tree-list");
  const changeTarget = page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`);
  await changeTarget.scrollIntoViewIfNeeded();
  const beforeChangesScroll = await scrollTop(changesList);
  expect(beforeChangesScroll).toBeGreaterThan(0);

  await changeTarget.click();
  await expect(page.locator("caffold-diff-viewer")).toContainText("long_change_name_fixture");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(page.locator("caffold-git-working-tree-page")).toBeVisible();
  }
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

  const gitButton = headerActionGroupButton(page, "git");
  await expect(gitButton).toBeVisible();
  await expect(page.locator("caffold-pathbar .header-action-button")).toHaveCount(0);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("2");
  await expect(gitButton.locator("img.header-action-brand-icon")).toBeVisible();
  await expect(gitButton.locator("img.header-action-brand-icon")).toHaveAttribute(
    "src",
    "/assets/brand/git-logomark-light.svg",
  );
  await expect(gitButton).not.toContainText("master");
  await expect(gitButton).toHaveAttribute("title", "Git actions, 2 changed files");

  const gitPopover = await openHeaderActionGroup(page, "git");
  const diffMenuItem = gitPopover.locator('button[data-action="open-diff-workspace"]');
  await expect(diffMenuItem.locator(".header-menu-label")).toHaveText("Diff");
  await expect(diffMenuItem.locator(".header-menu-metric")).toHaveText("2");
  await diffMenuItem.click();
  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "diff");
  await expect(workspace.getByRole("button", { name: "Close review workspace" })).toBeVisible();
  await expect(page.locator("caffold-git-working-tree-page")).toContainText("Unstaged");
  await expect(page.locator("caffold-git-working-tree-page")).toContainText("example.rs");
  await expect(page.locator("caffold-git-working-tree-page")).toContainText("deleted.rs");
  if (testInfo.project.name !== "phone") {
    const resizeHandle = workspace.locator(".workspace-mode-diff .review-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace .workspace-mode-diff > caffold-git-working-tree-page",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace .workspace-mode-diff > caffold-git-working-tree-page",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }

  await page.locator('button[data-change-path="src/example.rs"]').click();
  await expect(page.locator(".workspace-mode-diff caffold-review-file-viewer")).toContainText(
    "example.rs",
  );
  await expect(page.locator(".workspace-mode-diff .viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to changes",
      detailSelector: ".workspace-mode-diff caffold-review-file-viewer",
      listSelector: "caffold-git-working-tree-page",
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-git-working-tree-page .changes-tree-panel > header",
      ".workspace-mode-diff caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-git-working-tree-page .changes-tree-panel > header",
      ".workspace-mode-diff caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await expect(page.locator("caffold-diff-viewer")).toContainText("@@ -10,4 +10,5 @@");
  await expect(page.locator("caffold-diff-viewer")).toContainText("old line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new line");
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

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(page.locator("caffold-git-working-tree-page")).toBeVisible();
    await expect(page.locator(".workspace-mode-diff caffold-review-file-viewer")).toBeHidden();
  }
  await page.locator('button[data-change-path="src/deleted.rs"]').click();
  await expect(page.locator(".workspace-mode-diff .viewer-subtitle")).toHaveText(
    "Deleted · Unstaged",
  );
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(workspace.locator(".workspace-mode-diff")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(page.locator("caffold-git-working-tree-page")).toBeVisible();
    await expect(page.locator(".workspace-mode-diff caffold-review-file-viewer")).toBeHidden();
    await expect(page.locator('button[data-change-path="src/deleted.rs"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
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

  const gitPopover = await openHeaderActionGroup(page, "git");
  const compareButton = gitPopover.locator('button[data-action="open-compare-workspace"]');
  await expect(compareButton.locator(".header-menu-label")).toHaveText("Compare");
  await expect(compareButton).toHaveAttribute("title", "Open Compare");
  await compareButton.click();

  const workspace = page.locator("caffold-review-workspace");
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
  await expect(page.locator("caffold-git-compare-page")).toContainText("2 files");
  await expect(page.locator("caffold-git-compare-page")).toContainText("planner");
  await expect(page.locator("caffold-git-compare-page")).toContainText("function.rs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("new.rs");

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

  await page.locator('button[data-compare-path="src/runtime/release.rs"]').click();
  await expect(page.locator('button[data-compare-path="src/runtime/release.rs"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(".workspace-mode-compare caffold-review-file-viewer")).toContainText(
    "release.rs",
  );
  await expect(page.locator(".workspace-mode-compare .viewer-subtitle")).toHaveText(
    `Added · origin/release...${headRef}`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("old compare line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare line");
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to compare",
      detailSelector: ".workspace-mode-compare caffold-review-file-viewer",
      listSelector: "caffold-git-compare-page",
    });
    await page.getByRole("button", { name: "Back to compare" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(workspace.locator(".workspace-mode-compare")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(page.locator("caffold-git-compare-page")).toBeVisible();
    await expect(page.locator(".workspace-mode-compare caffold-review-file-viewer")).toBeHidden();
  }
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
            <p><strong>Review</strong> GitHub issues without leaving the readonly console.</p>
            <pre><code>cargo test</code></pre>
            <a href="https://example.com/docs">docs</a>
            <a href="javascript:alert(1)">unsafe</a>
            <script>alert(1)</script>
          `,
          createdAt: "2026-07-01T08:00:00Z",
        },
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const githubPopover = await openHeaderActionGroup(page, "github");
  const issuesButton = githubPopover.locator(
    'button[data-action="open-github-issues-workspace"]',
  );
  await expect(issuesButton.locator(".header-menu-label")).toHaveText("Issues");
  await issuesButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "issues");
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
  await expect(workspace).toHaveAttribute("data-workspace-mode", "issues");
  await expect(workspace.locator(".workspace-mode-issues")).toHaveAttribute(
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
  await expect(issueViewer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/example/caffold/issues/42",
  );
  await captureReviewScreenshot(page, testInfo, "github-issue-detail");

  await workspace.getByRole("button", { name: "Back to issues" }).click();
  await expect(workspace.locator(".workspace-mode-issues")).toHaveAttribute(
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
  const project = await mockRegisteredProject(page);
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

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("caffold-project-switcher")).toContainText(project.name);

  const githubPopover = await openHeaderActionGroup(page, "github");
  const pullsButton = githubPopover.locator('button[data-action="open-github-pulls-workspace"]');
  await expect(pullsButton.locator(".header-menu-label")).toHaveText("PRs");
  await pullsButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "pulls");
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
  await expect(workspace.locator(".workspace-mode-pulls")).toHaveAttribute(
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
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to pull requests",
      detailSelector: "caffold-github-pull-detail-page",
      listSelector: "caffold-github-pulls-list-page",
    });
  }
  await captureReviewScreenshot(page, testInfo, "github-pull-detail");

  await pullViewer.getByRole("button", { name: "Open files for PR #12" }).click();
  await expect(workspace.locator(".workspace-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "files",
  );
  await expect(page.locator("caffold-github-pull-files-tree")).toContainText("2 files");
  await expect(page.locator('button[data-pull-file-path="src/planner/mod.rs"]')).toBeVisible();
  await expect(page.locator(".workspace-mode-pulls caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  if (testInfo.project.name === "phone") {
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(page.locator("caffold-github-pull-files-tree")).toBeVisible();
    await expect(page.locator(".workspace-mode-pulls caffold-review-file-viewer")).toBeHidden();
  }

  const listRequestsBeforeFileClick = listRequests;
  const pullFilesRequestsBeforeFileClick = pullFilesRequests;
  await page.locator('button[data-pull-file-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(
    `/projects/${project.id}/pulls/12/files/planner/mod.rs`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR review line");
  expect(listRequests).toBe(listRequestsBeforeFileClick);
  expect(pullFilesRequests).toBe(pullFilesRequestsBeforeFileClick);
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to PR files",
      detailSelector: ".workspace-mode-pulls caffold-review-file-viewer",
      listSelector: "caffold-github-pull-files-tree",
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-github-pull-files-tree .github-pull-files-panel > header",
      ".workspace-mode-pulls caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-github-pull-files-tree .github-pull-files-panel > header",
      ".workspace-mode-pulls caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await captureReviewScreenshot(page, testInfo, "github-pull-file-diff");

  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files`);
  await expect(page.locator("caffold-github-pull-files-page")).toBeVisible();
  await workspace.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12`);
  await expect(pullViewer).toBeVisible();
  await workspace.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls`);
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

  const gitPopover = await openHeaderActionGroup(page, "git");
  const logButton = gitPopover.locator('button[data-action="open-log-workspace"]');
  await expect(logButton.locator(".header-menu-label")).toHaveText("Log");
  await expect(logButton).toHaveAttribute("title", "Open Log");
  await logButton.click();
  const workspace = page.locator("caffold-review-workspace");
  const logView = workspace.locator(".workspace-mode-log");
  const backButton = workspace.locator('button[data-action="back-review-workspace"]');
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "log");
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(page.locator("caffold-log-list")).toContainText("Update planner function");
  await expect(page.locator("caffold-log-list")).toContainText("abcdef1");
  await expect(page.locator("caffold-log-list")).toBeVisible();
  await expect(page.locator(".log-review-detail")).toBeHidden();
  const pagination = page.locator("caffold-log-list caffold-pagination");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(pagination.getByRole("button", { name: "Newest page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Newer page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Oldest page" }).click();
  await page.waitForTimeout(40);
  const preservedLogText = await page.locator("caffold-log-list").textContent();
  expect(preservedLogText).toContain("Update planner function");
  expect(preservedLogText).not.toContain("Loading log...");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(page.locator("caffold-log-list")).toContainText("Oldest page commit 1");
  await expect(pagination.getByRole("button", { name: "Older page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Oldest page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Newest page" }).click();
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(page.locator("caffold-log-list")).toContainText("Update planner function");

  const logEntry = page.locator(
    'caffold-log-list .log-entry[data-commit-sha="abcdef1234567890abcdef1234567890abcdef12"]',
  );
  const logList = page.locator("caffold-log-list .log-list");
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
  await expect(page.locator("caffold-log-list")).toBeHidden();
  await expect(page.locator(".log-review-detail")).toBeVisible();
  await expect(backButton).toBeVisible();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText("abcdef1");
  const commitTree = page.locator("caffold-commit-changes-tree");
  await expect(commitTree).toContainText("2 files");
  await expect(commitTree).not.toContainText("Update planner function");
  await expect(commitTree).toContainText("planner");
  await expect(commitTree).toContainText("function.rs");
  const commitFileButton = page.locator('button[data-commit-path="src/planner/function.rs"]');
  await expect(commitFileButton).toHaveAttribute("aria-current", "false");
  await expect(page.locator(".workspace-mode-log caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  if (testInfo.project.name === "phone") {
    await expect(logView.locator(".log-review-detail")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(commitTree).toBeVisible();
    await expect(page.locator(".workspace-mode-log caffold-review-file-viewer")).toBeHidden();
  }
  if (testInfo.project.name === "desktop") {
    const resizeHandle = workspace.locator(".log-review-detail .review-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace .log-review-detail > caffold-commit-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace .log-review-detail > caffold-commit-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }

  await commitFileButton.click();
  await expect(commitFileButton).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".workspace-mode-log .viewer-subtitle")).toHaveText(
    "Modified · Commit abcdef1",
  );
  if (testInfo.project.name === "phone") {
    await expect(logView.locator(".log-review-detail")).toHaveAttribute(
      "data-detail-view",
      "viewer",
    );
    await expectMobileReviewDetail(page, {
      backName: "Back to commit",
      detailSelector: ".workspace-mode-log caffold-review-file-viewer",
      listSelector: "caffold-commit-changes-tree",
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-commit-changes-tree .commit-tree-panel > header",
      ".workspace-mode-log caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-commit-changes-tree .commit-tree-panel > header",
      ".workspace-mode-log caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await expect(page.locator("caffold-diff-viewer")).toContainText("old planner line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new planner line");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to commit" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(logView.locator(".log-review-detail")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(commitTree).toBeVisible();
    await expect(page.locator(".workspace-mode-log caffold-review-file-viewer")).toBeHidden();
  }
  await backButton.click();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Log");
  await expect(page.locator("caffold-log-list")).toBeVisible();
  await expect(page.locator(".log-review-detail")).toBeHidden();
  await expect(logEntry).not.toHaveAttribute("aria-current");

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
});

test("restores the last opened directory after reload", async ({ page }) => {
  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-list .git-summary")).toBeVisible();

  await page.reload();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-list .git-summary")).toBeVisible();
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
  await expect(page.locator("caffold-file-list")).toContainText("src");
  await expect(page.locator(".parent-entry")).toHaveCount(0);
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "",
  );
});

test("extends the line-number gutter for short files", async ({ page }, testInfo) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  await expect(page.locator("caffold-code-viewer")).toContainText("Fixture Home");
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

function headerActionGroupButton(page, group) {
  return page.locator(`caffold-header-actions button[data-action-group="${group}"]`);
}

function mockCodexStatus(overrides = {}) {
  return {
    available: true,
    codexCliAvailable: true,
    appServerAvailable: true,
    message: null,
    account: {
      accountType: "chatgpt",
      email: "user@example.com",
      planType: "pro",
    },
    requiresOpenaiAuth: true,
    rateLimits: {
      rateLimitResetCredits: {
        availableCount: 3,
      },
      rateLimits: {
        primary: {
          usedPercent: 83,
          resetsAt: 1914709200,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 31,
          resetsAt: 1915243200,
          windowDurationMins: 10080,
        },
      },
    },
    usage: {
      summary: {
        lifetimeTokens: 1234567,
      },
    },
    appServer: {
      userAgent: "Codex Desktop/0.142.3",
      codexHome: "/Users/example/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
    ...overrides,
  };
}

async function expectHeaderBrand(page) {
  const brand = page.locator("caffold-app-shell .brand");
  const mark = brand.locator(".brand-mark");
  const name = brand.locator(".brand-name");

  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("src", "/assets/icons/caffold-mark.svg");

  const isPhone = await page.evaluate(() => window.matchMedia("(max-width: 520px)").matches);
  if (isPhone) {
    await expect(name).toBeHidden();
  } else {
    await expect(name).toBeVisible();
    await expect(name).toHaveText("Caffold");
  }
}

async function openHeaderActionGroup(page, group) {
  const button = headerActionGroupButton(page, group);
  const popover = page.locator(
    `caffold-header-actions .header-actions-popover[data-action-group="${group}"]`,
  );

  await expect(button).toBeVisible();
  await page.locator("caffold-header-actions").evaluate((element) => {
    element.querySelectorAll(".header-actions-popover").forEach((panel) => {
      panel.hidden = true;
    });
    element.querySelectorAll("button[data-action-group]").forEach((actionButton) => {
      actionButton.setAttribute("aria-expanded", "false");
    });
  });
  await button.click();
  await expect(popover).toBeVisible();

  return popover;
}

async function clickHeaderAction(page, group, action) {
  const popover = await openHeaderActionGroup(page, group);
  await popover.locator(`button[data-action="${action}"]`).click();
}

async function expectHeaderActionsFit(page) {
  const metrics = await page.evaluate(() => {
    const box = (element) => {
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const header = document.querySelector("caffold-app-shell .app-header");
    const brand = document.querySelector("caffold-app-shell .brand");
    const project = document.querySelector("caffold-project-switcher .project-switcher-button");
    const git = document.querySelector('caffold-header-actions button[data-action-group="git"]');
    const github = document.querySelector(
      'caffold-header-actions button[data-action-group="github"]',
    );
    const codex = document.querySelector(
      'caffold-header-actions button[data-action-group="codex"]',
    );
    const badge = git?.querySelector(".header-action-badge");

    return {
      viewportWidth: window.innerWidth,
      header: {
        clientWidth: header?.clientWidth ?? 0,
        scrollWidth: header?.scrollWidth ?? 0,
      },
      brand: box(brand),
      project: box(project),
      git: box(git),
      github: box(github),
      codex: box(codex),
      badge: box(badge),
    };
  });

  expect(metrics.header.scrollWidth).toBeLessThanOrEqual(metrics.header.clientWidth + 1);
  expect(metrics.brand.right).toBeLessThanOrEqual(metrics.project.left);
  expect(metrics.project.right).toBeLessThanOrEqual(metrics.git.left);
  expect(metrics.git.right).toBeLessThanOrEqual(metrics.github.left);
  expect(metrics.github.right).toBeLessThanOrEqual(metrics.codex.left);
  expect(metrics.codex.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.git.width).toBeGreaterThanOrEqual(30);
  expect(metrics.git.width).toBeLessThanOrEqual(32);
  expect(metrics.github.width).toBeGreaterThanOrEqual(30);
  expect(metrics.github.width).toBeLessThanOrEqual(32);
  expect(metrics.codex.width).toBeGreaterThanOrEqual(30);
  expect(metrics.codex.width).toBeLessThanOrEqual(32);

  if (metrics.badge) {
    expect(metrics.badge.left).toBeGreaterThanOrEqual(metrics.git.left);
    expect(metrics.badge.right).toBeGreaterThan(metrics.git.right);
    expect(metrics.badge.right).toBeLessThanOrEqual(metrics.github.left);
    expect(metrics.badge.bottom).toBeGreaterThan(metrics.git.top);
    expect(metrics.badge.top).toBeLessThanOrEqual(metrics.git.top + 2);
  }
}

async function expectHeaderButtonOpacity(page, group, expected) {
  const opacity = await headerActionGroupButton(page, group).evaluate((button) =>
    Number.parseFloat(window.getComputedStyle(button).opacity),
  );

  expect(opacity).toBeCloseTo(expected, 2);
}

async function expectHeaderPopoverFits(page, group) {
  const metrics = await page.evaluate((actionGroup) => {
    const popover = document.querySelector(
      `caffold-header-actions .header-actions-popover[data-action-group="${actionGroup}"]`,
    );
    const rect = popover.getBoundingClientRect();

    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }, group);

  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.width).toBeGreaterThan(0);
  expect(metrics.height).toBeGreaterThan(0);
}

async function expectHeaderGroupOpenVisualState(page, group) {
  const metrics = await page.evaluate((actionGroup) => {
    const button = document.querySelector(
      `caffold-header-actions button[data-action-group="${actionGroup}"]`,
    );
    const popover = document.querySelector(
      `caffold-header-actions .header-actions-popover[data-action-group="${actionGroup}"]`,
    );
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const buttonStyle = window.getComputedStyle(button);
    const arrowStyle = window.getComputedStyle(popover, "::before");
    const arrowLeft = Number.parseFloat(arrowStyle.left);
    const arrowTop = Number.parseFloat(arrowStyle.top);
    const arrowWidth = Number.parseFloat(arrowStyle.width);
    const arrowVisualTop =
      popoverRect.top + arrowTop + arrowWidth / 2 - (Math.SQRT2 * arrowWidth) / 2;

    return {
      arrowCenter: popoverRect.left + arrowLeft + arrowWidth / 2,
      arrowContent: arrowStyle.content,
      arrowDisplay: arrowStyle.display,
      arrowHeight: arrowStyle.height,
      arrowWidth: arrowStyle.width,
      buttonBackground: buttonStyle.backgroundColor,
      buttonBottom: buttonRect.bottom,
      buttonBorderColor: buttonStyle.borderTopColor,
      buttonCenter: buttonRect.left + buttonRect.width / 2,
      buttonToArrowGap: arrowVisualTop - buttonRect.bottom,
      isMobileLayout: window.matchMedia("(max-width: 520px)").matches,
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
      viewportWidth: window.innerWidth,
    };
  }, group);

  expect(metrics.buttonBackground).toBe("rgb(237, 244, 239)");
  expect(metrics.buttonBorderColor).toBe("rgb(182, 199, 189)");

  if (metrics.isMobileLayout) {
    expect(metrics.arrowDisplay).toBe("none");
    expect(metrics.popoverLeft).toBeGreaterThanOrEqual(7);
    expect(metrics.popoverRight).toBeLessThanOrEqual(metrics.viewportWidth - 7);
    return;
  }

  expect(metrics.arrowContent).toBe('""');
  expect(metrics.arrowWidth).toBe("10px");
  expect(metrics.arrowHeight).toBe("10px");
  expect(Math.abs(metrics.arrowCenter - metrics.buttonCenter)).toBeLessThanOrEqual(4);
  expect(metrics.buttonToArrowGap).toBeGreaterThanOrEqual(-1);
  expect(metrics.buttonToArrowGap).toBeLessThanOrEqual(3);
}

async function mockRegisteredProject(page) {
  const project = {
    id: "prj_route_fixture",
    name: "src",
    rootPath: resolve("tests/fixtures/home/src"),
    relativePath: "src",
    createdMs: 1,
    updatedMs: 1,
    lastOpenedMs: 1,
  };

  await page.route(`/api/projects/${project.id}/open`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(project),
    }),
  );
  await page.route(/\/api\/projects(?:\?|$)/, (route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: [project] }),
    });
  });
  await page.route(/\/api\/project-candidate(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    const inProject = path === project.relativePath || path.startsWith(`${project.relativePath}/`);

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        candidate: inProject
          ? {
              name: project.name,
              rootPath: project.rootPath,
              relativePath: project.relativePath,
              alreadyRegistered: true,
              projectId: project.id,
            }
          : null,
      }),
    });
  });

  return project;
}

async function expectGlobalScrollLocked(page) {
  const scrollState = await page.evaluate(() => {
    const element = document.scrollingElement;
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflow: window.getComputedStyle(document.body).overflow,
    };
  });

  expect(scrollState.overflow).toBe("hidden");
  expect(scrollState.scrollWidth).toBe(scrollState.clientWidth);
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
  return page.locator("caffold-file-list").evaluate((element) => {
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

async function expectCodeViewerGutterSeparated(page) {
  const metrics = await page.locator("caffold-code-viewer .code-lines").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;

    const container = element.getBoundingClientRect();
    const backdrop = element.querySelector(".code-gutter-backdrop").getBoundingClientRect();
    const lineNumber = element.querySelector(".line-number").getBoundingClientRect();

    return {
      backdropLeft: backdrop.left,
      backdropRight: backdrop.right,
      containerLeft: container.left,
      lineNumberLeft: lineNumber.left,
      lineNumberRight: lineNumber.right,
      scrollLeft: element.scrollLeft,
    };
  });

  expect(metrics.scrollLeft).toBeGreaterThan(0);
  expect(Math.abs(metrics.backdropLeft - metrics.containerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.lineNumberLeft - metrics.containerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.lineNumberRight - metrics.backdropRight)).toBeLessThanOrEqual(1);
}

async function expectMobileBrowserViewerOverlay(page) {
  const metrics = await page.evaluate(() => {
    const appMain = document.querySelector("caffold-app-shell .app-main");
    const header = document.querySelector("caffold-app-shell .app-header");
    const pathbar = document.querySelector("caffold-pathbar");
    const rect = appMain.getBoundingClientRect();
    const style = window.getComputedStyle(appMain);

    return {
      bottom: rect.bottom,
      height: rect.height,
      headerBottom: header.getBoundingClientRect().bottom,
      pathbarBottom: pathbar.getBoundingClientRect().bottom,
      position: style.position,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  expect(metrics.position).toBe("fixed");
  expect(metrics.top).toBeLessThanOrEqual(1);
  expect(metrics.bottom).toBeGreaterThanOrEqual(metrics.viewportHeight - 1);
  expect(metrics.width).toBeGreaterThanOrEqual(metrics.viewportWidth - 1);
  expect(metrics.top).toBeLessThan(metrics.headerBottom);
  expect(metrics.top).toBeLessThan(metrics.pathbarBottom);
}

async function expectMobileViewerCompactHeader(page) {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector("caffold-file-viewer .viewer-panel > header");
    const closeButton = document.querySelector("caffold-file-viewer .viewer-close-button");
    const title = document.querySelector("caffold-file-viewer h2");
    const infoButton = document.querySelector("caffold-file-viewer .viewer-info-button");

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

    return {
      closeButton: box(closeButton),
      header: box(header),
      infoButton: box(infoButton),
      title: box(title),
    };
  });

  expect(metrics.header.height).toBeLessThanOrEqual(42);
  expect(metrics.closeButton.left).toBeGreaterThanOrEqual(metrics.header.left - 1);
  expect(metrics.title.left).toBeGreaterThan(metrics.closeButton.right);
  expect(metrics.infoButton.left).toBeGreaterThan(metrics.title.left);
  for (const box of [metrics.closeButton, metrics.title, metrics.infoButton]) {
    expect(box.top).toBeGreaterThanOrEqual(metrics.header.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(metrics.header.bottom + 1);
  }
}

async function expectMobileReviewDetail(page, { backName, detailSelector, listSelector }) {
  const workspace = page.locator("caffold-review-workspace");

  await expect(workspace).toHaveAttribute("data-mobile-detail", "true");
  await expect(workspace.locator(".review-workspace-header")).toBeHidden();
  await expect(page.locator(listSelector)).toBeHidden();
  await expect(page.locator(detailSelector)).toBeVisible();
  await expect(page.getByRole("button", { name: backName })).toBeVisible();

  const metrics = await page.locator(detailSelector).evaluate((element) => {
    const workspace = document.querySelector("caffold-review-workspace");
    const panel = element.querySelector(".viewer-panel") ?? element;
    const panelRect = panel.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();

    return {
      panelBottom: panelRect.bottom,
      panelTop: panelRect.top,
      workspaceBottom: workspaceRect.bottom,
      workspaceTop: workspaceRect.top,
    };
  });

  expect(metrics.panelTop).toBeLessThanOrEqual(metrics.workspaceTop + 1);
  expect(metrics.panelBottom).toBeGreaterThanOrEqual(metrics.workspaceBottom - 1);
}

async function expectUnifiedDiffRowsShareScrollWidth(page) {
  const scrollState = await page.locator("caffold-diff-viewer .diff-lines").evaluate((element) => {
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

async function expectDiffScrollerFillsViewer(page) {
  const metrics = await page.evaluate(() => {
    const element = [...document.querySelectorAll("caffold-diff-viewer")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const viewer = element.querySelector(".diff-viewer");
    const lines = element.querySelector(".diff-lines");
    const table = element.querySelector(".diff-table");
    const backdrop = element.querySelector(".diff-gutter-backdrop");
    const backdropRect = backdrop.getBoundingClientRect();
    const viewerRect = viewer.getBoundingClientRect();
    const linesRect = lines.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const backdropStyle = window.getComputedStyle(backdrop);

    return {
      backdropBackground: backdropStyle.backgroundColor,
      backdropHeight: backdropRect.height,
      backdropLeft: backdropRect.left,
      linesLeft: linesRect.left,
      linesBottom: linesRect.bottom,
      linesHeight: linesRect.height,
      tableHeight: tableRect.height,
      viewerBottom: viewerRect.bottom,
      viewerHeight: viewerRect.height,
    };
  });

  expect(metrics.linesHeight).toBeGreaterThanOrEqual(metrics.viewerHeight - 1);
  expect(metrics.linesBottom).toBeGreaterThanOrEqual(metrics.viewerBottom - 1);
  expect(metrics.tableHeight).toBeGreaterThanOrEqual(metrics.linesHeight - 1);
  expect(metrics.backdropHeight).toBeGreaterThanOrEqual(metrics.linesHeight - 1);
  expect(metrics.backdropLeft).toBeGreaterThanOrEqual(metrics.linesLeft - 1);
  expect(metrics.backdropBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(metrics.backdropBackground).not.toBe("transparent");
}

async function expectCompareRefControlsFit(page, testInfo, options = {}) {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector("caffold-review-workspace .review-workspace-header");
    const title = document.querySelector("caffold-review-workspace .review-workspace-title");
    const controls = document.querySelector(
      "caffold-review-workspace .review-compare-ref-controls",
    );
    const baseSelect = document.querySelector('select[data-compare-ref="base"]');
    const headSelect = document.querySelector('select[data-compare-ref="head"]');
    const separator = controls.querySelector(".review-compare-ref-separator");
    const subtitle = document.querySelector(
      "caffold-review-workspace .review-workspace-subtitle",
    );
    const titleHeading = document.querySelector(
      "caffold-review-workspace .review-workspace-title h2",
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
