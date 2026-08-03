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
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expect(page.getByRole("button", { name: "Refresh file", exact: true })).toBeVisible();
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
