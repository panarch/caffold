import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("browses task files without leaving the task or leaking the file watch", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  const filesView = taskReview.locator(".task-files-view");

  await tasksPage.locator('button[data-summary-action="toggle-files"]').click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect(filesView).toBeVisible();
  await expect(filesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  await expect
    .poll(() =>
      filesView
        .locator("caffold-file-browser")
        .evaluate((browser) => browser.watchActive && Boolean(browser.watchUnsubscribe)),
    )
    .toBe(true);

  const liveName = `task-live-${testInfo.project.name}.txt`;
  const livePath = resolve("tests/fixtures/home/src", liveName);
  try {
    await writeFile(livePath, "Codex Files live update\n");
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 2,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${liveName}`);
    await expect(
      filesView.locator(`button[data-entry-path="src/${liveName}"]`),
    ).toBeVisible();
  } finally {
    await rm(livePath, { force: true });
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 3,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${liveName}`);
  }

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser-list");
  await filesView.locator('button[data-entry-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect(filesView.locator("caffold-file-viewer")).toContainText("alpha.rs");
  await expect(filesView.locator("caffold-file-viewer")).toContainText(
    "pub const ALPHA",
  );
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");

  if (testInfo.project.name === "phone") {
    await filesView.getByRole("button", { name: "Back to files" }).click();
  }
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(filesView).toBeHidden();
  await expect
    .poll(() =>
      filesView
        .locator("caffold-file-browser")
        .evaluate((browser) => !browser.watchActive && !browser.watchUnsubscribe),
    )
    .toBe(true);
});

test("keeps the embedded Files surface inside the Codex workspace", async ({
  page,
}) => {
  const { tasksPage } = await openCompletedTaskForReview(page);
  await tasksPage.locator('button[data-summary-action="toggle-files"]').click();

  const layout = await page.evaluate(() => {
    const codex = document.querySelector("caffold-codex-workspace");
    const appMain = document.querySelector("caffold-app-shell .app-main");
    const view = document.querySelector(".task-files-view");
    const browser = view.querySelector("caffold-file-browser");
    const list = view.querySelector("caffold-file-list");
    const title = view.querySelector(".task-files-header h3");
    const codexRect = codex.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      appMainTop: appMain.getBoundingClientRect().top,
      codexTop: codexRect.top,
      viewLeft: viewRect.left,
      viewRight: viewRect.right,
      viewBottom: viewRect.bottom,
      codexLeft: codexRect.left,
      codexRight: codexRect.right,
      codexBottom: codexRect.bottom,
      browserHeight: browser.getBoundingClientRect().height,
      listWidth: list.getBoundingClientRect().width,
      titleFits: title.clientWidth >= title.scrollWidth,
    };
  });

  expect(Math.abs(layout.codexTop - layout.appMainTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.viewLeft - layout.codexLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.viewRight - layout.codexRight)).toBeLessThanOrEqual(1);
  expect(layout.viewBottom).toBeGreaterThanOrEqual(layout.codexBottom - 1);
  expect(layout.browserHeight).toBeGreaterThan(400);
  if (layout.viewportWidth >= 861) {
    expect(layout.listWidth).toBeGreaterThanOrEqual(300);
  }
  expect(layout.titleFits).toBe(true);
});
