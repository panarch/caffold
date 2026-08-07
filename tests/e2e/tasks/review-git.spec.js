import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps the selected Review file identity stable while content loads", async ({
  page,
}) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  reviewScenario.gitDiffDelayMs = 500;
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await changes.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(viewer.locator(".surface-message")).toHaveText("Loading file...");
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("planner.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  await expect(viewer.locator("caffold-diff-viewer")).toContainText(
    "new planner behavior",
  );
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("planner.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );

  await page.route(/\/api\/file(?:\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(viewer.locator(".surface-message")).toHaveText("Loading file...");
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("planner.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveCount(0);
  await expect(viewer.locator("caffold-code-viewer")).toContainText("planner");
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("planner.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveCount(0);
});

test("reviews working tree changes through the canonical Review route", async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await expect(page.locator("caffold-review-workspace")).toBeHidden();

  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(taskReview).toBeVisible();
  await expect(changes.locator("button[data-change-path]")).toHaveCount(4);
  await expect(changes.locator('button[data-task-related="true"]')).toHaveCount(3);

  await changes.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?file=planner.rs`,
  );
  await expect(
    changes.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(viewer).toContainText("new planner behavior");
  const visibleDiff = viewer.locator("caffold-diff-viewer");
  await visibleDiff.evaluate((element) => {
    element.dataset.unrelatedWatchProbe = "kept";
  });

  const beforeWatch = reviewScenario.gitStatusRequests;
  const beforeUnrelatedDiff = reviewScenario.gitDiffRequests;
  reviewScenario.includeLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
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
  await expect.poll(() => reviewScenario.gitStatusRequests).toBeGreaterThan(beforeWatch);
  await expect(
    changes.locator('button[data-repo-relative-path="live-update.rs"]'),
  ).toHaveCount(1);
  expect(reviewScenario.gitDiffRequests).toBe(beforeUnrelatedDiff);
  await expect(visibleDiff).toHaveAttribute("data-unrelated-watch-probe", "kept");
  await expect(viewer).toContainText("new planner behavior");

  reviewScenario.gitDiffDelayMs = 500;
  reviewScenario.workingDiffText = "refreshed planner behavior";
  const beforeRelatedDiff = reviewScenario.gitDiffRequests;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    source?.emit("change", {
      revision: 5,
      paths: ["src/planner.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect
    .poll(() => reviewScenario.gitDiffRequests)
    .toBeGreaterThan(beforeRelatedDiff);
  await expect(viewer).toContainText("new planner behavior");
  await expect(viewer.locator(".surface-message")).toHaveCount(0);
  await expect(viewer).toContainText("refreshed planner behavior");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");
});

test("keeps selectedPath while scope, navigator, and viewer switch independently", async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const workingTree = taskReview.locator("caffold-git-diff-changes-tree");
  await workingTree.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "new planner behavior",
  );

  const refsBefore = reviewScenario.gitRefsRequests;
  const compareBefore = reviewScenario.gitCompareRequests;
  await taskReview.getByRole("button", { name: "Branch", exact: true }).click();
  await expect.poll(() => reviewScenario.gitRefsRequests).toBeGreaterThan(refsBefore);
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(compareBefore);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(taskReview.locator("select[data-review-base]")).toHaveValue(
    "origin/main",
  );

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(
    compareTree.locator('button[data-compare-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "new branch behavior",
  );

  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "planner.rs",
  );

  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&nav=files&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(
    taskReview.locator('caffold-file-navigator button[data-entry-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");

  await taskReview.locator("select[data-review-base]").selectOption("origin/release");
  await expect(
    compareTree.locator('button[data-compare-path="src/release.rs"]'),
  ).toBeAttached();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");
});

test("supports every scope navigator and viewer combination", async ({ page }) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const workingTree = taskReview.locator("caffold-git-diff-changes-tree");
  const branchTree = taskReview.locator("caffold-git-compare-tree");
  const fileNavigator = taskReview.locator("caffold-file-navigator");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await workingTree.locator('button[data-repo-relative-path="planner.rs"]').click();

  const combinations = [
    ["working", "changes", "diff"],
    ["working", "changes", "source"],
    ["working", "files", "diff"],
    ["working", "files", "source"],
    ["branch", "changes", "diff"],
    ["branch", "changes", "source"],
    ["branch", "files", "diff"],
    ["branch", "files", "source"],
  ];

  for (const [scope, navigator, representation] of combinations) {
    await test.step(`${scope} / ${navigator} / ${representation}`, async () => {
      await taskReview
        .getByRole("button", {
          name: scope === "branch" ? "Branch" : "Working Tree",
          exact: true,
        })
        .click();
      await taskReview
        .getByRole("button", {
          name: navigator === "files" ? "Files" : "Changes",
          exact: true,
        })
        .click();
      await taskReview
        .getByRole("button", {
          name: representation === "source" ? "Source" : "Diff",
          exact: true,
        })
        .click();

      if (scope === "branch") {
        await expect(taskReview.locator("select[data-review-base]")).toHaveValue(
          "origin/main",
        );
      }
      await expect.poll(() => {
        const url = new URL(page.url());
        return {
          scope: url.searchParams.get("scope") ?? "working",
          navigator: url.searchParams.get("nav") ?? "changes",
          viewer: url.searchParams.get("view") ?? "diff",
          file: url.searchParams.get("file") ?? "",
        };
      }).toEqual({
        scope,
        navigator,
        viewer: representation,
        file: "planner.rs",
      });
      await expect(page).toHaveURL(new RegExp(`/tasks/${taskScenario.threadId}/review\\?`));

      const selectedEntry =
        navigator === "files"
          ? fileNavigator.locator('button[data-entry-path="src/planner.rs"]')
          : scope === "branch"
            ? branchTree.locator('button[data-compare-path="src/planner.rs"]')
            : workingTree.locator('button[data-repo-relative-path="planner.rs"]');
      await expect(selectedEntry).toHaveAttribute("aria-current", "true");

      if (representation === "source") {
        await expect(viewer).toContainText("planner source");
      } else if (scope === "branch") {
        await expect(viewer).toContainText("new branch behavior");
      } else {
        await expect(viewer).toContainText("new planner behavior");
      }
    });
  }
});

test("keeps compact review controls and available panes inside the workspace", async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();

  const layout = await taskReview.evaluate((element) => {
    const workspace = element.querySelector(".task-review-workspace");
    const pageRect = document.querySelector("caffold-tasks-page").getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const navigator = element.querySelector(".task-review-navigator-pane");
    const viewer = element.querySelector(".task-review-viewer-pane");
    return {
      leftGap: Math.abs(workspaceRect.left - pageRect.left),
      rightGap: Math.abs(workspaceRect.right - pageRect.right),
      horizontalOverflow: workspace.scrollWidth > workspace.clientWidth,
      navigatorWidth: navigator.getBoundingClientRect().width,
      viewerWidth: viewer.getBoundingClientRect().width,
      toolbarRows: Math.round(
        element.querySelector(".task-review-toolbar").getBoundingClientRect().height,
      ),
      controlHeights: [
        ...element.querySelectorAll(
          ".task-review-axis-options, .task-review-base:not([hidden]) select, .task-review-refresh",
        ),
      ].map((control) => control.getBoundingClientRect().height),
      axisButtonHeights: [
        ...element.querySelectorAll(".task-review-axis-options button"),
      ].map((control) => control.getBoundingClientRect().height),
      expandedTouchHits: [
        ...element.querySelectorAll(
          ".task-review-base:not([hidden]), .task-review-refresh",
        ),
      ].map((control) => {
        const bounds = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top - 3,
        );
        return {
          control: control.className,
          hit: hit?.getAttribute?.("data-review-value") ?? hit?.className ?? hit?.tagName,
          matches: hit === control || control.contains(hit),
        };
      }),
    };
  });

  expect(layout.leftGap).toBeLessThanOrEqual(1);
  expect(layout.rightGap).toBeLessThanOrEqual(1);
  expect(layout.horizontalOverflow).toBe(false);
  expect(layout.navigatorWidth).toBeGreaterThanOrEqual(220);
  if (testInfo.project.name === "phone") {
    expect(layout.viewerWidth).toBe(0);
  } else {
    expect(layout.viewerWidth).toBeGreaterThanOrEqual(360);
  }
  expect(layout.toolbarRows).toBeLessThanOrEqual(
    testInfo.project.name === "phone" ? 120 : 90,
  );
  expect(
    Math.max(...layout.controlHeights) - Math.min(...layout.controlHeights),
  ).toBeLessThanOrEqual(1);
  if (testInfo.project.name !== "desktop") {
    expect(Math.max(...layout.controlHeights)).toBeLessThanOrEqual(34);
    expect(Math.min(...layout.axisButtonHeights)).toBeGreaterThanOrEqual(40);
    expect(layout.expandedTouchHits.filter(({ matches }) => !matches)).toEqual([]);
  }

  for (const axis of await taskReview.locator(".task-review-axis").all()) {
    await expect(axis.locator(":scope > .task-review-axis-label")).toHaveCount(1);
    await expect(axis.locator(":scope > .task-review-axis-options")).toHaveCount(1);
    await expect(axis.locator(":scope > .task-review-axis-options > button")).toHaveCount(2);
  }
});

test("keeps a 180-file change set inspectable without clipping its identity", async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.largeChangeSet = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  await expect(changes.locator("button[data-change-path]")).toHaveCount(184);
  const longPath = changes.locator(
    'button[data-repo-relative-path="generated/deep/review/file-180-with-a-long-review-name.rs"]',
  );
  await expect(longPath).toHaveAttribute(
    "title",
    "generated/deep/review/file-180-with-a-long-review-name.rs",
  );
});

test("maps the visible source line when Diff and Source representations switch", async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await taskReview.locator('button[data-entry-path="src/planner.rs"]').click();

  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  await expect(viewer.locator("caffold-code-viewer header")).toHaveCount(0);
  expect(await viewer.evaluate((element) => element.scrollToLine(60))).toBe(true);
  await expect
    .poll(() => viewer.evaluate((element) => element.visibleLine()))
    .toBeGreaterThan(1);
  const sourceLine = await viewer.evaluate((element) => element.visibleLine());
  expect(sourceLine).toBeLessThanOrEqual(60);

  await taskReview.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(viewer.locator("caffold-diff-viewer")).toBeVisible();
  await expect.poll(() => viewer.evaluate((element) => element.visibleLine())).toBe(60);

  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  await expect
    .poll(() => viewer.evaluate((element) => element.visibleLine()))
    .toBe(sourceLine);
});

test("rejects a late branch response after the base changes", async ({ page }) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  reviewScenario.setCompareDelay("origin/main", 250);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await taskReview.getByRole("button", { name: "Branch", exact: true }).click();
  await expect(taskReview.locator("select[data-review-base]")).toBeEnabled();
  await taskReview.locator("select[data-review-base]").selectOption("origin/release");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(
    compareTree.locator('button[data-compare-path="src/release.rs"]'),
  ).toBeAttached();
  await page.waitForTimeout(300);
  await expect(
    compareTree.locator('button[data-compare-path="src/planner.rs"]'),
  ).toHaveCount(0);
});
