import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  openCompletedTaskForReview,
  selectTaskReviewScope,
} from "../support/task-review-test.js";
import {
  activeWatchSubscriptionId,
  isWatchSubscriptionClosed,
  scrollTop,
} from "../support/task-fixtures.js";

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
  });
  await expect(conversation).toBeHidden();
  await expect
    .poll(() => activeWatchSubscriptionId(page))
    .not.toBeNull();
  const reviewWatchSubscriptionId = await activeWatchSubscriptionId(page);

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
      isWatchSubscriptionClosed(page, reviewWatchSubscriptionId),
    )
    .toBe(true);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(review).toHaveAttribute("data-persist-probe", "kept");
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
    await taskReview.evaluate((review) => review.updateRoute({ navigator: "files" }));
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

test("reads Branch again when it is chosen after Review reopens on Working Tree", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page, {
      configureReview(review) {
        review.cleanBranch = true;
      },
    });
  await selectTaskReviewScope(tasksPage, "branch");
  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(compareTree).toContainText("No changes compared with origin/main.");
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);

  reviewScenario.cleanBranch = false;
  const statusBefore = reviewScenario.gitStatusRequests;
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect.poll(() => reviewScenario.gitStatusRequests).toBe(statusBefore + 1);

  const comparesBefore = reviewScenario.gitCompareRequests;
  await selectTaskReviewScope(tasksPage, "branch");
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toBeVisible();
  expect(reviewScenario.gitCompareRequests).toBe(comparesBefore + 1);
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

  const scopeControl = tasksPage.locator(
    'caffold-segmented-control[data-detail-view-switch] '
      + 'button[data-segmented-value="working"]',
  );
  const navigatorControl = taskReview.locator(
    'caffold-segmented-control[data-review-axis="navigator"] '
      + 'button[data-segmented-value="files"]',
  );
  const viewerControl = taskReview.locator(
    'caffold-segmented-control[data-review-axis="viewer"] '
      + 'button[data-segmented-value="diff"]',
  );
  for (const control of [scopeControl, navigatorControl, viewerControl]) {
    await control.evaluate((button) => {
      button.stableControlProbe = true;
    });
  }
  await viewerControl.focus();

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

  const kept = (control) =>
    control.evaluate((button) => button.stableControlProbe === true);
  expect({
    scope: await kept(scopeControl),
    navigator: await kept(navigatorControl),
    viewer: await kept(viewerControl),
  }).toEqual({ scope: true, navigator: true, viewer: true });
  await expect(viewerControl).toBeFocused();
});

test("does not reveal the selected Files entry again during canonical task sync", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await constrainReviewNavigator(taskReview);
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
  let directoryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      directoryRequests += 1;
    }
  });

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await constrainReviewNavigator(taskReview);
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
  const firstResponse = Promise.withResolvers();
  let directoryRequests = 0;
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "src") {
      return route.continue();
    }
    const requestNumber = ++directoryRequests;
    directoryRequested();
    await release;
    const response = await route.fetch();
    await route.fulfill({ response });
    if (requestNumber === 1) firstResponse.resolve();
  });

  try {
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await requested;
    await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
    releaseDirectory();
    await firstResponse.promise;

    await expect
      .poll(() =>
        tasksPage.locator("caffold-detail-layout").evaluate((detail, threadId) => {
          const review = detail.reviewComponents.get(`task:${threadId}`);
          return review.fileNavigator.loadedDirectoryPath;
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
  } finally {
    releaseDirectory();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("keeps the first Working Tree loads running through Task updates", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
  const statusRelease = Promise.withResolvers();
  const rootListingRelease = Promise.withResolvers();
  let statusRequests = 0;
  let rootListings = 0;
  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    statusRequests += 1;
    await statusRelease.promise;
    await route.fallback();
  });
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("path") !== "src") {
      return route.continue();
    }
    rootListings += 1;
    await rootListingRelease.promise;
    await route.continue();
  });

  try {
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await expect.poll(() => statusRequests).toBe(1);
    await expect.poll(() => rootListings).toBe(1);
    const loadingChanges = taskReview.locator(
      "caffold-git-diff-changes-tree caffold-loading-text",
    );
    await expect(loadingChanges).toHaveText("Loading changes...");
    await loadingChanges.evaluate((element) => {
      element.dataset.firstLoadProbe = "kept";
    });

    await emitTaskSyncAndAwaitSnapshot(page, taskScenario, 20, "Command started");
    await emitTaskSyncAndAwaitSnapshot(page, taskScenario, 21, "Command finished");
    await expect(loadingChanges).toHaveAttribute("data-first-load-probe", "kept");

    statusRelease.resolve();
    rootListingRelease.resolve();
    await expect(
      taskReview.locator(
        'caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]',
      ),
    ).toBeVisible();
    await expect
      .poll(() =>
        taskReview.evaluate((review) => review.fileNavigator.loadedDirectoryPath),
      )
      .toBe("src");
    // Only the newest request's answer is accepted, so every earlier request
    // has reached its route handler by now.
    expect(statusRequests).toBe(1);
    expect(rootListings).toBe(1);
  } finally {
    statusRelease.resolve();
    rootListingRelease.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("keeps the first Branch loads running through Task updates", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(
    taskReview.locator(
      'caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]',
    ),
  ).toBeVisible();
  const refsRelease = Promise.withResolvers();
  let refsRequests = 0;
  await page.route(/\/api\/git\/refs(?:\?|$)/, async (route) => {
    refsRequests += 1;
    await refsRelease.promise;
    await route.fallback();
  });
  const compareBefore = reviewScenario.gitCompareRequests;

  try {
    await selectTaskReviewScope(tasksPage, "branch");
    await expect.poll(() => refsRequests).toBe(1);

    await emitTaskSyncAndAwaitSnapshot(page, taskScenario, 20, "Command started");
    await emitTaskSyncAndAwaitSnapshot(page, taskScenario, 21, "Command finished");

    refsRelease.resolve();
    await expect(
      taskReview.locator('caffold-git-compare-tree button[data-file-tree-path="src/planner.rs"]'),
    ).toBeVisible();
    // Only the newest request's answer is accepted, so every earlier request
    // has reached its route handler by now.
    expect(refsRequests).toBe(1);
    expect(reviewScenario.gitCompareRequests - compareBefore).toBe(1);
  } finally {
    refsRelease.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

// The navigator panes sit in the Review's shadow root, which a document style
// does not reach.
async function constrainReviewNavigator(taskReview) {
  await taskReview.evaluate((review) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .task-review-navigator-pane,
      .task-review-navigator {
        height: 180px !important;
      }
    `);
    review.shadowRoot.adoptedStyleSheets = [
      ...review.shadowRoot.adoptedStyleSheets,
      sheet,
    ];
  });
}

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

// Resolves once Detail has published the update, which is when it hands the
// Review its context again. The Detail layout stops the event, so this listens
// while it is captured; the layout handles it before the promise settles.
async function emitTaskSyncAndAwaitSnapshot(page, taskScenario, revision, summary) {
  await page.evaluate((expectedSummary) => {
    window.__reviewTaskSnapshot = new Promise((resolve) => {
      window.addEventListener(
        "caffold:task-subject-snapshot",
        function listener(event) {
          if (event.detail?.task?.lastEventSummary === expectedSummary) {
            window.removeEventListener("caffold:task-subject-snapshot", listener, true);
            resolve();
          }
        },
        true,
      );
    });
  }, summary);
  await emitTaskSync(page, taskScenario, revision, summary);
  await page.evaluate(() => window.__reviewTaskSnapshot);
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
