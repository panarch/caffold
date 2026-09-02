import { expect, test } from "@playwright/test";
import {
  actionHintBadgePresentation,
  actionHintDialog,
  enterActionHints,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  openCompletedTaskForReview,
  selectTaskReviewScope,
} from "../support/task-review-test.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps the selected Review file identity stable while content loads", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  reviewScenario.gitDiffDelayMs = 500;
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await changes.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(viewer.locator(".surface-message")).toHaveText("Loading file...");
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("planner.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  await expect(viewer.locator(".viewer-line-stats")).toHaveCount(0);
  await expect(viewer.locator("caffold-diff-viewer")).toContainText(
    "new planner behavior",
  );
  await expect(viewer.locator(".viewer-title-block h2")).toHaveText("planner.rs");
  await expect(viewer.locator(".viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  await expect(viewer.locator(".viewer-line-stats")).toHaveAttribute(
    "aria-label",
    "2 additions and 1 deletions",
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

test("normalizes and compacts shared file-tree statuses", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { reviewScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.edgeCaseFiles = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const expected = [
    ["planner.rs", "M", "modified", "Modified"],
    ["deleted.rs", "D", "deleted", "Deleted"],
    ["untracked.rs", "A", "added", "Added"],
    ["staged.rs", "M", "modified", "Modified"],
    ["mixed-modified.rs", "M", "modified", "Modified"],
    ["added-modified.rs", "M", "modified", "Modified"],
    ["renamed.rs", "R", "renamed", "Renamed"],
    ["conflicted.rs", "U", "unmerged", "Unmerged"],
    ["unknown.rs", "?", "unknown", "Unknown"],
  ];
  for (const [path, code, tone, label] of expected) {
    const entry = changes.locator(
      `button[data-file-tree-relative-path="${path}"]`,
    );
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("data-file-tree-status", code);
    await expect(entry).toHaveAttribute("data-file-tree-status-tone", tone);
    await expect(entry.locator(".file-tree-status-code")).toHaveText(code);
    await expect(entry).toHaveAttribute("aria-label", new RegExp(`^${label}\\.`));
  }

  for (const path of ["mixed-modified.rs", "added-modified.rs"]) {
    await expect(
      changes.locator(`button[data-file-tree-relative-path="${path}"]`),
    ).toHaveAttribute("data-file-tree-key", /^unstaged:file:/);
  }
  const renderedCodes = await changes
    .locator(".file-tree-status-code")
    .allTextContents();
  expect(
    renderedCodes.filter(Boolean).every((code) => Array.from(code).length === 1),
  ).toBe(true);
  expect(renderedCodes).not.toEqual(
    expect.arrayContaining([" M", "M ", "MM", "AM", "??"]),
  );

  const geometry = await changes.evaluate((tree) => {
    const entry = tree.querySelector(
      'button[data-file-tree-relative-path="planner.rs"]',
    );
    const directory = tree.querySelector(
      'button[data-file-tree-path="tests"]',
    );
    const nested = tree.querySelector(
      'button[data-file-tree-relative-path="tests/planner.rs"]',
    );
    const status = entry.querySelector(".file-tree-status-code");
    const label = entry.querySelector(".file-tree-node-label");
    const icon = entry.querySelector(".file-tree-icon");
    const name = entry.querySelector(".file-tree-name");
    const statusRect = status.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    const statusColors = {};
    for (const [tone, token] of [
      ["added", "--file-status-added-fg"],
      ["modified", "--file-status-modified-fg"],
      ["deleted", "--file-status-deleted-fg"],
      ["renamed", "--file-status-renamed-fg"],
      ["unmerged", "--file-status-unmerged-fg"],
      ["unknown", "--file-status-unknown-fg"],
    ]) {
      const statusElement = tree.querySelector(
        `.file-tree-entry[data-file-tree-status-tone="${tone}"] .file-tree-status-code`,
      );
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      tree.append(probe);
      statusColors[tone] = {
        actual: getComputedStyle(statusElement).color,
        expected: getComputedStyle(probe).color,
      };
      probe.remove();
    }
    return {
      statusColumn: entry.closest("caffold-file-tree").dataset.statusColumn,
      statusWidth: statusRect.width,
      statusGap: labelRect.left - statusRect.right,
      iconSlotWidth: iconRect.width,
      iconNameGap: nameRect.left - iconRect.right,
      recoveredWidth:
        iconRect.width + (nameRect.left - iconRect.right) -
        statusRect.width - (labelRect.left - statusRect.right),
      rootIconAlignment: Math.abs(
        iconRect.left -
          directory.querySelector(".file-tree-icon").getBoundingClientRect().left,
      ),
      nestedIndent:
        nested.querySelector(".file-tree-icon").getBoundingClientRect().left -
        directory.querySelector(".file-tree-icon").getBoundingClientRect().left,
      statusColors,
    };
  });
  expect(geometry.statusColumn).toBe("true");
  expect(geometry.statusWidth).toBeLessThan(geometry.iconSlotWidth);
  expect(geometry.statusGap).toBeLessThanOrEqual(geometry.iconNameGap);
  expect(geometry.recoveredWidth).toBeGreaterThanOrEqual(12);
  expect(geometry.recoveredWidth).toBeLessThanOrEqual(15);
  expect(geometry.rootIconAlignment).toBeLessThanOrEqual(1);
  expect(geometry.nestedIndent).toBeGreaterThanOrEqual(10);
  for (const colors of Object.values(geometry.statusColors)) {
    expect(colors.actual).toBe(colors.expected);
  }

  const directory = changes.locator('button[data-file-tree-path="tests"]');
  const file = changes.locator(
    'button[data-file-tree-relative-path="planner.rs"]',
  );
  expect((await directory.boundingBox()).y).toBeLessThan(
    (await file.boundingBox()).y,
  );
  const statusRequestsBeforeOrderChange = reviewScenario.gitStatusRequests;
  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("name");
  });
  expect((await file.boundingBox()).y).toBeLessThan(
    (await directory.boundingBox()).y,
  );
  expect(reviewScenario.gitStatusRequests).toBe(
    statusRequestsBeforeOrderChange,
  );

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-status-column");

  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  const statuslessTree = taskReview.locator("caffold-file-navigator caffold-file-tree");
  await expect(
    statuslessTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toBeAttached();
  const statuslessGeometry = await statuslessTree.evaluate((tree) => {
    const entry = tree.querySelector('button[data-file-tree-path="src/planner.rs"]');
    const status = entry.querySelector(".file-tree-status-code");
    const icon = entry.querySelector(".file-tree-icon").getBoundingClientRect();
    const name = entry.querySelector(".file-tree-name").getBoundingClientRect();
    return {
      statusColumn: tree.dataset.statusColumn,
      statusDisplay: getComputedStyle(status).display,
      columnCount: getComputedStyle(entry).gridTemplateColumns.split(" ").length,
      iconSlotWidth: icon.width,
      iconNameGap: name.left - icon.right,
    };
  });
  expect(statuslessGeometry).toEqual({
    statusColumn: "false",
    statusDisplay: "none",
    columnCount: 1,
    iconSlotWidth: geometry.iconSlotWidth,
    iconNameGap: geometry.iconNameGap,
  });
});

test("reviews working tree changes through the canonical Review route", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await expect(page.locator("caffold-review-workspace")).toHaveCount(0);

  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(taskReview).toBeVisible();
  await expect(changes.locator('button[data-file-tree-kind="file"]')).toHaveCount(4);
  const plannerChange = changes.locator(
    'button[data-file-tree-relative-path="planner.rs"]',
  );
  await expect(plannerChange).toHaveAttribute("title", "planner.rs");
  await expect(plannerChange).toHaveAttribute(
    "aria-label",
    "Modified. Show diff for planner.rs",
  );

  await plannerChange.click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?file=planner.rs`,
  );
  await expect(
    changes.locator('button[data-file-tree-relative-path="planner.rs"]'),
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
    changes.locator('button[data-file-tree-relative-path="live-update.rs"]'),
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
  await captureReviewScreenshot(page, testInfo, "tasks-working-tree-diff");
});

test("keeps selectedPath while scope, navigator, and viewer switch independently", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const workingTree = taskReview.locator("caffold-git-diff-changes-tree");
  await workingTree.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "new planner behavior",
  );

  const refsBefore = reviewScenario.gitRefsRequests;
  const compareBefore = reviewScenario.gitCompareRequests;
  const branchMode = tasksPage.locator(
    'caffold-segmented-control[data-detail-view-switch] button[data-segmented-value="branch"]',
  );
  await expect(branchMode).toHaveText("Branch");
  await branchMode.evaluate((button) => {
    button.dataset.stableLabelProbe = "kept";
    button.branchLabelHistory = [button.textContent.trim()];
    button.branchLabelObserver = new MutationObserver(() => {
      button.branchLabelHistory.push(button.textContent.trim());
    });
    button.branchLabelObserver.observe(button, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await selectTaskReviewScope(tasksPage, "branch");
  await expect.poll(() => reviewScenario.gitRefsRequests).toBeGreaterThan(refsBefore);
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(compareBefore);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(branchMode).toHaveAttribute("aria-pressed", "true");
  await expect(branchMode).toHaveText("Branch");
  await expect(branchMode).toHaveAttribute("title", "Compare with origin/main");
  await expect(branchMode).toHaveAttribute("data-stable-label-probe", "kept");
  expect(
    await branchMode.evaluate((button) => [...new Set(button.branchLabelHistory)]),
  ).toEqual(["Branch"]);

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(compareTree.locator(".compare-base-label")).toHaveText("vs main");
  await expect(compareTree.locator(".compare-base")).toHaveAttribute(
    "title",
    "Compare with origin/main",
  );
  await expect(compareTree.getByLabel("Branch comparison base")).toHaveValue(
    "origin/main",
  );
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "new branch behavior",
  );
  await expect(
    taskReview.locator("caffold-review-file-viewer .viewer-line-stats"),
  ).toHaveAttribute("aria-label", "4 additions and 2 deletions");

  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "planner.rs",
  );

  if (testInfo.project.name === "phone") {
    await expect(taskReview.locator(".task-review-navigator-axis")).toBeHidden();
    await taskReview.evaluate((review) => review.updateAxis("navigator", "files"));
  } else {
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  }
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&nav=files&view=source&file=planner.rs&base=origin%2Fmain`,
  );
  await expect(
    taskReview.locator('caffold-file-navigator button[data-file-tree-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");
});

test("supports every scope navigator and viewer combination", { tag: "@all-viewports" }, async ({ page }) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const workingTree = taskReview.locator("caffold-git-diff-changes-tree");
  const branchTree = taskReview.locator("caffold-git-compare-tree");
  const fileNavigator = taskReview.locator("caffold-file-navigator");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await workingTree.locator('button[data-file-tree-relative-path="planner.rs"]').click();

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
      await selectTaskReviewScope(tasksPage, scope);
      if (test.info().project.name === "phone") {
        await taskReview.evaluate(
          (review, nextNavigator) => review.updateAxis("navigator", nextNavigator),
          navigator,
        );
      } else {
        await taskReview
          .getByRole("button", {
            name: navigator === "files" ? "Files" : "Changes",
            exact: true,
          })
          .click();
      }
      await taskReview
        .getByRole("button", {
          name: representation === "source" ? "Source" : "Diff",
          exact: true,
        })
        .click();

      if (scope === "branch") {
        await expect(
          tasksPage.locator(
            'caffold-segmented-control[data-detail-view-switch] '
              + 'button[data-segmented-value="branch"]',
          ),
        ).toHaveAttribute("aria-pressed", "true");
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
          ? fileNavigator.locator('button[data-file-tree-path="src/planner.rs"]')
          : scope === "branch"
            ? branchTree.locator('button[data-file-tree-path="src/planner.rs"]')
            : workingTree.locator('button[data-file-tree-relative-path="planner.rs"]');
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

test("preserves valid Task Review base routes and falls back for missing refs", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { taskScenario, taskReview } = await openCompletedTaskForReview(page);
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Frelease`,
  );

  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Frelease`,
  );
  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await expect(baseSelect).toHaveValue("origin/release");
  await expect(baseSelect.locator("option")).toHaveText([
    "main",
    "origin/main",
    "origin/release",
    "origin/feature/this-is-a-very-long-branch-name-used-for-responsive-review-testing",
  ]);
  await expect(
    compareTree.locator('button[data-file-tree-path="src/release.rs"]'),
  ).toBeAttached();
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toHaveCount(0);

  await page.goto(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmissing`,
  );
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
  );
  await expect(baseSelect).toHaveValue("origin/main");
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toBeAttached();
});

test("selects local and remote Branch bases without replacing the picker", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await expect(baseSelect).toHaveValue("origin/main");
  await baseSelect.evaluate((select) => {
    select.stableBaseSelectorProbe = true;
  });
  const selectedFile = testInfo.project.name === "phone" ? "" : "file=planner.rs&";
  if (selectedFile) {
    await compareTree.locator('button[data-file-tree-path="src/planner.rs"]').click();
  }

  await baseSelect.selectOption("main");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&${selectedFile}base=main`,
  );
  await expect(baseSelect).toHaveValue("main");
  await expect.poll(() => reviewScenario.lastCompareDiffBaseRef).toBe("main");
  expect(await baseSelect.evaluate((select) => select.stableBaseSelectorProbe)).toBe(true);

  await baseSelect.selectOption("origin/release");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&${selectedFile}base=origin%2Frelease`,
  );
  await expect(baseSelect).toHaveValue("origin/release");
  await expect(
    compareTree.locator('button[data-file-tree-path="src/release.rs"]'),
  ).toBeAttached();
  if (selectedFile) {
    await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
      "No changes in this scope.",
    );
  }
  expect(await baseSelect.evaluate((select) => select.stableBaseSelectorProbe)).toBe(true);

  await selectTaskReviewScope(tasksPage, "working");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?${selectedFile}base=origin%2Frelease`,
  );
  await selectTaskReviewScope(tasksPage, "branch");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&${selectedFile}base=origin%2Frelease`,
  );
  await expect(baseSelect).toHaveValue("origin/release");
  expect(await baseSelect.evaluate((select) => select.stableBaseSelectorProbe)).toBe(true);

  await page.reload();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&${selectedFile}base=origin%2Frelease`,
  );
  await expect(taskReview.getByLabel("Branch comparison base")).toHaveValue(
    "origin/release",
  );
});

