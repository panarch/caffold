import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";
import {
  headerActionGroupButton,
} from "../support/header-actions.js";
import {
  expectGlobalScrollLocked,
  expectPanelScrollContainers,
} from "../support/review-layout.js";
import {
  LAST_DIRECTORY_KEY,
  FILES_HOME_URL,
} from "../support/file-browser-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("delays file list loading feedback", async ({ page }) => {
  const startTime = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: startTime });
  await page.clock.pauseAt(startTime);
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

  await page.goto(FILES_HOME_URL);
  await listRequested;

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await page.clock.fastForward(179);
  await expect(page.getByText("Loading files...")).toHaveCount(0);

  await page.clock.fastForward(1);
  await expect(page.getByText("Loading files...")).toBeVisible();

  releaseListResponse();
  await expect(page.locator("caffold-file-list")).toContainText("src");
});

test("keeps the selected source header stable while file content loads", async ({
  page,
}) => {
  let signalFileRequest;
  let releaseFileResponse;
  const fileRequested = new Promise((resolve) => {
    signalFileRequest = resolve;
  });
  const fileReleased = new Promise((resolve) => {
    releaseFileResponse = resolve;
  });

  await page.route(/\/api\/file(?:\?|$)/, async (route) => {
    signalFileRequest();
    await fileReleased;
    await route.continue();
  });

  await page.goto(FILES_HOME_URL);
  await page.locator('button[data-entry-path="src"]').click();
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await fileRequested;

  const viewer = page.locator("caffold-file-viewer");
  await expect(viewer.locator(".surface-message")).toHaveText("Loading file...");
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("example.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveCount(0);

  releaseFileResponse();
  await expect(viewer.locator("caffold-code-viewer")).toContainText("pub fn sample");
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("example.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveCount(0);
});

test("browses directories and opens a source file", async ({ page }, testInfo) => {
  await page.goto(FILES_HOME_URL);

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
  await expect(page.getByRole("button", { name: "Refresh files" })).toBeVisible();

  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.getByText("Loading file...")).toHaveCount(0);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");
  await expect(page.locator("caffold-code-viewer")).not.toContainText("Highlighted");
  await expect(page.locator("caffold-code-viewer header")).toHaveCount(0);
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expect(page.getByRole("button", { name: "Refresh file", exact: true })).toBeVisible();
  await expectGlobalScrollLocked(page);
  await expectPanelScrollContainers(page);
  const repositoryPath = "Users/taehoon/Workspace/rust/codger";
  const filePath = `${repositoryPath}/frontend/components/file-viewer.css`;
  await page.locator("caffold-file-viewer").evaluate(
    (viewer, { filePath, repositoryPath }) => {
      viewer.setDiff({
        path: filePath,
        repoRelativePath: "frontend/components/file-viewer.css",
        kind: "unstaged",
        repository: { rootPath: repositoryPath },
        diff: "@@ -1 +1 @@\n-old line\n+new line",
      });
    },
    { filePath, repositoryPath },
  );
  const fileDetailsButton = page.getByRole("button", {
    name: "Show details for frontend/components/file-viewer.css",
  });
  await fileDetailsButton.click();
  const details = page.locator("caffold-file-viewer .viewer-meta-popover");
  await expect(details).toBeVisible();
  const [fileDetailsButtonBox, fileDetailsBox] = await Promise.all([
    fileDetailsButton.boundingBox(),
    details.boundingBox(),
  ]);
  expect(fileDetailsButtonBox).not.toBeNull();
  expect(fileDetailsBox).not.toBeNull();
  expect(fileDetailsBox.x).toBeGreaterThanOrEqual(7);
  expect(fileDetailsBox.x + fileDetailsBox.width).toBeLessThanOrEqual(
    page.viewportSize().width - 7,
  );
  expect(fileDetailsBox.y).toBeGreaterThanOrEqual(
    fileDetailsButtonBox.y + fileDetailsButtonBox.height + 4,
  );
  expect(fileDetailsButtonBox.x + fileDetailsButtonBox.width / 2).toBeGreaterThanOrEqual(
    fileDetailsBox.x - 1,
  );
  expect(fileDetailsButtonBox.x + fileDetailsButtonBox.width / 2).toBeLessThanOrEqual(
    fileDetailsBox.x + fileDetailsBox.width + 1,
  );
  await expect(details.locator('[data-field="path"] dd')).toHaveText(filePath);
  await expect(details.locator('[data-field="repository"] dd')).toHaveText(repositoryPath);
  await expect(details.locator('[data-field="kind"] dd')).toHaveText("unstaged");
  if (testInfo.project.name !== "phone") {
    const metadataLayout = await details.evaluate((popover) => {
      const lineCount = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].filter(({ width, height }) => width > 0 && height > 0)
          .length;
      };
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      return {
        maxWidth: Math.min(42 * rootFontSize, innerWidth - 1.5 * rootFontSize),
        pathLines: lineCount(popover.querySelector('[data-field="path"] dd')),
        repositoryLines: lineCount(
          popover.querySelector('[data-field="repository"] dd'),
        ),
        width: popover.getBoundingClientRect().width,
      };
    });
    expect(metadataLayout.width).toBeLessThan(metadataLayout.maxWidth);
    expect(metadataLayout.pathLines).toBe(1);
    expect(metadataLayout.repositoryLines).toBe(1);
  }
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

test("reveals a selected file through the shared navigator", async ({ page }) => {
  await page.goto(FILES_HOME_URL);
  await expect(page.locator('button[data-entry-path="src"]')).toBeVisible();

  await page.locator("caffold-file-navigator").evaluate(async (navigator) => {
    await navigator.loadDirectory("src");
    await navigator.revealPath("src/planner/mod.rs");
  });

  const entry = page.locator('button[data-entry-path="src/planner/mod.rs"]');
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute("aria-current", "true");
});

test("preserves file route state and header DOM", async ({ page }, testInfo) => {
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

  await page.goto("/files?cwd=src&file=example.rs");
  await expect(page).toHaveURL("/files?cwd=src&file=example.rs");
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");

  await page.reload();
  await expect(page).toHaveURL("/files?cwd=src&file=example.rs");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page).toHaveURL("/files?cwd=src");
    await expect(page.locator("caffold-file-list")).toBeVisible();
  }

  await page.goto("/files?cwd=src");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  const gitGroupButton = headerActionGroupButton(page, "git");
  await expect(gitGroupButton.locator(".header-action-badge")).toHaveText(/\d+/);
  const headerActionsSnapshot = await page.locator("caffold-header-actions").evaluate((element) => {
    const gitGroupButton = element.querySelector('button[data-action-group="git"]');
    window.__caffoldGitGroupButton = gitGroupButton;
    return {
      groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
        (button) => button.dataset.actionGroup,
      ),
      gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
    };
  });
  const listRequestsBeforeFileClick = listRequests;
  const gitStatusRequestsBeforeFileClick = gitStatusRequests;
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page).toHaveURL("/files?cwd=src&file=example.rs");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  expect(listRequests).toBe(listRequestsBeforeFileClick);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeFileClick);
  const headerActionsState = await page.locator("caffold-header-actions").evaluate((element) => {
    const gitGroupButton = element.querySelector('button[data-action-group="git"]');
    return {
      groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
        (button) => button.dataset.actionGroup,
      ),
      gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
      sameGitGroupButton: gitGroupButton === window.__caffoldGitGroupButton,
    };
  });
  expect(headerActionsState.sameGitGroupButton).toBe(true);
  expect(headerActionsState.groups).toEqual(headerActionsSnapshot.groups);
  expect(headerActionsState.gitGroupButtonHtml).toBe(
    headerActionsSnapshot.gitGroupButtonHtml,
  );
  await page.goBack();
  await expect(page).toHaveURL("/files?cwd=src");
  await expect(page.locator("caffold-file-list")).toBeVisible();

  await page.goto("/files?cwd=src%2Fplanner");
  await expect(page).toHaveURL("/files?cwd=src%2Fplanner");
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL("/files?cwd=src");
  await expect(page.locator('button[data-entry-path="src/example.rs"]')).toBeVisible();
});

test("restores standalone file routes and browser navigation", async ({ page }, testInfo) => {
  await page.goto("/files?cwd=src&file=example.rs");
  await expect(page).toHaveURL("/files?cwd=src&file=example.rs");
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");

  await page.reload();
  await expect(page).toHaveURL("/files?cwd=src&file=example.rs");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page).toHaveURL("/files?cwd=src");
    await expect(page.locator("caffold-file-list")).toBeVisible();
    return;
  }

  await page.goto("/files?cwd=src");
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page).toHaveURL("/files?cwd=src&file=example.rs");
  await page.goBack();
  await expect(page).toHaveURL("/files?cwd=src");
  await expect(page.locator("caffold-file-list")).toBeVisible();
});

test("restores the last opened directory after reload", async ({ page }) => {
  await page.goto(FILES_HOME_URL);
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

  await page.goto(FILES_HOME_URL);
  await expect(page.locator("caffold-file-list")).toContainText("src");
  await expect(page.locator(".parent-entry")).toHaveCount(0);
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "",
  );
});
