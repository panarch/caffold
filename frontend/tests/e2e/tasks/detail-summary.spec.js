import { expect, test } from "@playwright/test";
import {
  activateActionHintIntoPopover,
  popoverActionHintDialog,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { elementHandles } from "../support/element-handles.js";
import {
  activeListTask,
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  createdTaskResponse,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

// What the Lucide stub in browser-defaults draws for the icons Task details
// actions show.
const PIN_ICON = 'svg path[d^="M9 10.76"]';
const PIN_OFF_ICON = 'svg path[d="m2 2 20 20"]';
const SPLIT_ICON = 'svg path[d="M16 3h5v5"]';
const ARROW_RIGHT_ICON = 'svg path[d="m12 5 7 7-7 7"]';
const BUSY_ICON = '.task-detail-action-icon.is-busy svg path[d="M21 12a9 9 0 1 1-6.2-8.6"]';
// And for the view switch's choices.
const VIEW_ICONS = {
  conversation: 'svg path[d^="M22 17a2 2"]',
  working: 'svg path[d="M9 10h6"]',
  branch: 'svg circle[cx="18"]',
  review: 'svg path[d="m21 21-1.9-1.9"]',
};

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

function summaryTask(threadId, title, rootPath, recencyMs) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath,
      branch: "main",
      headSha: "0123456789abcdef",
      relativeCwd: "",
      linked: false,
    },
    createdMs: recencyMs,
    updatedMs: recencyMs,
    recencyMs,
    lastEventSummary: `${title} preview`,
  };
}

function summaryDetail(task, revision = 1, provider = "codex") {
  return {
    provider,
    threadId: task.threadId,
    syncState: "ready",
    revision,
    eventRevision: revision,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    eventsRange: { from: null, to: null },
    historyLoading: false,
    permissionMode: null,
    model: null,
    reasoningEffort: null,
  };
}

async function emitSummarySync(page, threadId, detail, reason) {
  await page.evaluate(
    ({ threadId, detail, reason }) => {
      const source = window.__taskSummaryEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        detail,
        reason,
      });
    },
    { threadId, detail, reason },
  );
}

// The summary and its Task details parts, each drawn in its own root.
async function summaryNodes(summary) {
  const [info, infoButton, infoPopover, infoActions, forkButton, archiveButton] =
    await elementHandles(summary, [
      "caffold-task-detail-info",
      ".task-detail-info-button",
      ".task-detail-popover",
      "caffold-task-detail-info-actions",
      '[data-task-info-action="fork"]',
      '[data-task-info-action="archive"]',
    ]);
  return {
    owner: await summary.elementHandle(),
    info,
    infoButton,
    infoPopover,
    infoActions,
    forkButton,
    archiveButton,
  };
}

async function summaryNodeState(page) {
  return page.evaluate((current) => {
    const nodes = window.__taskSummaryNodes;
    return {
      owner: nodes.owner === current.owner,
      info: nodes.info === current.info,
      infoButton: nodes.infoButton === current.infoButton,
      infoPopover: nodes.infoPopover === current.infoPopover,
      infoActions: nodes.infoActions === current.infoActions,
      forkButton: nodes.forkButton === current.forkButton,
      archiveButton: nodes.archiveButton === current.archiveButton,
      infoOpen: nodes.infoPopover.matches(":popover-open"),
    };
  }, await summaryNodes(page.locator("caffold-task-detail-summary")));
}

const stableSummaryNodes = {
  owner: true,
  info: true,
  infoButton: true,
  infoPopover: true,
  infoActions: true,
  forkButton: true,
  archiveButton: true,
};

