import { expect, test } from "@playwright/test";
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

test("keeps the selected Review file identity stable while content loads", async ({
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

test("normalizes and compacts shared file-tree statuses", async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page, {
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

test("reviews working tree changes through the canonical Review route", async ({
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

test("keeps selectedPath while scope, navigator, and viewer switch independently", async ({
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
    'caffold-task-detail-summary button[data-review-scope="branch"]',
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

test("supports every scope navigator and viewer combination", async ({ page }) => {
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
          tasksPage.locator('button[data-review-scope="branch"]'),
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

test("preserves valid Task Review base routes and falls back for missing refs", async ({
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

test("selects local and remote Branch bases without replacing the picker", async ({
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

test("keeps equivalent Branch header refreshes mutation-free", async ({ page }) => {
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

test("falls back when the selected Branch base disappears", async ({ page }) => {
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

test("keeps compact review controls and available panes inside the workspace", async ({
  page,
}, testInfo) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  const branchMode = tasksPage.locator(
    'caffold-task-detail-summary button[data-review-scope="branch"]',
  );
  const workingMode = tasksPage.locator(
    'caffold-task-detail-summary button[data-review-scope="working"]',
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
      ".task-review-navigator-axis .task-review-axis-options",
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
    .locator('button[data-review-axis="navigator"][data-review-value="files"]')
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
      ".task-review-navigator-axis .task-review-axis-options",
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
    .locator('button[data-review-axis="navigator"][data-review-value="changes"]')
    .click();
  await expect(
    tasksPage.locator("caffold-task-detail-summary .task-mode-switch button"),
  ).toHaveCount(3);
  await expect(taskReview.locator(".task-review-toolbar")).toHaveCount(0);

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
      layoutStartsAtWorkspaceTop:
        Math.abs(
          element.querySelector(".task-review-layout").getBoundingClientRect().top -
            workspaceRect.top,
        ) <= 1,
      visiblePaneAxes: [...element.querySelectorAll(".task-review-pane-axis")]
        .filter((axis) => axis.getClientRects().length > 0)
        .map((axis) => axis.getAttribute("aria-label")),
      paneAxisClearances: [...element.querySelectorAll(".task-review-pane-axis")]
        .filter((axis) => axis.getClientRects().length > 0)
        .map((axis) => {
          const axisBounds = axis.getBoundingClientRect();
          const controlsBounds = axis
            .querySelector(".task-review-axis-options")
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
          ".task-review-axis-options",
        ),
      ]
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => control.getBoundingClientRect().height),
      directTouchControlHeights: [
        ...element.querySelectorAll(".task-review-axis-options button"),
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

  for (const axis of await taskReview.locator(".task-review-pane-axis").all()) {
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

test("maps the visible source line when Diff and Source representations switch", async ({
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
    ".task-review-viewer-axis .task-review-axis-options",
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
  expect(sourceControl.selectedShadow).not.toContain("0px 0px 0px 1px");
  await expect(viewer.locator("caffold-code-viewer")).toBeVisible();
  await expect(viewer.locator("caffold-code-viewer header")).toHaveCount(0);
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
  expect(diffControl.selectedShadow).not.toContain("0px 0px 0px 1px");
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

test("rejects a late branch response after returning to the working tree", async ({ page }) => {
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

test("rejects a late compare response after the Branch base changes again", async ({
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