test("hands the Branch comparison base Hint to its retained native select", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await expect(baseSelect).toHaveValue("origin/main");
  const hint = await enterActionHints(page);
  const badge = hint.getByLabel(
    / — Choose comparison base \(current origin\/main\)$/,
  );
  await expect(badge).toBeVisible();
  await expect(compareTree.locator(".compare-file-count")).toBeVisible();
  expect(await actionHintBadgePresentation(badge)).toEqual({
    backgroundMatches: true,
    borderVisible: true,
    colorMatches: true,
    hasBlockPadding: true,
    position: "absolute",
  });
  const geometry = await badge.evaluate((element) => {
    const anchor = document.querySelector(
      "caffold-task-review caffold-git-compare-tree .compare-tree-primary",
    );
    const control = anchor.querySelector("select[data-compare-base-ref]");
    const badgeRect = element.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();
    return {
      alignedLeft: Math.abs(badgeRect.left - anchorRect.left) <= 1,
      outsideSelectOverlay: badgeRect.top >= anchorRect.bottom + 3,
      controlMatchesAnchor:
        Math.abs(controlRect.left - anchorRect.left) <= 1 &&
        Math.abs(controlRect.top - anchorRect.top) <= 1 &&
        Math.abs(controlRect.right - anchorRect.right) <= 1 &&
        Math.abs(controlRect.bottom - anchorRect.bottom) <= 1,
      insideViewport:
        badgeRect.left >= 0 &&
        badgeRect.right <= window.innerWidth &&
        badgeRect.top >= 0 &&
        badgeRect.bottom <= window.innerHeight,
    };
  });
  expect(geometry).toEqual({
    alignedLeft: true,
    outsideSelectOverlay: true,
    controlMatchesAnchor: true,
    insideViewport: true,
  });
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-branch-base-action-hints",
  );

  const code = await badge.getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  await compareTree.evaluate((tree) => {
    tree.setBaseSelection({
      refs: tree.baseSelection.refs,
      value: "origin/release",
    });
  });
  const updatedBadge = hint.locator(`[data-action-hint-code="${code}"]`);
  await expect(updatedBadge).toHaveAttribute(
    "aria-label",
    `${code} — Choose comparison base (current origin/release)`,
  );
  await compareTree.evaluate((tree) => {
    tree.setBaseSelection({
      refs: tree.baseSelection.refs,
      value: "origin/main",
    });
  });
  await expect(updatedBadge).toHaveAttribute(
    "aria-label",
    `${code} — Choose comparison base (current origin/main)`,
  );

  await page.keyboard.type(code.toLowerCase());
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(baseSelect).toBeFocused();
  const requestsBefore = reviewScenario.gitCompareRequests;
  await baseSelect.selectOption("origin/release");
  await expect.poll(() => reviewScenario.gitCompareRequests)
    .toBeGreaterThan(requestsBefore);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Frelease`,
  );
  await expect(baseSelect).toHaveValue("origin/release");
  await expect(compareTree.locator(".compare-base-label")).toHaveText(
    "vs release",
  );
  await expect(
    compareTree.locator('button[data-file-tree-path="src/release.rs"]'),
  ).toBeAttached();
});

test("cancels a Branch base Hint when its select binding is replaced", { tag: "@desktop" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(compareTree.getByLabel("Branch comparison base")).toHaveValue(
    "origin/main",
  );
  await waitForActionHintTarget(
    page,
    "Choose comparison base (current origin/main)",
  );
  const hint = await enterActionHints(page);
  await expect(
    hint.getByLabel(/ — Choose comparison base \(current origin\/main\)$/),
  ).toBeVisible();
  await compareTree.evaluate((tree) => {
    const select = tree.querySelector("select[data-compare-base-ref]");
    select.replaceWith(select.cloneNode(true));
  });

  await expect(hint).toBeHidden();
  await expect(page.locator("caffold-task-workspace")).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await expect(compareTree.getByLabel("Branch comparison base")).not.toBeFocused();
});

test("keeps the Branch base Hint available without ready compared files", { tag: "@desktop" }, async ({
  page,
}) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const releaseCompare = reviewScenario.holdCompare("origin/main");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const assertSelectOnly = async () => {
    const hint = await enterActionHints(page);
    await expect(
      hint.getByLabel(/ — Choose comparison base \(current origin\/main\)$/),
    ).toBeVisible();
    await expect(hint.getByLabel(/Show compare diff for /)).toHaveCount(0);
    await page.keyboard.press("Escape");
  };

  try {
    await selectTaskReviewScope(tasksPage, "branch");
    await expect(compareTree.locator(".surface-message")).toHaveText(
      "Loading compare...",
    );
    await assertSelectOnly();
  } finally {
    releaseCompare();
  }
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toBeAttached();

  await compareTree.evaluate((tree) => {
    tree.setError(new Error("fixture compare unavailable"));
  });
  await expect(compareTree.locator(".surface-message")).toHaveText(
    "fixture compare unavailable",
  );
  await assertSelectOnly();

  await compareTree.evaluate((tree) => {
    tree.setCompare({
      repository: { rootPath: "src", branch: "main", dirty: true },
      baseRef: "origin/main",
      headRef: "main",
      additions: 0,
      deletions: 0,
      files: [],
    });
  });
  await expect(compareTree.locator(".surface-message")).toHaveText(
    "No changes compared with origin/main.",
  );
  await assertSelectOnly();
});

test("keeps equivalent Branch header refreshes mutation-free", { tag: "@all-viewports" }, async ({ page }) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await expect(baseSelect).toHaveValue("origin/main");
  await baseSelect.evaluate((select) => {
    const header = select.closest("header");
    const records = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(header, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    window.__branchHeaderMutationProbe = { select, observer, records };
  });

  const before = reviewScenario.gitCompareRequests;
  await emitGitRefsChanged(page);
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(before);
  expect(
    await page.evaluate(() => {
      const probe = window.__branchHeaderMutationProbe;
      probe.records.push(...probe.observer.takeRecords());
      probe.observer.disconnect();
      return {
        sameSelect:
          probe.select.isConnected &&
          probe.select
            .closest("caffold-git-compare-tree")
            ?.querySelector("select[data-compare-base-ref]") === probe.select,
        mutations: probe.records.length,
      };
    }),
  ).toEqual({ sameSelect: true, mutations: 0 });
});

test("refreshes Branch after returning from the background", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__caffoldVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__caffoldVisibilityState,
    });
  });

  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await expect(
    compareTree.locator(".compare-line-stats .is-addition"),
  ).toHaveText("+3");
  await expect(
    compareTree.locator(".compare-line-stats .is-deletion"),
  ).toHaveText("-1");
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    if (!source) {
      throw new Error("Missing Task Review watch source");
    }
    source.emit("ready", {
      revision: 1,
      scopePath: "src",
      repositoryRootPath: "src",
    });
  });

  await page.evaluate(() => {
    window.__caffoldVisibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__caffoldMockEventSources
          .filter((source) => source.url.startsWith("/api/watch?"))
          .every((source) => source.readyState === 2),
      ),
    )
    .toBe(true);

  const compareBeforeRecovery = reviewScenario.gitCompareRequests;
  reviewScenario.cleanBranch = true;
  expect(reviewScenario.gitCompareRequests).toBe(compareBeforeRecovery);

  await page.evaluate(() => {
    window.__caffoldVisibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => reviewScenario.gitCompareRequests)
    .toBeGreaterThan(compareBeforeRecovery);
  await expect(compareTree.getByText("No changes compared with origin/main.")).toBeVisible();
  await expect(
    compareTree.locator(".compare-line-stats .is-addition"),
  ).toHaveText("+0");
  await expect(
    compareTree.locator(".compare-line-stats .is-deletion"),
  ).toHaveText("-0");
});

test("falls back when the selected Branch base disappears", { tag: "@all-viewports" }, async ({ page }) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await baseSelect.selectOption("origin/release");
  await expect(baseSelect).toHaveValue("origin/release");
  await baseSelect.evaluate((select) => {
    select.stableBaseSelectorProbe = true;
  });

  reviewScenario.removeRef("origin/release");
  await emitGitRefsChanged(page);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=origin%2Fmain`,
  );
  await expect(baseSelect).toHaveValue("origin/main");
  await expect(baseSelect.locator('option[value="origin/release"]')).toHaveCount(0);
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toBeAttached();
  expect(await baseSelect.evaluate((select) => select.stableBaseSelectorProbe)).toBe(true);
});

