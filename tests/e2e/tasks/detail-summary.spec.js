import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

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

function summaryDetail(task, revision = 1) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
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

async function summaryNodeState(page) {
  return page.evaluate(() => {
    const summary = document.querySelector("caffold-task-detail-summary");
    const nodes = window.__taskSummaryNodes;
    return {
      owner: nodes.owner === summary,
      info:
        nodes.info === summary.querySelector("caffold-task-detail-info"),
      infoButton:
        nodes.infoButton === summary.querySelector(".task-detail-info-button"),
      infoPopover:
        nodes.infoPopover === summary.querySelector(".task-detail-popover"),
      infoOpen: nodes.infoPopover.matches(":popover-open"),
    };
  });
}

const stableSummaryNodes = {
  owner: true,
  info: true,
  infoButton: true,
  infoPopover: true,
};

async function installSummaryFixture(page, tasks) {
  await installEventSourceMock(page, {
    registryKey: "__taskSummaryEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: { tasks, nextCursor: null },
    }),
  );
  for (const task of tasks) {
    await page.route(
      new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`),
      (route) => route.fulfill({ json: summaryDetail(task) }),
    );
  }
}

test("keeps long Task titles clipped in the header and readable in Info", async ({
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
  const summary = page.locator("caffold-task-detail-summary");
  const heading = summary.locator(".task-detail-heading > h2");
  await expect(summary).toBeVisible();
  await expect(summary.locator(".task-detail-heading > *")).toHaveCount(1);
  await expect(heading).toHaveText(title);
  await expect
    .poll(() =>
      heading.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);

  const headerLayout = await summary.evaluate((element) => {
    const heading = element.querySelector(".task-detail-heading");
    const right = element.querySelector(".task-detail-right");
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
  const taskValue = popover.locator('[data-task-info-field="task"]');
  await expect(popover).toBeVisible();
  await expect(taskValue).toHaveText(title);
  await expect(popover.locator('[data-task-info-field="thread"]')).toHaveText(
    threadId,
  );
  await expect(
    popover.locator('[data-task-info-field="working-directory"]'),
  ).toHaveText("repo-long-title");
  const worktreeRows = popover.locator("[data-task-info-worktree]");
  await expect(worktreeRows).toHaveCount(2);
  await expect(worktreeRows.first()).toBeHidden();
  await expect(worktreeRows.last()).toBeHidden();
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

test("keeps the task info leaf and popover stable across canonical sync", async ({
  page,
}, testInfo) => {
  const threadId = "thread_summary_stable";
  const task = summaryTask(threadId, "Stable summary", "repo-stable", 100);
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  const summary = page.locator("caffold-task-detail-summary");
  await expect(summary).toBeVisible();
  await expect(
    summary.locator("caffold-task-detail-git, caffold-task-detail-github"),
  ).toHaveCount(2);
  const taskDetailsButton = summary.getByRole("button", {
    name: /Task details/,
  });
  const taskDetailsPopover = summary.locator(".task-detail-popover");
  await summary.evaluate((element) => {
    window.__taskSummaryNodes = {
      owner: element,
      info: element.querySelector("caffold-task-detail-info"),
      infoButton: element.querySelector(".task-detail-info-button"),
      infoPopover: element.querySelector(".task-detail-popover"),
    };
  });

  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeVisible();
  await expect(
    taskDetailsPopover.locator('[data-task-info-field="task"]'),
  ).toHaveText("Stable summary");
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
    taskDetailsPopover.locator('[data-task-info-field="task"]'),
  ).toHaveText("Canonical summary update");
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: active");
  await expect(
    taskDetailsPopover.locator('[data-task-info-field="status"]'),
  ).toHaveText("active");
  await expect(
    taskDetailsPopover.locator('[data-task-info-action="archive"]'),
  ).toBeDisabled();
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
  await captureReviewScreenshot(page, testInfo, "tasks-summary-live-popover");
});

test("uses light-dismiss review popovers and preserves them across same-Task sync", async ({
  page,
}) => {
  const threadId = "thread_summary_review_popovers";
  const task = summaryTask(
    threadId,
    "Stable review popovers",
    "repo-review-popovers",
    100,
  );
  await installSummaryFixture(page, [task]);

  await page.goto(`/tasks/${threadId}`);
  const summary = page.locator("caffold-task-detail-summary");
  const gitTrigger = summary.getByRole("button", {
    name: "Open Git workspace",
  });
  const githubTrigger = summary.getByRole("button", {
    name: "Open GitHub workspace",
  });
  const infoTrigger = summary.getByRole("button", { name: /Task details/ });
  const gitPopover = summary.locator(
    "caffold-task-detail-git > .task-git-popover",
  );
  const githubPopover = summary.locator(
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
  await expect(summary.getByRole("menuitem", { includeHidden: true })).toHaveCount(
    0,
  );
  await expect(gitPopover.locator(":scope > button")).toHaveCount(2);
  await expect(githubPopover.locator(":scope > button")).toHaveCount(2);

  await summary.evaluate((element) => {
    const git = element.querySelector("caffold-task-detail-git");
    const github = element.querySelector("caffold-task-detail-github");
    window.__taskReviewPopoverNodes = {
      git,
      gitTrigger: git.querySelector(":scope > .task-git-button"),
      gitPopover: git.querySelector(":scope > .task-git-popover"),
      github,
      githubTrigger: github.querySelector(":scope > .task-github-button"),
      githubPopover: github.querySelector(":scope > .task-github-popover"),
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
    await summary.evaluate((element) => {
      const nodes = window.__taskReviewPopoverNodes;
      const git = element.querySelector("caffold-task-detail-git");
      const github = element.querySelector("caffold-task-detail-github");
      return {
        git: nodes.git === git,
        gitTrigger:
          nodes.gitTrigger === git.querySelector(":scope > .task-git-button"),
        gitPopover:
          nodes.gitPopover === git.querySelector(":scope > .task-git-popover"),
        github: nodes.github === github,
        githubTrigger:
          nodes.githubTrigger ===
          github.querySelector(":scope > .task-github-button"),
        githubPopover:
          nodes.githubPopover ===
          github.querySelector(":scope > .task-github-popover"),
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
});

test("keeps the task info spinner stable across equivalent detail activity", async ({
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
      event: {
        id: "event_summary_spinner_equivalent",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_summary_spinner_equivalent",
          text: "Only the conversation changed.",
        },
        createdMs: 101,
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

test("keeps the task info spinner stable across reconnecting status", async ({
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
  await expect(statusChip).toHaveAttribute("data-status", "reconnecting");
  await expect(statusChip).toHaveAttribute("aria-label", "reconnecting");
  await expect(infoButton).toHaveAttribute(
    "aria-label",
    "Task details, reconnecting",
  );
  await expect(infoButton).toHaveAttribute("title", "Status: reconnecting");
  await expect(statusText).toHaveText("reconnecting");
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

  await page.evaluate((threadId) => {
    const source = window.__taskSummaryEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emitOpen();
  }, threadId);
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
