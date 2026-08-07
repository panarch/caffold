import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
} from "../support/task-fixtures.js";
import {
  openHeaderActionGroup,
} from "../support/header-actions.js";
import {
  elementWidth,
  dragHorizontalResizer,
} from "../support/review-layout.js";
import {
  FILES_HOME_URL,
} from "../support/file-browser-fixtures.js";
import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("refreshes Files and Git after external filesystem changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Native watcher smoke runs once on desktop.");

  const suffix = `${process.pid}-${Date.now()}`;
  const repositoryRelativePath = `src/ignored-output/live-repository-${suffix}`;
  const repositoryPath = resolve("tests/fixtures/home", repositoryRelativePath);
  const firstName = `live-${suffix}.txt`;
  const renamedName = `live-${suffix}-renamed.txt`;
  const firstLogicalPath = `${repositoryRelativePath}/${firstName}`;
  const renamedLogicalPath = `${repositoryRelativePath}/${renamedName}`;
  const firstPath = resolve(repositoryPath, firstName);
  const renamedPath = resolve(repositoryPath, renamedName);

  await rm(repositoryPath, { recursive: true, force: true });
  await mkdir(resolve(repositoryPath, "nested"), { recursive: true });
  await writeFile(resolve(repositoryPath, "nested/fixture.txt"), "nested fixture\n");
  execFileSync("git", ["init", "--quiet", repositoryPath]);
  try {
    await page.goto(`/files?cwd=${encodeURIComponent(repositoryRelativePath)}`);
    await page.waitForTimeout(500);

    const nestedPath = `${repositoryRelativePath}/nested`;
    const nestedFixturePath = `${nestedPath}/fixture.txt`;
    await page.locator(`button[data-entry-path="${nestedPath}"]`).click();
    const nestedFixture = page.locator(
      `button[data-entry-path="${nestedFixturePath}"]`,
    );
    await expect(nestedFixture).toBeVisible();
    const fileList = page.locator("caffold-file-list .file-list");
    await fileList.evaluate((element) => {
      element.dataset.liveRefreshProbe = "kept";
    });
    await nestedFixture.evaluate((button) => {
      button.closest("li").liveRefreshProbe = true;
    });
    const resizeHandle = page.locator("caffold-file-browser > .panel-resizer");
    await dragHorizontalResizer(page, resizeHandle, 72);
    const resizedPanelWidth = await elementWidth(page, "caffold-file-list");
    const headerActions = page.locator("caffold-header-actions");
    await headerActions.evaluate((element) => {
      element.dataset.liveRefreshProbe = "kept";
    });

    const initialContent = Array.from(
      { length: 80 },
      (_, index) => `first live line ${index + 1} ${"wide-content-".repeat(16)}`,
    ).join("\n");
    await writeFile(firstPath, `${initialContent}\n`);
    const firstEntry = page.locator(`button[data-entry-path="${firstLogicalPath}"]`);
    await expect(firstEntry).toBeVisible();
    await expect(fileList).toHaveAttribute("data-live-refresh-probe", "kept");
    expect(
      await nestedFixture.evaluate(
        (button) => button.closest("li").liveRefreshProbe === true,
      ),
    ).toBe(true);
    await expect(headerActions).toHaveAttribute(
      "data-live-refresh-probe",
      "kept",
    );
    await expect(page.locator(`button[data-entry-path="${nestedFixturePath}"]`)).toBeVisible();
    expect(await elementWidth(page, "caffold-file-list")).toBeCloseTo(resizedPanelWidth, 0);
    await firstEntry.click();
    await expect(page.locator("caffold-code-viewer")).toContainText("first live line 80");

    const codeScroller = page.locator("caffold-code-viewer .code-lines");
    const beforeScroll = await codeScroller.evaluate((element) => {
      element.scrollTop = 180;
      element.scrollLeft = 240;
      return { top: element.scrollTop, left: element.scrollLeft };
    });
    expect(beforeScroll.top).toBeGreaterThan(0);
    expect(beforeScroll.left).toBeGreaterThan(0);

    await writeFile(firstPath, `${initialContent}\nsecond live line\n`);
    await expect(page.locator("caffold-code-viewer")).toContainText("second live line");
    const afterScroll = await codeScroller.evaluate((element) => ({
      top: element.scrollTop,
      left: element.scrollLeft,
    }));
    expect(afterScroll.top).toBeGreaterThanOrEqual(beforeScroll.top - 2);
    expect(afterScroll.left).toBeGreaterThanOrEqual(beforeScroll.left - 2);

    await rename(firstPath, renamedPath);
    await expect(page.locator(`button[data-entry-path="${renamedLogicalPath}"]`)).toBeVisible();
    await expect(page.locator("caffold-file-viewer")).toContainText("path was not found");

    const renamedEntry = page.locator(`button[data-entry-path="${renamedLogicalPath}"]`);
    await renamedEntry.click();
    await expect(page.locator("caffold-code-viewer")).toContainText("second live line");

    const gitPopover = await openHeaderActionGroup(page, "git");
    await gitPopover.locator('button[data-action="open-diff-workspace"]').click();
    const diffEntry = page.locator(`button[data-change-path="${renamedLogicalPath}"]`);
    await expect(diffEntry).toBeVisible();
    await diffEntry.click();
    await expect(page.locator("caffold-diff-viewer")).toContainText("second live line");
    const workspace = page.locator("caffold-review-workspace");
    await workspace.evaluate((element) => {
      element.dataset.liveRefreshProbe = "kept";
    });

    await writeFile(renamedPath, "first live line\nsecond live line\nthird live line\n");
    await expect(page.locator("caffold-diff-viewer")).toContainText("third live line");
    await expect(workspace).toHaveAttribute("data-live-refresh-probe", "kept");

    await rm(renamedPath, { force: true });
    await expect(diffEntry).toHaveCount(0);
    await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toContainText(
      "This file no longer has uncommitted changes.",
    );
  } finally {
    await page.goto(FILES_HOME_URL);
    await page.waitForTimeout(100);
    await rm(repositoryPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("keeps Files stable during a large ignored watcher batch", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Native watcher stress runs once on desktop.");

  const relativeRoot = "tests/fixtures/home/src";
  const probePath = resolve(
    relativeRoot,
    `ignored-output/watch-storm-${process.pid}-${Date.now()}`,
  );
  let listRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      listRequests += 1;
    }
  });

  await rm(probePath, { recursive: true, force: true });
  try {
    await page.goto(`/files?cwd=${encodeURIComponent(relativeRoot)}`);
    await page.waitForTimeout(500);
    const panel = page.locator("caffold-file-list .file-list-panel");
    await panel.evaluate((element) => {
      element.dataset.ignoredStormProbe = "kept";
    });
    const requestsBeforeStorm = listRequests;

    await mkdir(probePath, { recursive: true });
    await Promise.all(
      Array.from({ length: 160 }, (_, index) =>
        writeFile(resolve(probePath, `event-${index}.txt`), "ignored watcher event\n"),
      ),
    );
    await page.waitForTimeout(1_750);

    expect(listRequests).toBe(requestsBeforeStorm);
    await expect(panel).toHaveAttribute("data-ignored-storm-probe", "kept");
  } finally {
    await rm(probePath, { recursive: true, force: true });
  }
});