test("keeps compact review controls and available panes inside the workspace", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  const branchMode = tasksPage.locator(
    'caffold-segmented-control[data-detail-view-switch] button[data-segmented-value="branch"]',
  );
  const workingMode = tasksPage.locator(
    'caffold-segmented-control[data-detail-view-switch] button[data-segmented-value="working"]',
  );
  const inactiveDivider = await branchMode.evaluate((button) => {
    const style = getComputedStyle(button, "::before");
    return {
      height: Number.parseFloat(style.height),
      opacity: Number.parseFloat(style.opacity),
    };
  });
  expect(inactiveDivider.height).toBeGreaterThanOrEqual(12);
  expect(inactiveDivider.height).toBeLessThanOrEqual(16);
  expect(inactiveDivider.opacity).toBeGreaterThan(0);
  await expect
    .poll(() =>
      workingMode.evaluate((button) =>
        Number.parseFloat(getComputedStyle(button, "::before").opacity),
      ),
    )
    .toBe(0);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect
    .poll(() =>
      branchMode.evaluate((button) =>
        Number.parseFloat(getComputedStyle(button, "::before").opacity),
      ),
    )
    .toBe(0);
  await branchMode.click();
  await expect
    .poll(() =>
      workingMode.evaluate((button) =>
        Number.parseFloat(getComputedStyle(button, "::before").opacity),
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      branchMode.evaluate((button) =>
        Number.parseFloat(getComputedStyle(button, "::before").opacity),
      ),
    )
    .toBe(0);
  const longBaseRef =
    "origin/feature/this-is-a-very-long-branch-name-used-for-responsive-review-testing";
  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const compareHeader = compareTree.locator(".compare-tree-panel > header");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await baseSelect.selectOption(longBaseRef);
  await expect(baseSelect).toHaveValue(longBaseRef);
  await expect(compareHeader.locator(".compare-line-stats")).toBeVisible();
  const compareHeaderMetrics = await compareHeader.evaluate((header) => {
    const primary = header.querySelector(".compare-tree-primary");
    const secondary = header.querySelector(".compare-tree-secondary");
    const title = header.querySelector("h2");
    const base = header.querySelector(".compare-base");
    const label = header.querySelector(".compare-base-label");
    const chevron = header.querySelector(".compare-base-chevron");
    const select = header.querySelector("select[data-compare-base-ref]");
    const baseStyle = getComputedStyle(base);
    return {
      height: header.getBoundingClientRect().height,
      titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
      selectHeight: select.getBoundingClientRect().height,
      labelOverflows: label.scrollWidth > label.clientWidth,
      primaryBeforeSecondary:
        primary.getBoundingClientRect().right <=
        secondary.getBoundingClientRect().left + 1,
      labelBelowTitle:
        label.getBoundingClientRect().top >=
        title.getBoundingClientRect().bottom - 1,
      chevronVisible: chevron.getClientRects().length > 0,
      baseBorderWidth:
        Number.parseFloat(baseStyle.borderTopWidth) +
        Number.parseFloat(baseStyle.borderRightWidth) +
        Number.parseFloat(baseStyle.borderBottomWidth) +
        Number.parseFloat(baseStyle.borderLeftWidth),
    };
  });
  expect(compareHeaderMetrics.labelOverflows).toBe(true);
  expect(compareHeaderMetrics.primaryBeforeSecondary).toBe(true);
  expect(compareHeaderMetrics.labelBelowTitle).toBe(true);
  expect(compareHeaderMetrics.chevronVisible).toBe(true);
  expect(compareHeaderMetrics.baseBorderWidth).toBe(0);
  expect(compareHeaderMetrics.selectHeight).toBeGreaterThan(0);
  if (testInfo.project.name !== "desktop") {
    expect(compareHeaderMetrics.selectHeight).toBeGreaterThanOrEqual(40);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-base-selector");

  await workingMode.click();
  const changesHeader = taskReview.locator(
    "caffold-git-diff-changes-tree .changes-tree-panel > header",
  );
  await expect(changesHeader).toBeVisible();
  const changesHeaderMetrics = await changesHeader.evaluate((header) => ({
    height: header.getBoundingClientRect().height,
    titleFontSize: Number.parseFloat(
      getComputedStyle(header.querySelector("h2")).fontSize,
    ),
  }));
  expect(
    Math.abs(compareHeaderMetrics.height - changesHeaderMetrics.height),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      compareHeaderMetrics.titleFontSize - changesHeaderMetrics.titleFontSize,
    ),
  ).toBeLessThanOrEqual(0.1);
  const changesAlignment = await taskReview.evaluate((review) => {
    const pane = review.querySelector(".task-review-navigator-pane");
    const header = review.querySelector(
      "caffold-git-diff-changes-tree .changes-tree-panel > header",
    );
    const count = header.querySelector(".change-count");
    const controls = review.querySelector(
      '.task-review-navigator-axis caffold-segmented-control[data-review-axis="navigator"]',
    );
    const paneRect = pane.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      headerLeftPadding: Number.parseFloat(getComputedStyle(header).paddingLeft),
      controlRightInset: paneRect.right - controlsRect.right,
      labelGap: controlsRect.left - count.getBoundingClientRect().right,
      expectedLabelGap:
        Number.parseFloat(rootStyle.getPropertyValue("--interface-space-5")) *
        Number.parseFloat(rootStyle.fontSize),
    };
  });
  expect(
    Math.abs(
      changesAlignment.controlRightInset - changesAlignment.headerLeftPadding,
    ),
  ).toBeLessThanOrEqual(1);
  expect(changesAlignment.labelGap).toBeGreaterThanOrEqual(
    changesAlignment.expectedLabelGap - 1,
  );
  await taskReview
    .locator(
      'caffold-segmented-control[data-review-axis="navigator"] '
        + 'button[data-segmented-value="files"]',
    )
    .click();
  const filesHeader = taskReview.locator(
    "caffold-file-list .file-list-panel > header",
  );
  await expect(filesHeader).toBeVisible();
  await expect(filesHeader.locator(".entry-count")).toBeVisible();
  const filesHeaderMetrics = await filesHeader.evaluate((header) => ({
    height: header.getBoundingClientRect().height,
    titleFontSize: Number.parseFloat(
      getComputedStyle(header.querySelector("h2")).fontSize,
    ),
  }));
  expect(
    Math.abs(filesHeaderMetrics.height - changesHeaderMetrics.height),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(filesHeaderMetrics.titleFontSize - changesHeaderMetrics.titleFontSize),
  ).toBeLessThanOrEqual(0.1);
  const filesAlignment = await taskReview.evaluate((review) => {
    const header = review.querySelector(
      "caffold-file-list .file-list-panel > header",
    );
    const count = header.querySelector(".entry-count");
    const controls = review.querySelector(
      '.task-review-navigator-axis caffold-segmented-control[data-review-axis="navigator"]',
    );
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      labelGap:
        controls.getBoundingClientRect().left -
        count.getBoundingClientRect().right,
      expectedLabelGap:
        Number.parseFloat(rootStyle.getPropertyValue("--interface-space-5")) *
        Number.parseFloat(rootStyle.fontSize),
    };
  });
  expect(filesAlignment.labelGap).toBeGreaterThanOrEqual(
    filesAlignment.expectedLabelGap - 1,
  );
  await taskReview
    .locator(
      'caffold-segmented-control[data-review-axis="navigator"] '
        + 'button[data-segmented-value="changes"]',
    )
    .click();
  await expect(
    tasksPage.locator(
      "caffold-segmented-control[data-detail-view-switch] button",
    ),
  ).toHaveCount(3);
  await expect(taskReview.locator(".task-review-toolbar")).toHaveCount(0);

  const layout = await taskReview.evaluate((element) => {
    const workspace = element.querySelector(".task-review-workspace");
    const pageRect = document.querySelector("caffold-tasks-page").getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const navigator = element.querySelector(".task-review-navigator-pane");
    const viewer = element.querySelector(".task-review-viewer-pane");
    const detailSwitch = document.querySelector(
      "caffold-segmented-control[data-detail-view-switch]",
    );
    const detailSwitchRect = detailSwitch.getBoundingClientRect();
    const detailSwitchStyle = getComputedStyle(detailSwitch);
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return {
      leftGap: Math.abs(workspaceRect.left - pageRect.left),
      rightGap: Math.abs(workspaceRect.right - pageRect.right),
      horizontalOverflow: workspace.scrollWidth > workspace.clientWidth,
      navigatorWidth: navigator.getBoundingClientRect().width,
      viewerWidth: viewer.getBoundingClientRect().width,
      rootFontSize,
      detailSwitch: {
        width: detailSwitchRect.width,
        height: detailSwitchRect.height,
        borderInlineWidth:
          Number.parseFloat(detailSwitchStyle.borderLeftWidth) +
          Number.parseFloat(detailSwitchStyle.borderRightWidth),
        gridAutoColumns: detailSwitchStyle.gridAutoColumns,
        insidePage:
          detailSwitchRect.left >= pageRect.left - 1 &&
          detailSwitchRect.right <= pageRect.right + 1,
        buttonFontSizes: [...detailSwitch.querySelectorAll("button")].map(
          (button) => getComputedStyle(button).fontSize,
        ),
        segments: [...detailSwitch.querySelectorAll("button")].map((button) => {
          const label = button.querySelector(":scope > span");
          const labelStyle = getComputedStyle(label);
          const textRange = document.createRange();
          textRange.selectNodeContents(label);
          return {
            buttonWidth: button.getBoundingClientRect().width,
            paddingInline:
              Number.parseFloat(labelStyle.paddingLeft) +
              Number.parseFloat(labelStyle.paddingRight),
            textWidth: textRange.getBoundingClientRect().width,
          };
        }),
      },
      axisControlWidths: Object.fromEntries(
        [...element.querySelectorAll(".task-review-pane-axis")]
          .filter((axis) => axis.getClientRects().length > 0)
          .map((axis) => {
            const control = axis.querySelector("caffold-segmented-control");
            return [
              control.getAttribute("aria-label"),
              control.getBoundingClientRect().width,
            ];
          }),
      ),
      layoutStartsAtWorkspaceTop:
        Math.abs(
          element.querySelector(".task-review-layout").getBoundingClientRect().top -
            workspaceRect.top,
        ) <= 1,
      visiblePaneAxes: [...element.querySelectorAll(".task-review-pane-axis")]
        .filter((axis) => axis.getClientRects().length > 0)
        .map((axis) => axis.querySelector("caffold-segmented-control").getAttribute("aria-label")),
      paneAxisClearances: [...element.querySelectorAll(".task-review-pane-axis")]
        .filter((axis) => axis.getClientRects().length > 0)
        .map((axis) => {
          const axisBounds = axis.getBoundingClientRect();
          const controlsBounds = axis
            .querySelector("caffold-segmented-control")
            .getBoundingClientRect();
          return {
            top: controlsBounds.top - axisBounds.top,
            bottom: axisBounds.bottom - controlsBounds.bottom,
          };
        }),
      emptyViewerHeaderVisible:
        element.querySelector(".task-review-viewer-empty-header").getClientRects().length > 0,
      visualControlHeights: [
        ...element.querySelectorAll(
          ".task-review-pane-axis > caffold-segmented-control",
        ),
      ]
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => control.getBoundingClientRect().height),
      directTouchControlHeights: [
        ...element.querySelectorAll(
          ".task-review-pane-axis > caffold-segmented-control > button",
        ),
      ]
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => control.getBoundingClientRect().height),
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
  expect(layout.layoutStartsAtWorkspaceTop).toBe(true);
  expect(layout.detailSwitch.gridAutoColumns).toBe("max-content");
  expect(layout.detailSwitch.insidePage).toBe(true);
  const expectedLabelPaddingInline =
    layout.rootFontSize * (testInfo.project.name === "phone" ? 0.75 : 1);
  for (const segment of layout.detailSwitch.segments) {
    expect(segment.paddingInline).toBeCloseTo(expectedLabelPaddingInline, 1);
    expect(segment.buttonWidth).toBeCloseTo(
      segment.textWidth + segment.paddingInline,
      0,
    );
  }
  expect(layout.detailSwitch.width).toBeCloseTo(
    layout.detailSwitch.borderInlineWidth +
      layout.detailSwitch.segments.reduce(
        (width, segment) => width + segment.buttonWidth,
        0,
      ),
    0,
  );
  expect(layout.detailSwitch.height).toBeCloseTo(
    layout.rootFontSize * 1.875,
    0,
  );
  for (const fontSize of layout.detailSwitch.buttonFontSizes) {
    expect(Number.parseFloat(fontSize)).toBeCloseTo(
      layout.rootFontSize * 0.75,
      1,
    );
  }
  expect(layout.axisControlWidths["Review navigator"]).toBeCloseTo(
    layout.rootFontSize * 7,
    0,
  );
  if (testInfo.project.name !== "phone") {
    expect(layout.axisControlWidths["Review viewer"]).toBeCloseTo(
      layout.rootFontSize * 7.5,
      0,
    );
  }
  expect(layout.visiblePaneAxes).toEqual(
    testInfo.project.name === "phone"
      ? ["Review navigator"]
      : ["Review navigator", "Review viewer"],
  );
  for (const clearance of layout.paneAxisClearances) {
    expect(clearance.top).toBeGreaterThanOrEqual(testInfo.project.name === "desktop" ? 7 : 4);
    expect(clearance.bottom).toBeGreaterThanOrEqual(
      testInfo.project.name === "desktop" ? 7 : 4,
    );
  }
  expect(layout.emptyViewerHeaderVisible).toBe(testInfo.project.name !== "phone");
  expect(
    Math.max(...layout.visualControlHeights) -
      Math.min(...layout.visualControlHeights),
  ).toBeLessThanOrEqual(1);
  if (testInfo.project.name !== "desktop") {
    expect(Math.max(...layout.visualControlHeights)).toBeLessThanOrEqual(34);
    expect(Math.min(...layout.directTouchControlHeights)).toBeGreaterThanOrEqual(40);
  }

  const navigatorAxis = taskReview.locator(".task-review-navigator-axis");
  const viewerAxis = taskReview.locator(".task-review-viewer-axis");
  await expect(navigatorAxis.locator(":scope > caffold-segmented-control")).toHaveCount(1);
  await expect(viewerAxis.locator(":scope > caffold-segmented-control")).toHaveCount(1);
  await expect(
    navigatorAxis.locator(":scope > caffold-segmented-control > button"),
  ).toHaveCount(2);
  await expect(
    viewerAxis.locator(":scope > caffold-segmented-control > button"),
  ).toHaveCount(2);
});

