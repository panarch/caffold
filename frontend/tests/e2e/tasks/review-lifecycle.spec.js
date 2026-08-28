import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  openCompletedTaskForReview,
  selectTaskReviewScope,
} from "../support/task-review-test.js";
import { scrollTop } from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("preserves conversation and thread-local Review state while lifecycles deactivate", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { taskScenario, tasksPage } = await openCompletedTaskForReview(page);
  const conversation = tasksPage.locator(".task-conversation-pane");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  await conversation.evaluate((element) => element.setAttribute("data-persist-probe", "kept"));
  const conversationScroll = await conversationScroller.evaluate(async (element) => {
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(max / 2);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return element.scrollTop;
  });

  const textarea = tasksPage.locator('.task-follow-up-form textarea[name="prompt"]');
  await textarea.fill("Keep this draft while reviewing");
  const detailReadsBeforeReview = taskScenario.taskDetailReadRequests;

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const review = tasksPage.locator("caffold-task-review");
  await expect(review).toBeVisible();
  await review.evaluate((element) => {
    element.setAttribute("data-persist-probe", "kept");
    element.panelWidth = 360;
    element.resizer().setValue(360);
    element.applyPanelWidth();
  });
  await expect(conversation).toBeHidden();
  await expect
    .poll(() =>
      review.evaluate((element) => Boolean(element.watchUnsubscribe)),
    )
    .toBe(true);

  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect(conversation).toBeVisible();
  await expect(conversation).toHaveAttribute("data-persist-probe", "kept");
  await expect(textarea).toHaveValue("Keep this draft while reviewing");
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationScroll,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(taskScenario.taskDetailReadRequests).toBe(detailReadsBeforeReview);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__caffoldMockEventSources.filter(
            (source) => source.url.startsWith("/api/watch?") && source.readyState !== 2,
          ).length,
      ),
    )
    .toBe(0);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(review).toHaveAttribute("data-persist-probe", "kept");
  await expect
    .poll(() =>
      review.evaluate((element) => Math.round(element.panelWidth)),
    )
    .toBe(360);
});