async function installSummaryFixture(page, tasks) {
  await installEventSourceMock(page, {
    registryKey: "__taskSummaryEventSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: activeTaskProjection(tasks),
    }),
  );
  for (const task of tasks) {
    await page.route(
      new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`),
      (route) => route.fulfill({ json: summaryDetail(task) }),
    );
  }
}

test("keeps long Task titles clipped in the header and readable in Info", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_long_title";
  const title =
    "Review the complete canonical Task title across desktop, foldable, and phone layouts while keeping every diagnostic value available without crowding the header controls";
  const task = {
    ...summaryTask(threadId, title, "repo-long-title", 100),
    worktree: null,
  };
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  const heading = summary.locator(".task-detail-heading > h2");
  // The summary lays its parts into the header and has no box of its own.
  await expect(heading).toBeVisible();
  await expect(summary.locator(".task-detail-heading > *")).toHaveCount(1);
  await expect(heading).toHaveText(title);
  await expect
    .poll(() =>
      heading.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);

  const headerLayout = await summary.evaluate((element) => {
    const heading = element.shadowRoot.querySelector(".task-detail-heading");
    const right = element.shadowRoot.querySelector(".task-detail-right");
    return {
      headingRight: heading.getBoundingClientRect().right,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      rightLeft: right.getBoundingClientRect().left,
    };
  });
  expect(headerLayout.noHorizontalOverflow).toBe(true);
  if (testInfo.project.name !== "phone") {
    expect(headerLayout.headingRight).toBeLessThanOrEqual(headerLayout.rightLeft);
  }

  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");
  const taskValue = popover.locator('[data-task-info-field="title"]');
  await expect(popover).toBeVisible();
  await expect(taskValue).toHaveText(title);
  await expect(popover.locator('[data-task-info-field="status"]')).toHaveText("idle");
  await expect(popover.locator('[data-task-info-field="thread"]')).toHaveText(
    threadId,
  );
  // A folder outside Git reads as its name alone, with no branch.
  const location = popover.locator('[data-task-info-field="location"]');
  await expect(location.locator(".task-detail-location-repository")).toHaveText(
    "repo-long-title",
  );
  await expect(location.locator(".task-detail-location-branch")).toHaveCount(0);
  await expect(location.locator(".task-detail-location-worktree")).toHaveCount(0);
  await expect(popover.locator('[data-task-info-field="claude-config-dir"]')).toHaveCount(0);
  await expect
    .poll(() =>
      taskValue.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].filter(
          ({ width, height }) => width > 0 && height > 0,
        ).length;
      }),
    )
    .toBeGreaterThan(1);
  await expect
    .poll(() =>
      taskValue.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  await captureReviewScreenshot(page, testInfo, "tasks-summary-long-title-info");
});

test("the view switch names each view beside its icon where the header has room and shows the icons alone where it is narrow", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_view_switch";
  const task = summaryTask(threadId, "Add a dark theme to Settings", "repo-view-switch", 100);
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const header = page.locator(".detail-layout-summary");
  const viewSwitch = header.locator("caffold-segmented-control[data-detail-view-switch]");
  await expect(viewSwitch).toBeVisible();
  for (const value of ["conversation", "working", "branch"]) {
    await expect(
      viewSwitch.locator(`button[data-segmented-value="${value}"]`).locator(VIEW_ICONS[value]),
    ).toHaveCount(1);
  }
  // Only the desktop header has room for the labels beside the title.
  const shown = await viewSwitch
    .locator(".segmented-choice-label")
    .evaluateAll((labels) => labels.map((label) => getComputedStyle(label).display !== "none"));
  expect(shown).toEqual(Array(3).fill(testInfo.project.name === "desktop"));
  await expect(viewSwitch.getByRole("button", { name: "Working Tree", exact: true })).toBeVisible();
  // Where the switch shares the title's row, the title keeps 12rem.
  if (testInfo.project.name !== "phone") {
    const titleRem = await header
      .locator("caffold-task-detail-summary .task-detail-heading")
      .evaluate(
        (heading) =>
          heading.getBoundingClientRect().width /
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
    expect(titleRem).toBeGreaterThanOrEqual(12);
  }
});

test("the view switch of a Task outside Git offers Review with its icon", { tag: "@server-steady" }, async ({
  page,
}) => {
  const threadId = "thread_summary_view_switch_outside_git";
  const task = {
    ...summaryTask(threadId, "Draft the launch announcement", "launch", 100),
    worktree: null,
  };
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const viewSwitch = page.locator(".detail-layout-summary caffold-segmented-control[data-detail-view-switch]");
  await expect(viewSwitch.locator("button")).toHaveText(["Conversation", "Review"]);
  await expect(viewSwitch.locator('button[data-segmented-value="conversation"]').locator(VIEW_ICONS.conversation)).toHaveCount(1);
  await expect(viewSwitch.locator('button[data-segmented-value="review"]').locator(VIEW_ICONS.review)).toHaveCount(1);
});

test("shows the config directory a Claude Task runs under in Task details", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_claude_config_dir";
  const configDir =
    "/Users/someone/Library/Application Support/Claude Accounts/work-account-with-a-long-name/.claude";
  const task = {
    ...summaryTask(threadId, "Work account Task", "repo-claude", 100),
    worktree: null,
    claudeConfigDir: configDir,
  };
  await installEventSourceMock(page, {
    registryKey: "__taskSummaryEventSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: summaryDetail(task, 1, "claude") }),
  );

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task, 1, "claude"));
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");
  const value = popover.locator('[data-task-info-field="claude-config-dir"]');
  const row = popover.locator(
    '.task-detail-meta-line:has([data-task-info-field="claude-config-dir"])',
  );

  await expect(row).toBeVisible();
  await expect(row.locator(".task-detail-meta-name")).toHaveText("Claude config");
  await expect(value).toHaveText(configDir);
  await expect(row.locator("caffold-task-detail-info-copy-value")).toHaveCount(1);
  await expect
    .poll(() =>
      value.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await captureReviewScreenshot(page, testInfo, "tasks-summary-claude-config-dir-info");
});

// A Task in a worktree Caffold made, working in a folder inside it, on a
// branch whose name is longer than the popover is wide, served from the
// filesystem root so its paths read from `/` and `~`.
const WORKTREE_ROOT =
  "Users/me/Library/Application Support/Caffold/data/worktrees/1737fabc-38e0-4dee-8d60-d875e0cc5f31";
const LONG_BRANCH = "try-ai-text-detectors-on-every-review-surface-before-release";

function worktreeTask(threadId) {
  return {
    ...summaryTask(threadId, "Try the AI text detectors", WORKTREE_ROOT, 100),
    cwd: `/${WORKTREE_ROOT}/frontend`,
    cwdPath: `${WORKTREE_ROOT}/frontend`,
    relativeCwd: "frontend",
    worktree: {
      rootPath: WORKTREE_ROOT,
      repositoryRootPath: "Users/me/Workspace/rust/codger",
      branch: LONG_BRANCH,
      headSha: "1290ff05aa0011",
      relativeCwd: "frontend",
      linked: true,
    },
  };
}

async function serveFromFilesystemRoot(page) {
  await page.route(/\/api\/health(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), root: "/", homePath: "Users/me" },
    });
  });
}

test("keeps Task details one width, wrapping a long branch and long paths inside it", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const task = worktreeTask("thread_summary_location_layout");
  await serveFromFilesystemRoot(page);
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");
  const location = popover.locator('[data-task-info-field="location"]');
  await expect(location.locator(".task-detail-location-repository")).toHaveText(
    "codger/frontend",
  );
  await expect(location.locator(".task-detail-location-branch")).toHaveText(LONG_BRANCH);
  await expect(location.locator(".task-detail-location-worktree")).toHaveText("worktree");
  await location.click();
  await expect(popover.locator(".task-detail-path-value")).toHaveText([
    "~/Workspace/rust/codger",
    `~/${WORKTREE_ROOT.slice("Users/me/".length)}`,
    `~/${WORKTREE_ROOT.slice("Users/me/".length)}/frontend`,
  ]);

  const layout = await popover.evaluate((element) => {
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const content = {
      left: box.left + Number.parseFloat(style.paddingLeft),
      right: box.right - Number.parseFloat(style.paddingRight),
    };
    const lines = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set(
        [...range.getClientRects()]
          .filter(({ width, height }) => width > 0 && height > 0)
          .map(({ top }) => Math.round(top)),
      ).size;
    };
    const location = element.querySelector(".task-detail-location");
    const chevron = location
      .querySelector(".task-detail-location-chevron")
      .getBoundingClientRect();
    const words = [
      ...element.querySelectorAll(
        ".task-detail-location-parts > span, .task-detail-path-value, .task-detail-meta-line > span",
      ),
    ];
    const copies = [...element.querySelectorAll(".task-detail-path caffold-task-detail-info-copy-value")]
      .map((copy) => copy.getBoundingClientRect());
    return {
      rootFontSize,
      viewportWidth: document.documentElement.clientWidth,
      left: box.left,
      width: box.width,
      scrollsSideways: element.scrollWidth > element.clientWidth,
      wordsInside: words.every((word) => {
        const rect = word.getBoundingClientRect();
        return rect.left >= content.left - 0.5 && rect.right <= content.right + 0.5 &&
          word.scrollWidth <= word.clientWidth + 1;
      }),
      chevronAtEnd: Math.abs(chevron.right - location.getBoundingClientRect().right) <=
        Number.parseFloat(getComputedStyle(location).paddingRight) + 0.5,
      copiesAtEnd: copies.every((copy) => copy.right <= content.right + 0.5),
      branchLines: lines(element.querySelector(".task-detail-location-branch")),
      worktreeLines: lines(
        element.querySelector('[data-task-info-path="worktree"] .task-detail-path-value'),
      ),
    };
  });
  if (testInfo.project.name === "phone") {
    // As Note details does: from the left inset, no wider than the viewport
    // less 1.5rem.
    expect(Math.abs(layout.left - 0.5 * layout.rootFontSize)).toBeLessThan(1);
    expect(
      Math.abs(layout.width - (layout.viewportWidth - 1.5 * layout.rootFontSize)),
    ).toBeLessThan(1);
  } else {
    expect(Math.abs(layout.width - 28 * layout.rootFontSize)).toBeLessThan(1);
  }
  expect(layout.scrollsSideways).toBe(false);
  expect(layout.wordsInside).toBe(true);
  expect(layout.chevronAtEnd).toBe(true);
  expect(layout.copiesAtEnd).toBe(true);
  expect(layout.worktreeLines).toBeGreaterThan(1);
  if (testInfo.project.name === "phone") {
    expect(layout.branchLines).toBeGreaterThan(1);
  }
  await captureReviewScreenshot(page, testInfo, "tasks-summary-location-paths");
});

test("unfolds the paths from the location line and copies each value, folding again once the popover closes", { tag: "@server-steady" }, async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const task = worktreeTask("thread_summary_location_copy");
  await serveFromFilesystemRoot(page);
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  const detailsButton = summary.getByRole("button", { name: /Task details/ });
  await detailsButton.click();
  const popover = summary.locator(".task-detail-popover");
  const location = popover.locator('[data-task-info-field="location"]');
  const paths = popover.locator(".task-detail-paths");
  await expect(location).toHaveAttribute("aria-expanded", "false");
  await expect(paths).toBeHidden();

  await location.click();
  await expect(location).toHaveAttribute("aria-expanded", "true");
  await expect(paths).toBeVisible();
  const worktree = popover.locator('[data-task-info-path="worktree"]');
  const copyWorktree = worktree.getByRole("button", { name: "Copy worktree path" });
  await copyWorktree.click();
  await expect(worktree.locator('.task-detail-copy[data-copy-state="copied"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `~/${WORKTREE_ROOT.slice("Users/me/".length)}`,
  );

  await popover.getByRole("button", { name: "Copy Thread ID" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    task.threadId,
  );

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await detailsButton.click();
  await expect(location).toHaveAttribute("aria-expanded", "false");
  await expect(paths).toBeHidden();
});

test("reaches the location line and each Copy from the keyboard inside Task details", { tag: "@server-steady" }, async ({
  page,
}) => {
  const task = worktreeTask("thread_summary_location_keys");
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  await activateActionHintIntoPopover(page, /Task details, idle$/);
  const popover = page.locator("caffold-task-detail-summary .task-detail-popover");
  const hint = popoverActionHintDialog(page);
  await expect(hint.getByRole("button", { name: / — Copy Thread ID$/ })).toBeVisible();
  const showPaths = hint.getByRole("button", { name: / — Show paths$/ });
  const code = await showPaths.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());
  await expect(popover.locator(".task-detail-paths")).toBeVisible();

  await popover.locator('[data-task-info-field="location"]').focus();
  await page.keyboard.press("f");
  await expect(hint).toBeVisible();
  for (const name of ["Repository path", "Worktree path", "Working directory path"]) {
    await expect(
      hint.getByRole("button", { name: new RegExp(` — Copy ${name.toLowerCase()}$`) }),
    ).toBeVisible();
  }
  await expect(hint.getByRole("button", { name: / — Hide paths$/ })).toBeVisible();
});

test("keeps the task info leaf and popover stable across canonical sync", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_stable";
  const task = summaryTask(threadId, "Stable summary", "repo-stable", 100);
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  const detailHeader = page.locator(".detail-layout-summary");
  await expect(summary.locator(".task-detail-heading")).toBeVisible();
  await expect(
    detailHeader.locator("caffold-task-detail-git, caffold-task-detail-github"),
  ).toHaveCount(2);
  const taskDetailsButton = summary.getByRole("button", {
    name: /Task details/,
  });
  const taskDetailsPopover = summary.locator(".task-detail-popover");
  await page.evaluate((nodes) => {
    window.__taskSummaryNodes = nodes;
  }, await summaryNodes(summary));

  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeVisible();
  await expect(
    taskDetailsPopover.locator('[data-task-info-field="title"]'),
  ).toHaveText("Stable summary");
  await expect(
    taskDetailsPopover.locator('[data-task-info-action="fork"]'),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("caffold:icons-ready"));
  });
  await expect(taskDetailsButton.locator(".task-action-icon")).toHaveCount(1);
  await expect
    .poll(() => summaryNodeState(page))
    .toEqual({ ...stableSummaryNodes, infoOpen: true });

  const activeTask = {
    ...task,
    ...canonicalTaskState("active", {
      turnId: "turn_summary_live",
      latestTurnStatus: "inProgress",
    }),
    title: "Canonical summary update",
    updatedMs: task.updatedMs + 1,
    recencyMs: task.recencyMs + 1,
  };
  await emitSummarySync(
    page,
    threadId,
    summaryDetail(activeTask, 2),
    "summary-state-update",
  );
  await expect(summary.locator("h2")).toHaveText("Canonical summary update");
  await expect(
    taskDetailsPopover.locator('[data-task-info-field="title"]'),
  ).toHaveText("Canonical summary update");
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: active");
  await expect(
    taskDetailsPopover.locator('[data-task-info-field="status"]'),
  ).toHaveText("active");
  await expect(
    taskDetailsPopover.locator('[data-task-info-action="archive"]'),
  ).toBeDisabled();
  await expect(
    taskDetailsPopover.locator('[data-task-info-action="fork"]'),
  ).toBeDisabled();
  await expect(
    taskDetailsPopover.locator('[data-task-info-action="fork"]'),
  ).toHaveCSS("cursor", "default");
  // A row that cannot be used now says why where it says what it does.
  await expect(
    taskDetailsPopover.locator(
      '[data-task-info-action="fork"] .task-detail-action-description',
    ),
  ).toHaveText("Available when the Task is idle.");
  await expect(
    taskDetailsPopover.locator(
      '[data-task-info-action="archive"] .task-detail-action-description',
    ),
  ).toHaveText("Available when the Task is idle.");
  await expect
    .poll(() => summaryNodeState(page))
    .toEqual({ ...stableSummaryNodes, infoOpen: true });

  const [buttonBox, popoverBox] = await Promise.all([
    taskDetailsButton.boundingBox(),
    taskDetailsPopover.boundingBox(),
  ]);
  expect(buttonBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox.x).toBeGreaterThanOrEqual(7);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
    page.viewportSize().width - 7,
  );
  expect(popoverBox.y).toBeGreaterThanOrEqual(
    buttonBox.y + buttonBox.height + 4,
  );
  expect(buttonBox.x + buttonBox.width / 2).toBeGreaterThanOrEqual(
    popoverBox.x - 1,
  );
  expect(buttonBox.x + buttonBox.width / 2).toBeLessThanOrEqual(
    popoverBox.x + popoverBox.width + 1,
  );
  const forkActionVisible = await taskDetailsPopover.evaluate((popover, action) => {
    const actionBox = action.getBoundingClientRect();
    const popoverBox = popover.getBoundingClientRect();
    return {
      bottom: actionBox.bottom <= popoverBox.bottom + 1,
      top: actionBox.top >= popoverBox.top - 1,
    };
  }, await taskDetailsPopover.locator('[data-task-info-action="fork"]').elementHandle());
  expect(forkActionVisible).toEqual({ bottom: true, top: true });
  await captureReviewScreenshot(page, testInfo, "tasks-summary-live-popover");
});

test("offers Git and GitHub from the listed Section before Task details arrive", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const repositoryTask = summaryTask("thread_summary_repository", "Repository work", "repo-header", 200);
  const folderTask = {
    ...summaryTask("thread_summary_folder", "Folder work", "notes-header", 100),
    worktree: null,
  };
  await installSummaryFixture(page, [repositoryTask, folderTask]);
  // Details arrive only when the test hands them over, whether the page waits
  // on the stream or has fallen back to reading them.
  const handedOver = new Set();
  const heldReads = [];
  await page.route(/\/api\/tasks\/thread_summary_(?:repository|folder)(?:\?|$)/, (route) => {
    const task = [repositoryTask, folderTask].find((candidate) =>
      route.request().url().includes(candidate.threadId));
    if (handedOver.has(task.threadId)) {
      return route.fulfill({ json: summaryDetail(task) });
    }
    heldReads.push({ route, task });
  });
  const handOverDetails = async (task) => {
    handedOver.add(task.threadId);
    for (const read of heldReads.filter((held) => held.task === task)) {
      await read.route.fulfill({ json: summaryDetail(task) });
    }
    await page.evaluate(
      (detail) => window.__caffoldTaskSse.bootstrap(detail),
      summaryDetail(task),
    );
  };
  const header = page.locator(".detail-layout-summary");
  const heading = header.locator("caffold-task-detail-summary .task-detail-heading > h2");
  const viewSwitch = header.locator("caffold-segmented-control[data-detail-view-switch]");
  const git = header.locator("caffold-task-detail-git");
  const github = header.locator("caffold-task-detail-github");
  const gitButton = git.locator(":scope > .task-git-button");
  const githubButton = github.locator(":scope > .task-github-button");
  const headerHeight = () =>
    header.evaluate((element) => element.getBoundingClientRect().height);

  await page.goto(`/tasks/${repositoryTask.threadId}`);
  await expect(heading).toHaveText("Repository work");
  await expect(viewSwitch).toBeHidden();
  await expect(gitButton).toBeVisible();
  await expect(gitButton).toBeDisabled();
  await expect(githubButton).toBeDisabled();
  const gitBoxBeforeDetails = await gitButton.boundingBox();
  const repositoryHeightBeforeDetails = await headerHeight();
  await captureReviewScreenshot(page, testInfo, "tasks-header-repository-before-details");
  await handOverDetails(repositoryTask);
  await expect(viewSwitch).toBeVisible();
  await expect(gitButton).toBeEnabled();
  await expect(githubButton).toBeEnabled();
  expect(await gitButton.boundingBox()).toEqual(gitBoxBeforeDetails);
  expect(await headerHeight()).toBe(repositoryHeightBeforeDetails);
  await captureReviewScreenshot(page, testInfo, "tasks-header-repository");

  await page.goto(`/tasks/${folderTask.threadId}`);
  await expect(heading).toHaveText("Folder work");
  await expect(viewSwitch).toBeHidden();
  await expect(git).toBeHidden();
  await expect(github).toBeHidden();
  const folderHeightBeforeDetails = await headerHeight();
  await captureReviewScreenshot(page, testInfo, "tasks-header-folder-before-details");
  await handOverDetails(folderTask);
  await expect(viewSwitch).toBeVisible();
  await expect(git).toBeHidden();
  await expect(github).toBeHidden();
  // The view switch arrives with the details into a row already kept for it.
  expect(await headerHeight()).toBe(folderHeightBeforeDetails);
  await captureReviewScreenshot(page, testInfo, "tasks-header-folder");
});

for (const provider of ["codex", "claude", "grok"]) {
test(`forks an idle ${provider} Task and opens the distinct child`, { tag: "@server-changes" }, async ({
  page,
}) => {
  const sourceThreadId = "thread_summary_fork_source";
  const childThreadId = "thread_summary_fork_child";
  const rootPath = "repo-fork";
  const source = {
    ...summaryTask(sourceThreadId, "Source task", rootPath, 100),
    worktree: null,
  };
  const child = {
    ...summaryTask(childThreadId, "Fork of Source task", rootPath, 101),
    worktree: null,
  };
  const childDetail = { ...summaryDetail(child), provider };
  const childFork = createdTaskResponse(childDetail, {
    section: {
      id: "fixture-section-1",
      name: rootPath,
      repository: false,
    },
    beforeSectionId: null,
    beforeThreadId: sourceThreadId,
  });
  let releaseFork;
  const forkGate = new Promise((resolve) => {
    releaseFork = resolve;
  });
  let observeFork;
  const forkObserved = new Promise((resolve) => {
    observeFork = resolve;
  });
  let requestCount = 0;
  await installSummaryFixture(page, [source]);
  await page.route(`**/api/tasks/${sourceThreadId}/fork`, async (route) => {
    requestCount += 1;
    expect(route.request().method()).toBe("POST");
    observeFork();
    await forkGate;
    await route.fulfill({ json: childFork });
  });
  await page.route(
    new RegExp(`/api/tasks/${childThreadId}(?:\\?|$)`),
    (route) => route.fulfill({ json: childDetail }),
  );

  await page.goto(`/tasks/${sourceThreadId}`);
  await emitTaskDetailBootstrap(page, { ...summaryDetail(source), provider });
  const summary = page.locator("caffold-task-detail-summary");
  await activateActionHintIntoPopover(page, /Task details, idle$/);
  const popover = summary.locator(".task-detail-popover");
  const forkButton = popover.locator('[data-task-info-action="fork"]');
  await expect(forkButton).toBeEnabled();
  await expect(forkButton.locator(SPLIT_ICON)).toHaveCount(1);

  const hint = popoverActionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Archive task$/ }),
  ).toBeVisible();
  const forkHint = hint.getByRole("button", { name: / — Fork task$/ });
  const forkCode = await forkHint.getAttribute("data-action-hint-code");
  expect(forkCode).toBeTruthy();
  await page.keyboard.type(forkCode.toLowerCase());
  await forkObserved;
  await expect(forkButton).toBeDisabled();
  await expect(forkButton.locator(".task-detail-action-label")).toHaveText("Forking...");
  await expect(forkButton.locator(BUSY_ICON)).toHaveCount(1);
  await expect(forkButton.locator(".task-detail-action-icon")).toHaveCSS(
    "animation-name",
    "caffold-busy-spin",
  );
  await expect(
    popover.locator('[data-task-info-action="archive"]'),
  ).toBeDisabled();
  releaseFork();

  await expect(page).toHaveURL(new RegExp(`/tasks/${childThreadId}$`));
  await expect(page.locator("caffold-task-detail-summary h2")).toHaveText(
    "Fork of Source task",
  );
  await expect(
    page.locator("caffold-task-navigator .task-row-title"),
  ).toHaveText(["Fork of Source task", "Source task"]);
  expect(requestCount).toBe(1);
});

}

test("pins and unpins the open Task, holding the button until the list reads it back", { tag: "@server-changes" }, async ({
  page,
}) => {
  const rootPath = "repo-pin";
  const other = summaryTask("thread_pin_other", "Other task", rootPath, 200);
  const target = summaryTask("thread_pin_target", "Pinned task", rootPath, 100);
  const state = { pinned: [], order: [other, target] };
  const requests = [];
  let holdList = null;
  await installSummaryFixture(page, [other, target]);
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    await holdList;
    await route.fulfill({
      json: {
        pinned: state.pinned.map((task) => ({
          sectionId: "section-pin",
          task: activeListTask(task),
        })),
        sections: [
          {
            id: "section-pin",
            name: rootPath,
            repository: true,
            tasks: state.order.map(activeListTask),
          },
        ],
        unsectioned: [],
      },
    });
  });
  let releasePin;
  const pinGate = new Promise((resolve) => {
    releasePin = resolve;
  });
  await page.route(/\/api\/tasks\/thread_pin_target\/(pin|unpin)$/, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    requests.push(action);
    if (action === "pin") {
      await pinGate;
      state.order = state.order.filter((task) => task !== target);
      state.pinned = [target];
    } else {
      state.pinned = [];
      state.order = [target, ...state.order];
    }
    await route.fulfill({
      json: { threadId: target.threadId, pinned: action === "pin", changed: true },
    });
  });

  await page.goto(`/tasks/${target.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(target));
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");
  const pin = popover.locator(
    '[data-task-info-action="pin"], [data-task-info-action="unpin"]',
  );
  const pinLabel = pin.locator(".task-detail-action-label");
  await expect(pin.locator(".task-detail-action-description")).toHaveText(
    "Keep it at the top of the Task list.",
  );
  await expect(pinLabel).toHaveText("Pin task");
  await expect(pin.locator(PIN_ICON)).toHaveCount(1);

  let releaseList;
  holdList = new Promise((resolve) => {
    releaseList = resolve;
  });
  await pin.click();
  await expect.poll(() => requests).toEqual(["pin"]);
  await expect(pinLabel).toHaveText("Pinning...");
  await expect(pin).toBeDisabled();
  await expect(pin.locator(BUSY_ICON)).toHaveCount(1);
  const listRead = page.waitForRequest(/\/api\/tasks(?:\?|$)/);
  releasePin();
  await listRead;
  await expect(pinLabel).toHaveText("Pinning...");
  releaseList();

  await expect(pinLabel).toHaveText("Unpin task");
  await expect(pin).toBeEnabled();
  await expect(pin.locator(PIN_OFF_ICON)).toHaveCount(1);
  await expect(pin.locator(".task-detail-action-description")).toHaveText(
    "Return it to its Section.",
  );
  const list = page.locator("caffold-active-task-list");
  const pinnedGroup = list.locator(".task-repository-group[data-task-pinned]");
  await expect(pinnedGroup.locator(".task-row-title")).toHaveText(["Pinned task"]);
  const section = list.locator(
    '.task-repository-group[data-task-repository-key="section-pin"]',
  );
  await expect(section.locator(".task-row-title")).toHaveText(["Other task"]);

  await pin.click();
  await expect(pinLabel).toHaveText("Pin task");
  await expect(pin.locator(PIN_ICON)).toHaveCount(1);
  await expect(pinnedGroup).toHaveCount(0);
  await expect(section.locator(".task-row-title")).toHaveText([
    "Pinned task",
    "Other task",
  ]);
  expect(requests).toEqual(["pin", "unpin"]);
});