test("keeps a 180-file change set inspectable without clipping its identity", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.largeChangeSet = true;
    },
  });
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  await expect(changes.locator('button[data-file-tree-kind="file"]')).toHaveCount(184);
  const longPath = changes.locator(
    'button[data-file-tree-relative-path="generated/deep/review/file-180-with-a-long-review-name.rs"]',
  );
  await expect(longPath).toHaveAttribute(
    "title",
    "generated/deep/review/file-180-with-a-long-review-name.rs",
  );
});

test("scrolls the exact visible Review tree and diff through the workspace root", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const viewport = page.viewportSize();
  await page.setViewportSize({ ...viewport, height: 360 });
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page, {
    configureReview(review) {
      review.largeChangeSet = true;
      review.workingDiffText = Array.from(
        { length: 80 },
        (_, index) => `new planner behavior ${index + 1}`,
      ).join("\n+");
    },
  });
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const treeScroll = taskReview.locator(
    "caffold-git-diff-changes-tree .file-tree-scroll",
  );
  const workspace = page.locator(".task-workspace-surface");
  const selector = page.locator("caffold-scroll-surface-selector > dialog");
  const hud = page.locator(
    "caffold-task-workspace > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await expect.poll(() => treeScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);

  if (testInfo.project.name === "phone") {
    await workspace.focus();
    await page.keyboard.press("s");
    await expect(selector).toBeHidden();
    await expect(hud).toContainText("Scroll: Working tree changes");
    await page.keyboard.press("j");
    await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await treeScroll.evaluate((element) => {
      element.scrollTop = 0;
    });
  }

  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]')
    .click();
  const diffScroll = taskReview.locator(
    "caffold-review-file-viewer:not([hidden]) caffold-diff-viewer .diff-lines",
  );
  await expect(diffScroll).toContainText("new planner behavior 80");
  await expect.poll(() => diffScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);

  await workspace.focus();
  await page.keyboard.press("s");
  if (testInfo.project.name === "phone") {
    await expect(selector).toBeHidden();
    await expect(hud).toContainText("Scroll: planner.rs diff");
  } else {
    await expect(selector).toBeVisible();
    const badges = selector.locator("button[data-scroll-surface-code]");
    await expect(badges).toHaveCount(2);
    expect(new Set(await badges.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")
        .replace(/^[A-Z]+ — /, ""))
    ))).toEqual(new Set(["Working tree changes", "planner.rs diff"]));

    const treeBadge = selector.getByLabel(
      /^[A-Z]+ — Working tree changes$/,
    );
    await treeBadge.click();
    const diffBeforeTreeScroll = await diffScroll.evaluate(
      (element) => element.scrollTop,
    );
    await page.keyboard.press("j");
    await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await diffScroll.evaluate((element) => element.scrollTop)).toBe(
      diffBeforeTreeScroll,
    );
    await page.keyboard.press("Escape");

    await workspace.focus();
    await page.keyboard.press("s");
    await selector.getByLabel(/^[A-Z]+ — planner\.rs diff$/).click();
    await expect(hud).toContainText("Scroll: planner.rs diff");
  }

  const treeBeforeDiffScroll = await treeScroll.evaluate(
    (element) => element.scrollTop,
  );
  await page.keyboard.press("j");
  await expect.poll(() => diffScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(
    treeBeforeDiffScroll,
  );
  await page.keyboard.press("Escape");
  await expect(hud).toBeHidden();
});