test("reopens the selected Review scope at its last semantic route", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]')
    .click();
  await selectTaskReviewScope(tasksPage, "branch");
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  if (testInfo.project.name === "phone") {
    await taskReview.evaluate((review) => review.updateAxis("navigator", "files"));
  } else {
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  }
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&nav=files&view=source&file=planner.rs&base=origin%2Fmain`,
  );

  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);

  await tasksPage.locator(
    'caffold-segmented-control[data-detail-view-switch] button[data-segmented-value="branch"]',
  ).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&nav=files&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(
    taskReview.locator('caffold-file-navigator button[data-file-tree-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
});

test("keeps the selected Review viewer mounted during canonical task sync", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]')
    .click();
  const visibleDiff = taskReview.locator("caffold-diff-viewer");
  await expect(visibleDiff).toContainText("new planner behavior");
  await visibleDiff.evaluate((element) => {
    element.dataset.canonicalSyncProbe = "kept";
  });

  await emitTaskSync(page, taskScenario, 20, "Command started");

  await expect(visibleDiff).toHaveAttribute("data-canonical-sync-probe", "kept");
  await expect(visibleDiff).toContainText("new planner behavior");
  await expect(taskReview.locator(".surface-message")).toHaveCount(0);
});

test("keeps Task view and pane controls mounted and focused through live updates", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]')
    .click();

  await tasksPage.evaluate((tasks) => {
    tasks.querySelector(
      'caffold-segmented-control[data-detail-view-switch] '
        + 'button[data-segmented-value="working"]',
    ).stableControlProbe = true;
    const review = tasks.querySelector("caffold-task-review");
    review.querySelector(
      'caffold-segmented-control[data-review-axis="navigator"] '
        + 'button[data-segmented-value="files"]',
    ).stableControlProbe = true;
    const viewerControl = review.querySelector(
      'caffold-segmented-control[data-review-axis="viewer"] '
        + 'button[data-segmented-value="diff"]',
    );
    viewerControl.stableControlProbe = true;
    viewerControl.focus();
  });

  const requestsBefore = reviewScenario.gitStatusRequests;
  reviewScenario.includeLiveFile = true;
  await emitWatchChange(page, {
    revision: 7,
    paths: ["src/live-update.rs"],
    gitStatusChanged: true,
    gitRefsChanged: false,
    overflow: false,
  });
  await expect.poll(() => reviewScenario.gitStatusRequests).toBeGreaterThan(requestsBefore);

  expect(
    await tasksPage.evaluate((tasks) => {
      const scope = tasks.querySelector(
        'caffold-segmented-control[data-detail-view-switch] '
          + 'button[data-segmented-value="working"]',
      );
      const review = tasks.querySelector("caffold-task-review");
      const navigator = review.querySelector(
        'caffold-segmented-control[data-review-axis="navigator"] '
          + 'button[data-segmented-value="files"]',
      );
      const viewer = review.querySelector(
        'caffold-segmented-control[data-review-axis="viewer"] '
          + 'button[data-segmented-value="diff"]',
      );
      return {
        scope: scope.stableControlProbe === true,
        navigator: navigator.stableControlProbe === true,
        viewer: viewer.stableControlProbe === true,
        viewerFocused: document.activeElement === viewer,
      };
    }),
  ).toEqual({
    scope: true,
    navigator: true,
    viewer: true,
    viewerFocused: true,
  });
});

test("does not reveal the selected Files entry again during canonical task sync", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await page.addStyleTag({
    content: `
      caffold-task-review .task-review-navigator-pane,
      caffold-task-review .task-review-navigator {
        height: 180px !important;
      }
    `,
  });

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  const fileList = taskReview.locator("caffold-file-navigator .file-tree-scroll");
  const selected = fileList.locator('button[data-file-tree-path="src/alpha.rs"]');
  await selected.click();
  await expect(selected).toHaveAttribute("aria-current", "true");

  const fileScroll = await scrollAwayFromTop(fileList);
  expect(fileScroll).toBeGreaterThan(0);
  expect(
    await selected.evaluate((button) => {
      const scroller = button.closest(".file-tree-scroll");
      return button.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
    }),
  ).toBe(true);

  await emitTaskSync(page, taskScenario, 20, "Unrelated command progress");
  await expectScrollUnchanged(fileList, fileScroll);
});

test("keeps both Review navigator scroll positions during unrelated live updates", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page, {
      configureReview(review) {
        review.largeChangeSet = true;
      },
    });
  await page.addStyleTag({
    content: `
      caffold-task-review .task-review-navigator-pane,
      caffold-task-review .task-review-navigator {
        height: 180px !important;
      }
    `,
  });
  let directoryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      directoryRequests += 1;
    }
  });

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const changesList = taskReview.locator("caffold-git-diff-changes-tree .file-tree-scroll");
  await expect(
    taskReview.locator('caffold-git-diff-changes-tree button[data-file-tree-kind="file"]'),
  ).toHaveCount(184);

  // Populate both route-state slots at their initial position before the user scrolls.
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    taskReview.locator('caffold-file-navigator button[data-file-tree-path="src/alpha.rs"]'),
  ).toBeVisible();
  await taskReview.getByRole("button", { name: "Changes", exact: true }).click();

  const changesScroll = await scrollAwayFromTop(changesList);
  expect(changesScroll).toBeGreaterThan(0);
  await emitTaskSync(page, taskScenario, 20, "Unrelated command progress");
  await expectScrollUnchanged(changesList, changesScroll);

  const statusRequests = reviewScenario.gitStatusRequests;
  reviewScenario.includeLiveFile = true;
  await emitWatchChange(page, {
    revision: 4,
    paths: ["src/live-update.rs"],
    gitStatusChanged: true,
    gitRefsChanged: false,
    overflow: false,
  });
  await expect.poll(() => reviewScenario.gitStatusRequests).toBeGreaterThan(statusRequests);
  await expectScrollUnchanged(changesList, changesScroll);

  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  const fileList = taskReview.locator("caffold-file-navigator .file-tree-scroll");
  let injectVisibleDirectoryChange = false;
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    if (!injectVisibleDirectoryChange) {
      return route.continue();
    }
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "src") {
      return route.continue();
    }
    const response = await route.fetch();
    const directory = await response.json();
    directory.entries = [
      {
        name: "00-live.rs",
        path: "src/00-live.rs",
        kind: "file",
        isSymlink: false,
        supported: true,
        gitIgnored: false,
        size: 12,
        modifiedMs: 1_767_000_123_000,
        git: null,
      },
      ...directory.entries,
    ];
    return route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify(directory),
    });
  });
  const fileScroll = await scrollAwayFromTop(fileList);
  expect(fileScroll).toBeGreaterThan(0);
  await fileList.evaluate((element) => {
    element.dataset.stableRefreshProbe = "kept";
  });
  await emitTaskSync(page, taskScenario, 21, "Another unrelated command update");
  await expectScrollUnchanged(fileList, fileScroll);

  const previousDirectoryRequests = directoryRequests;
  await emitWatchChange(page, {
    revision: 5,
    paths: ["src/alpha.rs"],
    gitStatusChanged: false,
    gitRefsChanged: false,
    overflow: false,
  });
  await expect.poll(() => directoryRequests).toBeGreaterThan(previousDirectoryRequests);
  await expect(fileList).toHaveAttribute("data-stable-refresh-probe", "kept");
  await expectScrollUnchanged(fileList, fileScroll);

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("caffold:icons-ready"));
  });
  await expectScrollUnchanged(fileList, fileScroll);

  const visibleAnchor = await captureVisibleAnchor(fileList);
  await fileList
    .locator(`button[data-file-tree-path="${visibleAnchor.path}"]`)
    .evaluate((button) => {
      button.closest("li").stableRefreshProbe = true;
    });
  injectVisibleDirectoryChange = true;
  const requestsBeforeVisibleChange = directoryRequests;
  await emitWatchChange(page, {
    revision: 6,
    paths: ["src/00-live.rs"],
    gitStatusChanged: false,
    gitRefsChanged: false,
    overflow: false,
  });
  await expect
    .poll(() => directoryRequests)
    .toBeGreaterThan(requestsBeforeVisibleChange);
  await expect(fileList.locator('button[data-file-tree-path="src/00-live.rs"]')).toBeVisible();
  await expect(fileList).toHaveAttribute("data-stable-refresh-probe", "kept");
  expect(
    await fileList
      .locator(`button[data-file-tree-path="${visibleAnchor.path}"]`)
      .evaluate((button) => button.closest("li").stableRefreshProbe === true),
  ).toBe(true);
  const visibleAnchorAfterChange = await captureVisibleAnchor(fileList);
  expect(visibleAnchorAfterChange.path).toBe(visibleAnchor.path);
  expect(Math.abs(visibleAnchorAfterChange.offset - visibleAnchor.offset)).toBeLessThanOrEqual(2);

  const fileScrollAfterChange = await scrollTop(fileList);
  await taskReview.getByRole("button", { name: "Changes", exact: true }).click();
  await expectScrollUnchanged(changesList, changesScroll);
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await expectScrollUnchanged(fileList, fileScrollAfterChange);
});

test("rejects a late file navigator response while Review is inactive", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { taskScenario, tasksPage } = await openCompletedTaskForReview(page);
  let releaseDirectory;
  let directoryRequested;
  const requested = new Promise((resolve) => {
    directoryRequested = resolve;
  });
  const release = new Promise((resolve) => {
    releaseDirectory = resolve;
  });
  let directoryRequests = 0;
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "src") {
      return route.continue();
    }
    directoryRequests += 1;
    directoryRequested();
    await release;
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await requested;
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  releaseDirectory();

  await expect
    .poll(() =>
      tasksPage.evaluate((element, threadId) => {
        const detail = element.querySelector("caffold-detail-layout");
        const review = detail.reviewComponents.get(`task:${threadId}`);
        return review.fileNavigator().loadedDirectoryPath;
      }, taskScenario.threadId),
    )
    .toBe(null);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect
    .poll(() => directoryRequests)
    .toBeGreaterThanOrEqual(2);
  await tasksPage.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    tasksPage.locator(
      'caffold-task-review caffold-file-navigator button[data-file-tree-path="src/alpha.rs"]',
    ),
  ).toBeVisible();
});

async function scrollAwayFromTop(locator) {
  return locator.evaluate(async (element) => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.max(1, Math.floor(max * 0.6));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return element.scrollTop;
  });
}

async function expectScrollUnchanged(locator, expected) {
  await locator.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(Math.abs((await scrollTop(locator)) - expected)).toBeLessThanOrEqual(2);
}

async function captureVisibleAnchor(locator) {
  return locator.evaluate((element) => {
    const scrollerTop = element.getBoundingClientRect().top;
    const anchor = Array.from(element.querySelectorAll("button[data-file-tree-path]")).find(
      (button) => button.getBoundingClientRect().bottom > scrollerTop,
    );
    if (!anchor) {
      throw new Error("No visible file tree anchor");
    }
    return {
      path: anchor.dataset.fileTreePath,
      offset: anchor.getBoundingClientRect().top - scrollerTop,
    };
  });
}

async function emitTaskSync(page, taskScenario, revision, summary) {
  taskScenario.updateTask({ lastEventSummary: summary });
  await page.evaluate(
    ({ detail, threadId, revision }) => {
      const source = window.__caffoldMockEventSources.find(
        (candidate) =>
          candidate.url === `/api/tasks/${threadId}/stream` &&
          candidate.readyState !== 2,
      );
      if (!source) {
        throw new Error(`Task detail stream not found for ${threadId}`);
      }
      source.emit("task-sync", {
        threadId,
        revision,
        reason: "canonical-sync",
        detail,
      });
    },
    {
      threadId: taskScenario.threadId,
      revision,
      detail: taskScenario.detailResponse({ revision }),
    },
  );
}

async function emitWatchChange(page, change) {
  await page.evaluate((payload) => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    if (!source) {
      throw new Error("Active filesystem watch stream not found");
    }
    source.emit("change", payload);
  }, change);
}