test("leaves Fork out of an Antigravity Task's details", { tag: "@server-steady" }, async ({ page }) => {
  const threadId = "thread_summary_antigravity_fork";
  const task = {
    ...summaryTask(threadId, "Antigravity source", "repo-antigravity", 100),
    worktree: null,
  };
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task, 1, "antigravity"));
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");

  await expect(popover.locator('[data-task-info-action="archive"]')).toBeEnabled();
  await expect(popover.locator('[data-task-info-action="fork"]')).toHaveCount(0);
});

test("offers Open forked task under a dimmed Fork when the creation response reports unavailable details, and opens the claimed fork", { tag: "@server-steady" }, async ({ page }) => {
  const task = summaryTask("fork_response_source", "Source", "repo", 100);
  const child = summaryTask("fork_response_child", "Fork of Source", "repo", 101);
  await installSummaryFixture(page, [task]);
  let requests = 0;
  await page.route(`**/api/tasks/${task.threadId}/fork`, route => {
    requests++;
    return route.fulfill({status:409,json:{error:{code:"task_fork_created",message:"The fork was created; details are temporarily unavailable.",createdTaskId:child.threadId}}});
  });
  await page.route(`**/api/tasks/${child.threadId}`, route => route.fulfill({json:summaryDetail(child)}));
  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", {name:/Task details/}).click();
  const popover = summary.locator(".task-detail-popover");
  const fork = popover.locator('[data-task-info-action="fork"]');
  await fork.click();
  const under = popover.locator('[data-task-info-action="fork"] + .task-detail-action-under');
  const open = under.getByRole("link", { name: "Open forked task" });
  await expect(open).toHaveAttribute("href", `/tasks/${child.threadId}`);
  await expect(open.locator(ARROW_RIGHT_ICON)).toHaveCount(1);
  // Fork stays in its place, dimmed, so the list does not move.
  await expect(fork).toBeDisabled();
  await expect(fork.locator(".task-detail-action-label")).toHaveText("Fork task");
  const error = under.locator(".task-detail-fork-error");
  await expect(error).toHaveText("The fork was created; details are temporarily unavailable.");
  expect(await error.evaluate(
    (element, link) => Boolean(element.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING),
    await open.elementHandle(),
  )).toBe(true);
  // The link is the small bordered button, not underlined.
  const look = await open.evaluate((element) => {
    const style = getComputedStyle(element);
    const frame = getComputedStyle(element, "::before");
    return {
      textDecorationLine: style.textDecorationLine,
      frame: [frame.borderTopWidth, frame.borderTopLeftRadius],
    };
  });
  expect(look).toEqual({ textDecorationLine: "none", frame: ["1px", "5px"] });
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${child.threadId}$`));
  expect(requests).toBe(1);
});

test("opens the fork it made when the screen could not open it, without forking again", { tag: "@server-steady" }, async ({
  page,
}) => {
  const rootPath = "repo-fork-handoff";
  const source = {
    ...summaryTask("thread_fork_handoff_source", "Source task", rootPath, 100),
    worktree: null,
  };
  const child = {
    ...summaryTask("thread_fork_handoff_child", "Fork of Source task", rootPath, 101),
    worktree: null,
  };
  const childDetail = summaryDetail(child);
  let requests = 0;
  await installSummaryFixture(page, [source]);
  await page.route(`**/api/tasks/${source.threadId}/fork`, (route) => {
    requests += 1;
    return route.fulfill({
      json: createdTaskResponse(childDetail, {
        section: { id: "fixture-section-1", name: rootPath, repository: false },
        beforeSectionId: null,
        beforeThreadId: source.threadId,
      }),
    });
  });
  await page.route(
    new RegExp(`/api/tasks/${child.threadId}(?:\\?|$)`),
    (route) => route.fulfill({ json: childDetail }),
  );

  await page.goto(`/tasks/${source.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(source));
  // Nothing takes up the created Task while this holds the handoff, as when
  // the Task screen cannot open it.
  await page.evaluate(() => {
    window.holdTaskHandoff = true;
    window.addEventListener("caffold:task-created", (event) => {
      if (window.holdTaskHandoff) {
        event.stopImmediatePropagation();
      }
    }, { capture: true });
  });
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");
  const fork = popover.locator('[data-task-info-action="fork"]');
  await fork.click();

  await expect(popover.locator(".task-detail-fork-error")).toHaveText(
    "The forked Task was created but could not be opened. Retry to open the same Task.",
  );
  await expect(fork.locator(".task-detail-action-label")).toHaveText("Fork task");
  await expect(fork.locator(SPLIT_ICON)).toHaveCount(1);
  await expect(fork).toBeEnabled();

  await page.evaluate(() => {
    window.holdTaskHandoff = false;
  });
  await fork.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${child.threadId}$`));
  expect(requests).toBe(1);
});

test("Task details follow-up buttons place their icons as File details places Download's", { tag: "@all-viewports" }, async ({
  page,
}) => {
  // The icon sits before the label on one line, and the frame leaves the same
  // space before the icon as after the label.
  const iconPlacement = (control) => control.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const icon = element.querySelector(":scope > span:first-child").getBoundingClientRect();
    const label = element.querySelector(":scope > span:last-child").getBoundingClientRect();
    return {
      iconBeforeLabel: icon.right <= label.left,
      centerOffset: Math.abs((icon.top + icon.bottom) / 2 - (label.top + label.bottom) / 2),
      insetDifference: Math.abs((icon.left - frame.left) - (frame.right - label.right)),
      iconSize: [icon.width, icon.height],
      gap: label.left - icon.right,
    };
  });

  await mockAgentModels(page);
  const { taskScenario, taskReview } = await openCompletedTaskForReview(page);
  // An Archive refused over the worktree's changes hangs Discard changes and
  // archive under Archive.
  await page.route(`**/api/tasks/${taskScenario.threadId}/archive`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "managed_worktree_dirty",
          message: "managed worktree has uncommitted changes: /tmp/worktree",
          allowedActions: ["forceArchive"],
          worktreeId: "worktree-follow-up",
        },
      },
    }),
  );
  await page.locator("caffold-task-detail-info .task-detail-info-button").click();
  await page.locator('.task-detail-popover [data-task-info-action="archive"]').click();
  const actions = page.locator(
    ".task-detail-popover .task-detail-action-under > .task-secondary-button",
  );
  await expect(actions.filter({ hasText: "Discard changes and archive" })).toBeVisible();
  const placements = [];
  for (const action of await actions.all()) {
    await expect(action.locator("svg")).toBeVisible();
    placements.push([(await action.innerText()).trim(), await iconPlacement(action)]);
  }

  await page.goto(`/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=alpha.rs`);
  const viewer = taskReview.locator("caffold-review-file-viewer:not([hidden])");
  await expect(viewer).toContainText("pub const ALPHA");
  await viewer.locator(".viewer-info-button").click();
  const fileDownload = viewer.locator(".viewer-meta-popover > .viewer-meta-actions > .viewer-download-link");
  await expect(fileDownload.locator(".viewer-download-svg")).toBeVisible();
  const fileIcon = await iconPlacement(fileDownload);

  for (const [label, placement] of placements) {
    expect(placement.iconBeforeLabel, label).toBe(true);
    expect(placement.centerOffset, label).toBeLessThanOrEqual(0.5);
    expect(placement.insetDifference, label).toBeLessThanOrEqual(0.5);
    expect(placement.iconSize, label).toEqual(fileIcon.iconSize);
    expect(placement.gap, label).toBeCloseTo(fileIcon.gap, 1);
  }
});

test("keeps the source selected and shows a fork failure inline", { tag: "@server-steady" }, async ({
  page,
}) => {
  const threadId = "thread_summary_fork_failure";
  const task = {
    ...summaryTask(threadId, "Fork failure", "repo-fork-failure", 100),
    worktree: null,
  };
  await installSummaryFixture(page, [task]);
  await page.route(`**/api/tasks/${threadId}/fork`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "task_fork_source_changed",
          message: "The source Task changed while Codex was forking it.",
        },
      },
    }),
  );

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  await summary.getByRole("button", { name: /Task details/ }).click();
  const popover = summary.locator(".task-detail-popover");
  await popover.locator('[data-task-info-action="fork"]').click();

  await expect(popover.locator(".task-detail-fork-error")).toHaveText(
    "The source Task changed while Codex was forking it.",
  );
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(popover.locator('[data-task-info-action="fork"]')).toBeEnabled();
});

test("uses light-dismiss review popovers and preserves them across same-Task sync", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_review_popovers";
  const task = summaryTask(
    threadId,
    "Stable review popovers",
    "repo-review-popovers",
    100,
  );
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  const detailHeader = page.locator(".detail-layout-summary");
  const gitTrigger = detailHeader.getByRole("button", {
    name: "Open Git workspace",
  });
  const githubTrigger = detailHeader.getByRole("button", {
    name: "Open GitHub workspace",
  });
  const infoTrigger = summary.getByRole("button", { name: /Task details/ });
  const gitPopover = detailHeader.locator(
    "caffold-task-detail-git > .task-git-popover",
  );
  const githubPopover = detailHeader.locator(
    "caffold-task-detail-github > .task-github-popover",
  );
  const infoPopover = summary.locator(".task-detail-popover");

  const [gitTarget, gitId, githubTarget, githubId] = await Promise.all([
    gitTrigger.getAttribute("popovertarget"),
    gitPopover.getAttribute("id"),
    githubTrigger.getAttribute("popovertarget"),
    githubPopover.getAttribute("id"),
  ]);
  expect(gitTarget).toBe(gitId);
  expect(githubTarget).toBe(githubId);
  await expect(gitPopover).toHaveAttribute("popover", "auto");
  await expect(githubPopover).toHaveAttribute("popover", "auto");
  await expect(gitPopover).toHaveAttribute("role", "group");
  await expect(githubPopover).toHaveAttribute("role", "group");
  await expect(detailHeader.getByRole("menuitem", { includeHidden: true })).toHaveCount(
    0,
  );
  await expect(gitPopover.locator(":scope > button")).toHaveCount(2);
  await expect(githubPopover.locator(":scope > button")).toHaveCount(2);

  await detailHeader.evaluate((element) => {
    const git = element.querySelector("caffold-task-detail-git");
    const github = element.querySelector("caffold-task-detail-github");
    window.__taskReviewPopoverNodes = {
      git,
      gitTrigger: git.shadowRoot.querySelector(".task-git-button"),
      gitPopover: git.shadowRoot.querySelector(".task-git-popover"),
      github,
      githubTrigger: github.shadowRoot.querySelector(".task-github-button"),
      githubPopover: github.shadowRoot.querySelector(".task-github-popover"),
    };
    window.__taskReviewSummaryIntents = [];
    element.addEventListener("caffold:task-detail-summary-intent", (event) => {
      window.__taskReviewSummaryIntents.push(event.detail?.type ?? null);
    });
  });

  await gitTrigger.click();
  await expect(gitPopover).toBeVisible();
  await githubTrigger.click();
  await expect(gitPopover).toBeHidden();
  await expect(githubPopover).toBeVisible();
  await infoTrigger.click();
  await expect(githubPopover).toBeHidden();
  await expect(infoPopover).toBeVisible();
  // On a phone Task details spreads under its button over the actions row, so
  // it closes from its own button before Git opens.
  if (testInfo.project.name === "phone") {
    await infoTrigger.click();
    await expect(infoPopover).toBeHidden();
  }
  await gitTrigger.click();
  await expect(infoPopover).toBeHidden();
  await expect(gitPopover).toBeVisible();

  const renamedTask = {
    ...task,
    title: "Canonical review popover update",
    updatedMs: task.updatedMs + 1,
    recencyMs: task.recencyMs + 1,
  };
  await emitSummarySync(
    page,
    threadId,
    summaryDetail(renamedTask, 2),
    "review-popover-update",
  );
  await expect(summary.locator("h2")).toHaveText(
    "Canonical review popover update",
  );
  await expect(gitPopover).toBeVisible();
  expect(
    await detailHeader.evaluate((element) => {
      const nodes = window.__taskReviewPopoverNodes;
      const git = element.querySelector("caffold-task-detail-git");
      const github = element.querySelector("caffold-task-detail-github");
      return {
        git: nodes.git === git,
        gitTrigger:
          nodes.gitTrigger === git.shadowRoot.querySelector(".task-git-button"),
        gitPopover:
          nodes.gitPopover === git.shadowRoot.querySelector(".task-git-popover"),
        github: nodes.github === github,
        githubTrigger:
          nodes.githubTrigger ===
          github.shadowRoot.querySelector(".task-github-button"),
        githubPopover:
          nodes.githubPopover ===
          github.shadowRoot.querySelector(".task-github-popover"),
      };
    }),
  ).toEqual({
    git: true,
    gitTrigger: true,
    gitPopover: true,
    github: true,
    githubTrigger: true,
    githubPopover: true,
  });

  const taskUrl = page.url();
  await page.locator(".task-conversation-scroll").click({
    position: { x: 8, y: 8 },
  });
  await expect(gitPopover).toBeHidden();
  expect(page.url()).toBe(taskUrl);
  expect(
    await page.evaluate(() => window.__taskReviewSummaryIntents),
  ).toEqual([]);

  await gitTrigger.click();
  const compareAction = gitPopover.getByRole("button", {
    name: "Compare",
    exact: true,
  });
  await compareAction.focus();
  await expect(compareAction).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(gitPopover).toBeHidden();
  await expect(gitTrigger).toBeFocused();

  await infoTrigger.click();
  await expect(infoPopover).toBeVisible();
  const settings = page.getByRole("button", { name: /^Settings/ });
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to tasks" }).click();
    await expect(page).toHaveURL("/");
  } else {
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page).toHaveURL(/\/settings(?:\/appearance)?$/);
  }
  await expect(infoPopover).toBeHidden();
});

test("keeps the task info spinner stable across equivalent detail activity", { tag: "@server-changes" }, async ({
  page,
}) => {
  const threadId = "thread_summary_spinner_equivalent";
  const task = {
    ...summaryTask(threadId, "Stable info spinner", "repo-spinner", 100),
    ...canonicalTaskState("active", {
      turnId: "turn_summary_spinner_equivalent",
      latestTurnStatus: "inProgress",
    }),
    worktree: null,
  };
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const infoButton = page.locator(
    "caffold-task-detail-summary .task-detail-info-button",
  );
  await expect(infoButton.locator(".task-status-spinner")).toHaveCount(1);
  await infoButton.evaluate((button) => {
    const records = [];
    const observer = new MutationObserver((mutations) => {
      records.push(...mutations);
    });
    observer.observe(button, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    window.__taskInfoStatusProbe = {
      button,
      chip: button.querySelector(":scope > .task-status-chip"),
      spinner: button.querySelector(".task-status-spinner"),
      observer,
      records,
    };
  });

  await emitSummarySync(
    page,
    threadId,
    summaryDetail(task, 2),
    "equivalent-status-update",
  );
  const renamedTask = {
    ...task,
    title: "Renamed stable info spinner",
    updatedMs: task.updatedMs + 1,
    recencyMs: task.recencyMs + 1,
  };
  await emitSummarySync(
    page,
    threadId,
    summaryDetail(renamedTask, 3),
    "unrelated-summary-update",
  );
  await expect(
    page.locator("caffold-task-detail-summary h2"),
  ).toHaveText("Renamed stable info spinner");
  await page.evaluate((threadId) => {
    const source = window.__taskSummaryEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-event", {
      threadId,
      revision: 4,
      eventRevision: 4,
      event: {
        id: "event_summary_spinner_equivalent",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_summary_spinner_equivalent",
          text: "Only the conversation changed.",
        },
        position: { anchorMs: 101, index: 0 },
      },
    });
    window.dispatchEvent(new CustomEvent("caffold:icons-ready"));
  }, threadId);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

  expect(
    await infoButton.evaluate((button) => {
      const probe = window.__taskInfoStatusProbe;
      probe.observer.disconnect();
      return {
        buttonPreserved: probe.button === button,
        chipPreserved:
          probe.chip === button.querySelector(":scope > .task-status-chip"),
        mutationCount: probe.records.length,
        spinnerPreserved:
          probe.spinner === button.querySelector(".task-status-spinner"),
      };
    }),
  ).toEqual({
    buttonPreserved: true,
    chipPreserved: true,
    mutationCount: 0,
    spinnerPreserved: true,
  });
});

test("keeps canonical task status stable while the detail transport reconnects", { tag: "@server-changes" }, async ({
  page,
}) => {
  const threadId = "thread_summary_spinner_reconnecting";
  const task = {
    ...summaryTask(threadId, "Reconnecting info spinner", "repo-spinner", 100),
    ...canonicalTaskState("active", {
      turnId: "turn_summary_spinner_reconnecting",
      latestTurnStatus: "inProgress",
    }),
    worktree: null,
  };
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const infoButton = page.locator(
    "caffold-task-detail-summary .task-detail-info-button",
  );
  const statusChip = infoButton.locator(":scope > .task-status-chip");
  const statusText = page.locator(
    'caffold-task-detail-summary [data-task-info-field="status"]',
  );
  await expect(statusChip).toHaveAttribute("data-status", "running");
  await infoButton.evaluate((button) => {
    window.__taskInfoStatusNodes = {
      chip: button.querySelector(":scope > .task-status-chip"),
      spinner: button.querySelector(".task-status-spinner"),
    };
  });

  await page.evaluate((threadId) => {
    const source = window.__taskSummaryEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emitError();
  }, threadId);
  await expect(statusChip).toHaveAttribute("data-status", "running");
  await expect(statusChip).toHaveAttribute("aria-label", "running");
  await expect(infoButton).toHaveAttribute(
    "aria-label",
    "Task details, active",
  );
  await expect(infoButton).toHaveAttribute("title", "Status: active");
  await expect(statusText).toHaveText("active");
  await expect(
    page.locator(
      '.app-foreground-recovery[data-recovery-state="reconnecting"]',
    ),
  ).toContainText("Reconnecting to Caffold server");
  expect(
    await infoButton.evaluate((button) => ({
      chipPreserved:
        window.__taskInfoStatusNodes.chip ===
        button.querySelector(":scope > .task-status-chip"),
      spinnerPreserved:
        window.__taskInfoStatusNodes.spinner ===
        button.querySelector(".task-status-spinner"),
    })),
  ).toEqual({ chipPreserved: true, spinnerPreserved: true });

  await emitTaskDetailBootstrap(page, summaryDetail(task));
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
  await expect(statusChip).toHaveAttribute("data-status", "running");
  await expect(statusChip).toHaveAttribute("aria-label", "running");
  await expect(infoButton).toHaveAttribute(
    "aria-label",
    "Task details, active",
  );
  await expect(infoButton).toHaveAttribute("title", "Status: active");
  await expect(statusText).toHaveText("active");
  expect(
    await infoButton.evaluate((button) => ({
      chipPreserved:
        window.__taskInfoStatusNodes.chip ===
        button.querySelector(":scope > .task-status-chip"),
      spinnerPreserved:
        window.__taskInfoStatusNodes.spinner ===
        button.querySelector(".task-status-spinner"),
    })),
  ).toEqual({ chipPreserved: true, spinnerPreserved: true });

  const idleTask = {
    ...task,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  };
  await emitSummarySync(
    page,
    threadId,
    summaryDetail(idleTask, 2),
    "completed-status-update",
  );
  await expect(infoButton.locator(".task-status-chip")).toHaveCount(0);
  await expect(infoButton.locator(".task-status-spinner")).toHaveCount(0);
  await expect(infoButton.locator(".task-action-icon")).toHaveCount(1);
  await expect(infoButton).toHaveAttribute("title", "Status: idle");
});

test("draws the task info status chip without the pill border, like the Task list", { tag: "@server-steady" }, async ({
  page,
}) => {
  const states = {
    running: canonicalTaskState("active", { turnId: "turn_summary_chip_running" }),
    waiting_for_approval: canonicalTaskState("active", {
      activeFlags: ["waitingOnApproval"],
    }),
    waiting_on_user_input: canonicalTaskState("active", {
      activeFlags: ["waitingOnUserInput"],
    }),
    failed: canonicalTaskState("systemError"),
  };
  const cases = Object.entries(states).map(([status, state], index) => [status, {
    ...summaryTask(`thread_summary_chip_${status}`, `Chip ${status}`, "repo-chip", 100 + index),
    ...state,
    worktree: null,
  }]);
  await installSummaryFixture(page, cases.map(([, task]) => task));

  for (const [status, task] of cases) {
    await page.goto(`/tasks/${task.threadId}`);
    await emitTaskDetailBootstrap(page, summaryDetail(task));
    const detailChip = page.locator(
      "caffold-task-detail-summary .task-detail-info-button > .task-status-chip",
    );
    const rowChip = page.locator(
      `.task-row[data-thread-id="${task.threadId}"] .task-status-chip`,
    );
    await expect(detailChip).toHaveAttribute("data-status", status);
    await expect(rowChip).toHaveAttribute("data-status", status);
    const [detail, row] = await Promise.all(
      [detailChip, rowChip].map((chip) =>
        chip.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            borderWidth: style.borderWidth,
            backgroundColor: style.backgroundColor,
          };
        }),
      ),
    );
    expect(detail.borderWidth).toBe("0px");
    expect(detail.borderWidth).toBe(row.borderWidth);
    if (status === "running") {
      expect(detail.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(detail.backgroundColor).toBe(row.backgroundColor);
    }
  }
});