test("maps the visible source line when Diff and Source representations switch", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await taskReview
    .locator('caffold-file-navigator button[data-file-tree-path="src/planner.rs"]')
    .click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();

  const viewer = taskReview.locator("caffold-review-file-viewer");
  const viewerAxis = taskReview.locator(
    '.task-review-viewer-axis caffold-segmented-control[data-review-axis="viewer"]',
  );
  const controlMetrics = () => viewerAxis.evaluate((group) => {
    const selected = group.querySelector(
      'button[aria-pressed="true"] > span',
    );
    const groupRect = group.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    return {
      groupLeft: groupRect.left,
      groupRight: groupRect.right,
      groupWidth: groupRect.width,
      selectedLeft: selectedRect.left,
      selectedRight: selectedRect.right,
      selectedOverflow: selected.scrollWidth > selected.clientWidth,
      selectedShadow: getComputedStyle(selected).boxShadow,
    };
  });
  const sourceControl = await controlMetrics();
  expect(sourceControl.selectedLeft).toBeGreaterThanOrEqual(sourceControl.groupLeft - 1);
  expect(sourceControl.selectedRight).toBeLessThanOrEqual(sourceControl.groupRight + 1);
  expect(sourceControl.selectedOverflow).toBe(false);
  expect(sourceControl.selectedShadow).toContain("0px 0px 0px 1px");
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  await expect(viewer.locator("caffold-code-viewer header")).toHaveCount(0);
  const codeScroll = viewer.locator("caffold-code-viewer .code-lines");
  await expect.poll(() => codeScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await expect(page.locator("caffold-scroll-surface-selector > dialog")).toBeHidden();
  const workspaceHud = page.locator(
    "caffold-task-workspace > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await expect(workspaceHud).toContainText("Scroll: planner.rs source");
  await page.keyboard.press("j");
  await expect.poll(() => codeScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(workspaceHud).toBeHidden();
  expect(await viewer.evaluate((element) => element.scrollToLine(60))).toBe(true);
  await expect
    .poll(() => viewer.evaluate((element) => element.visibleLine()))
    .toBeGreaterThan(1);
  const sourceLine = await viewer.evaluate((element) => element.visibleLine());
  expect(sourceLine).toBeLessThanOrEqual(60);

  await taskReview.getByRole("button", { name: "Diff", exact: true }).click();
  const diffControl = await controlMetrics();
  expect(Math.abs(diffControl.groupWidth - sourceControl.groupWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(diffControl.groupRight - sourceControl.groupRight)).toBeLessThanOrEqual(1);
  expect(diffControl.selectedLeft).toBeGreaterThanOrEqual(diffControl.groupLeft - 1);
  expect(diffControl.selectedRight).toBeLessThanOrEqual(diffControl.groupRight + 1);
  expect(diffControl.selectedOverflow).toBe(false);
  expect(diffControl.selectedShadow).toContain("0px 0px 0px 1px");
  await expect(viewer.locator("caffold-diff-viewer")).toBeVisible();
  await expect.poll(() => viewer.evaluate((element) => element.visibleLine())).toBe(60);

  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  const restoredSourceControl = await controlMetrics();
  expect(
    Math.abs(restoredSourceControl.groupRight - sourceControl.groupRight),
  ).toBeLessThanOrEqual(1);
  expect(restoredSourceControl.selectedRight).toBeLessThanOrEqual(
    restoredSourceControl.groupRight + 1,
  );
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  await expect
    .poll(() => viewer.evaluate((element) => element.visibleLine()))
    .toBe(sourceLine);
});

test("rejects a late branch response after returning to the working tree", { tag: "@all-viewports" }, async ({ page }) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  reviewScenario.setCompareDelay("origin/main", 250);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const compareBefore = reviewScenario.gitCompareRequests;
  await selectTaskReviewScope(tasksPage, "branch");
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(compareBefore);
  await selectTaskReviewScope(tasksPage, "working");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  await page.waitForTimeout(300);
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toHaveCount(0);
  await expect(taskReview.locator("caffold-git-diff-changes-tree")).toBeVisible();
});

test("rejects a late compare response after the Branch base changes again", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { reviewScenario, taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await selectTaskReviewScope(tasksPage, "branch");

  const compareTree = taskReview.locator("caffold-git-compare-tree");
  const baseSelect = compareTree.getByLabel("Branch comparison base");
  await expect(baseSelect).toHaveValue("origin/main");
  await baseSelect.evaluate((select) => {
    select.stableBaseSelectorProbe = true;
  });

  reviewScenario.setCompareDelay("origin/release", 250);
  const before = reviewScenario.gitCompareRequests;
  await baseSelect.selectOption("origin/release");
  await expect.poll(() => reviewScenario.gitCompareRequests).toBeGreaterThan(before);
  await baseSelect.selectOption("main");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?scope=branch&base=main`,
  );
  await page.waitForTimeout(300);

  await expect(baseSelect).toHaveValue("main");
  await expect(
    compareTree.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toBeAttached();
  await expect(
    compareTree.locator('button[data-file-tree-path="src/release.rs"]'),
  ).toHaveCount(0);
  expect(await baseSelect.evaluate((select) => select.stableBaseSelectorProbe)).toBe(true);
});

async function emitGitRefsChanged(page) {
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    if (!source) {
      throw new Error("Missing Task Review watch source");
    }
    source.emit("change", {
      revision: Date.now(),
      paths: [],
      gitStatusChanged: false,
      gitRefsChanged: true,
      overflow: false,
    });
  });
}