test("keeps manual Files refresh available when live updates fail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Watcher fallback visual runs once on desktop.");
  let listRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      listRequests += 1;
    }
  });
  await page.route(/\/api\/watch(?:\?|$)/, (route) => route.abort("failed"));

  await page.goto(FILES_HOME_URL);
  const refresh = page.getByRole("button", {
    name: "Live updates unavailable. Refresh manually.",
  });
  await expect(refresh).toBeVisible();
  const beforeRefresh = listRequests;
  await refresh.click();
  await expect.poll(() => listRequests).toBeGreaterThan(beforeRefresh);
  await captureReviewScreenshot(page, testInfo, "files-live-updates-unavailable");
});

test("invalidates the browser cache when an open image changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Native image refresh smoke runs once.");
  const name = `live-image-${process.pid}.svg`;
  const path = resolve("tests/fixtures/home", name);
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${fill}"/></svg>`;

  await rm(path, { force: true });
  try {
    await page.goto(FILES_HOME_URL);
    await page.waitForTimeout(500);
    await writeFile(path, svg("#0b7a5f"));
    const entry = page.locator(`button[data-entry-path="${name}"]`);
    await expect(entry).toBeVisible();
    await entry.click();
    const image = page.locator("caffold-file-viewer .image-preview");
    await expect(image).toBeVisible();
    const firstSource = await image.getAttribute("src");

    await writeFile(path, svg("#1f2a24"));
    await expect.poll(() => image.getAttribute("src")).not.toBe(firstSource);
  } finally {
    await rm(path, { force: true });
  }
});
