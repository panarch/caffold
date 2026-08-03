import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { installTaskReviewFixture } from "../support/task-review-fixture.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps Files and Diff review state isolated from the conversation", async ({
  page,
}, testInfo) => {
  const reviewScenario = await installTaskReviewFixture(page);
  const scenario = await installTaskLoopFixture(page);
  const { threadId } = scenario;
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const codexWorkspace = page.locator("caffold-codex-workspace");
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  const conversationBeforeFiles = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeFiles.maxScrollTop).toBeGreaterThan(0);
  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-persist-probe", "kept"));
  const taskReview = tasksPage.locator("caffold-task-review");
  await taskReview.evaluate((element) =>
    element.setAttribute("data-persist-probe", "kept"),
  );
  const taskMasterStateBeforeTools =
    testInfo.project.name === "desktop"
      ? await tasksPage.evaluate((element) => {
          const separator = element.querySelector(".tasks-master-resizer");
          separator.focus();
          separator.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
          );
          const listScroll = element.querySelector(".task-list-scroll");
          const listRegion = element.querySelector(".tasks-list-region");
          listScroll.style.height = "90px";
          listRegion.style.minHeight = "240px";
          listScroll.scrollTop = 40;
          return {
            listWidth: Math.round(
              element.querySelector(".tasks-list-pane").getBoundingClientRect().width,
            ),
            listScrollTop: listScroll.scrollTop,
          };
        })
      : null;

  await tasksPage.locator('button[data-summary-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFilesView = tasksPage.locator(".task-files-view");
  await expect(taskFilesView).toBeVisible();
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            browser.watchActive && Boolean(browser.watchUnsubscribe),
        ),
    )
    .toBe(true);
  await expect(tasksPage.locator(".tasks-header")).toBeHidden();
  await expect(tasksPage.locator(".task-detail-summary")).toBeHidden();
  await expect(tasksPage.locator(".tasks-list-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-master-resizer")).toBeHidden();
  const taskFilesLayout = await page.evaluate(() => {
    const codex = document.querySelector("caffold-codex-workspace");
    const appHeader = document.querySelector("caffold-app-shell .app-header");
    const pathbar = document.querySelector("caffold-pathbar");
    const filesHeader = document.querySelector(".task-files-header");
    const filesView = document.querySelector(".task-files-view");
    const filesTitle = document.querySelector(".task-files-header h3");
    const browser = document.querySelector(".task-files-view caffold-file-browser");
    const fileList = document.querySelector(".task-files-view caffold-file-list");

    const coveredByCodex = (element) => {
      const rect = element.getBoundingClientRect();
      const topElement = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        inCodex: Boolean(topElement?.closest("caffold-codex-workspace")),
        inSelf: topElement === element || element.contains(topElement),
      };
    };

    const codexRect = codex.getBoundingClientRect();
    const filesHeaderRect = filesHeader.getBoundingClientRect();
    const filesViewRect = filesView.getBoundingClientRect();
    const browserRect = browser.getBoundingClientRect();
    const fileListRect = fileList.getBoundingClientRect();

    return {
      viewportWidth: window.innerWidth,
      appHeaderCoveredByCodex:
        coveredByCodex(appHeader).inCodex && !coveredByCodex(appHeader).inSelf,
      pathbarCoveredByCodex:
        coveredByCodex(pathbar).inCodex && !coveredByCodex(pathbar).inSelf,
      filesHeaderTop: filesHeaderRect.top,
      codexTop: codexRect.top,
      filesViewLeft: filesViewRect.left,
      codexLeft: codexRect.left,
      filesViewRight: filesViewRect.right,
      codexRight: codexRect.right,
      filesViewBottom: filesViewRect.bottom,
      codexBottom: codexRect.bottom,
      browserHeight: browserRect.height,
      fileListWidth: fileListRect.width,
      titleFits: filesTitle.clientWidth >= filesTitle.scrollWidth,
    };
  });
  expect(taskFilesLayout.appHeaderCoveredByCodex).toBe(true);
  expect(taskFilesLayout.pathbarCoveredByCodex).toBe(true);
  expect(taskFilesLayout.filesHeaderTop).toBeLessThanOrEqual(taskFilesLayout.codexTop + 1);
  expect(
    Math.abs(taskFilesLayout.filesViewLeft - taskFilesLayout.codexLeft),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(taskFilesLayout.filesViewRight - taskFilesLayout.codexRight),
  ).toBeLessThanOrEqual(1);
  expect(taskFilesLayout.filesViewBottom).toBeGreaterThanOrEqual(taskFilesLayout.codexBottom - 1);
  expect(taskFilesLayout.browserHeight).toBeGreaterThan(400);
  if (taskFilesLayout.viewportWidth >= 861) {
    expect(taskFilesLayout.fileListWidth).toBeGreaterThanOrEqual(300);
  }
  expect(taskFilesLayout.titleFits).toBe(true);
  const filesTitleLeft = await taskFilesView
    .locator(".task-files-header h3")
    .evaluate((element) => element.getBoundingClientRect().left);
  const codexCloseRight = await page
    .locator("caffold-codex-workspace .codex-workspace-close")
    .evaluate((element) => element.getBoundingClientRect().right);
  expect(filesTitleLeft).toBeGreaterThan(codexCloseRight);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect(taskFilesView.locator("caffold-file-browser")).toHaveAttribute(
    "data-browser-view",
    "list",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  const embeddedLiveName = `task-live-${testInfo.project.name}.txt`;
  const embeddedLivePath = resolve("tests/fixtures/home/src", embeddedLiveName);
  try {
    await writeFile(embeddedLivePath, "Codex Files live update\n");
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
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toBeVisible();
  } finally {
    await rm(embeddedLivePath, { force: true });
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
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toHaveCount(0);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser-list");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            !browser.watchActive && !browser.watchUnsubscribe,
        ),
    )
    .toBe(true);
  await expect(page.locator("caffold-codex-workspace")).toBeVisible();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator('button[data-summary-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            browser.watchActive && Boolean(browser.watchUnsubscribe),
        ),
    )
    .toBe(true);
  await taskFilesView.locator('button[data-entry-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText(
    "alpha.rs",
  );
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText("pub const ALPHA");
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");
  if (testInfo.project.name === "phone") {
    await taskFilesView.getByRole("button", { name: "Back to files" }).click();
  }
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(taskFilesView).toBeHidden();
  await expect
    .poll(() =>
      taskFilesView
        .locator("caffold-file-browser")
        .evaluate(
          (browser) =>
            !browser.watchActive && !browser.watchUnsubscribe,
        ),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary")).toBeVisible();
  if (taskMasterStateBeforeTools) {
    await expect(tasksPage.locator(".tasks-list-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-master-resizer")).toBeVisible();
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(taskMasterStateBeforeTools.listWidth);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(taskMasterStateBeforeTools.listScrollTop);
  }
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeFiles.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();


  await tasksPage.locator(".task-follow-up-form .task-model-button").click();
  const modelPopover = tasksPage.locator(".task-model-popover");
  await expect(modelPopover).toBeVisible();
  await modelPopover.locator('[data-effort="ultra"]').click();
  const followUpTextarea = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-review-persist-probe", "kept"));
  await followUpTextarea.fill("Keep this draft while reviewing");
  const conversationBeforeDiff = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeDiff.maxScrollTop).toBeGreaterThan(0);
  const taskDetailReadsBeforeDiff = scenario.taskDetailReadRequests;
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  await expect(codexWorkspace).toBeVisible();
  await expect(page.locator("caffold-review-workspace")).toBeHidden();
  const taskDiffView = tasksPage.locator(".task-diff-view");
  await expect(taskDiffView).toBeVisible();
  const contextualControlHeights = await taskDiffView.evaluate((element) => {
    const tokenProbe = document.createElement("div");
    tokenProbe.style.cssText =
      "position:fixed;height:var(--interface-compact-control-size)";
    document.body.append(tokenProbe);
    const compact = tokenProbe.getBoundingClientRect().height;
    tokenProbe.remove();
    return {
      compact,
      modeButtons: [...element.querySelectorAll(".task-diff-mode-switch button")].map(
        (button) => button.getBoundingClientRect().height,
      ),
      refresh: element
        .querySelector('[data-task-review-action="refresh"]')
        .getBoundingClientRect().height,
    };
  });
  for (const height of [
    ...contextualControlHeights.modeButtons,
    contextualControlHeights.refresh,
  ]) {
    expect(height).toBeCloseTo(contextualControlHeights.compact, 1);
  }
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      taskReview.evaluate((review) => Boolean(review.diffWatchUnsubscribe)),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-list-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-master-resizer")).toBeHidden();
  const taskDiffLayout = await tasksPage.evaluate((element) => {
    const pageRect = element.getBoundingClientRect();
    const diffRect = element.querySelector(".task-diff-view").getBoundingClientRect();
    return {
      leftGap: Math.abs(diffRect.left - pageRect.left),
      rightGap: Math.abs(diffRect.right - pageRect.right),
    };
  });
  expect(taskDiffLayout.leftGap).toBeLessThanOrEqual(1);
  expect(taskDiffLayout.rightGap).toBeLessThanOrEqual(1);
  const taskDiffTree = taskDiffView.locator("caffold-git-diff-changes-tree");
  await expect(taskDiffTree.locator("button[data-change-path]")).toHaveCount(4);
  await expect(taskDiffTree.locator('button[data-task-related="true"]')).toHaveCount(3);
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="unrelated.rs"]'),
  ).not.toHaveAttribute("data-task-related", "true");
  await taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  const taskDiffViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
  );
  await expect(taskDiffViewer).toContainText("planner.rs");
  await expect(taskDiffViewer).toContainText(
    "new planner behavior",
  );
  if (testInfo.project.name === "phone") {
    const statusRequestsBeforeViewerRefresh = reviewScenario.gitStatusRequests;
    await taskDiffViewer.locator(".viewer-refresh-button").click();
    await expect
      .poll(() => reviewScenario.gitStatusRequests)
      .toBeGreaterThan(statusRequestsBeforeViewerRefresh);
  }
  const statusRequestsBeforeWatchChange = reviewScenario.gitStatusRequests;
  reviewScenario.includeLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 4,
      paths: ["src/live-update.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect
    .poll(() => reviewScenario.gitStatusRequests)
    .toBeGreaterThan(statusRequestsBeforeWatchChange);
  const liveUpdateChange = taskDiffTree.locator(
    'button[data-repo-relative-path="live-update.rs"]',
  );
  await expect(liveUpdateChange).toHaveCount(1);
  if (testInfo.project.name === "phone") {
    await expect(liveUpdateChange).toBeHidden();
  } else {
    await expect(liveUpdateChange).toBeVisible();
  }
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");

  const refsBeforeBranch = reviewScenario.gitRefsRequests;
  const compareBeforeBranch = reviewScenario.gitCompareRequests;
  await taskDiffView.getByRole("button", { name: "Branch" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "branch");
  await expect.poll(() => reviewScenario.gitRefsRequests).toBeGreaterThan(refsBeforeBranch);
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(compareBeforeBranch);
  await expect(taskDiffView.locator("select[data-task-compare-base]")).toHaveValue(
    "origin/main",
  );
  await expect(taskDiffView.locator("[data-task-compare-head]")).toHaveText("main");
  const taskCompareTree = taskDiffView.locator("caffold-git-compare-tree");
  const taskCompareFile = taskCompareTree.locator(
    'button[data-compare-path="src/planner.rs"]',
  );
  await expect(taskCompareFile).toBeVisible();
  await taskCompareFile.click();
  await expect.poll(() => reviewScenario.gitCompareDiffRequests).toBeGreaterThan(0);
  const taskCompareViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="branch"] caffold-review-file-viewer',
  );
  await expect(taskCompareViewer).toContainText("new branch behavior");
  await taskDiffView.locator("select[data-task-compare-base]").selectOption("origin/release");
  await expect(taskCompareTree.locator('button[data-compare-path="src/release.rs"]')).toBeVisible();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");

  await taskDiffView.getByRole("button", { name: "Working Tree" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "working");
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");

  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-review-persist-probe",
    "kept",
  );
  await expect(taskReview).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      taskReview.evaluate((review) => !review.diffWatchUnsubscribe),
    )
    .toBe(true);
  await expect(followUpTextarea).toHaveValue("Keep this draft while reviewing");
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Ultra",
  );

  if (taskMasterStateBeforeTools) {
    await expect(tasksPage.locator(".tasks-list-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-master-resizer")).toBeVisible();
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(taskMasterStateBeforeTools.listWidth);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(taskMasterStateBeforeTools.listScrollTop);
  }
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeDiff.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(scenario.taskDetailReadRequests).toBe(taskDetailReadsBeforeDiff);

});
