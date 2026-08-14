import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__commandEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);
});

test("owns active disclosure state and terminal presentation across canonical updates", async ({
  page,
}, testInfo) => {
  const threadId = "thread_command_component";
  const turnId = "turn_command_component";
  const now = 1_767_450_000_000;
  const task = activeTask(threadId, turnId, now);
  const started = turnEvent(
    "event_turn_started",
    "turn_started",
    now,
    turnId,
    { status: "inProgress" },
  );
  const commandStarted = commandEvent(now + 1_000, turnId, {
    lifecycle: "started",
    status: "inProgress",
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail(task, [started, commandStarted], 1) }),
  );

  await page.goto(`/tasks/${threadId}`);
  const command = page.locator(".task-command > caffold-task-command");
  const disclosure = command.locator(":scope > details.task-command-active");
  const summary = disclosure.locator(":scope > summary");
  const collapsedChevron = summary.locator(
    ".task-command-disclosure-chevron-collapsed",
  );
  const expandedChevron = summary.locator(
    ".task-command-disclosure-chevron-expanded",
  );

  await expect(command).toHaveCount(1);
  expect(await command.evaluate((element) => element.localName)).toBe(
    "caffold-task-command",
  );
  await expect(command).toHaveAttribute("data-command-status", "inProgress");
  await expect(command).not.toHaveAttribute("data-command-terminal", "");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(collapsedChevron).not.toBeVisible();
  await expect(expandedChevron).toBeVisible();
  await rememberCommandIdentity(command);

  const summaryOffset = await disclosureOffset(summary);
  await summary.click();
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(collapsedChevron).toBeVisible();
  await expect(expandedChevron).not.toBeVisible();
  await expect
    .poll(() => disclosureOffset(summary))
    .toBeCloseTo(summaryOffset, 1);

  const commandUpdated = commandEvent(now + 2_000, turnId, {
    lifecycle: "updated",
    status: "inProgress",
    aggregatedOutput: "Compiling caffold v0.6.0",
  });
  await emitTaskEvent(page, threadId, commandUpdated, 2);
  await expect(command).toContainText("Compiling caffold v0.6.0");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expectCommandIdentity(page, { activeStructure: true });

  await summary.click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      summary.evaluate((element) => {
        const label = element.querySelector(".task-command-active-label");
        const icon = element.querySelector(
          ".task-command-disclosure-chevron-expanded",
        );
        const labelRect = label.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        return Math.abs(
          labelRect.top + labelRect.height / 2 -
            (iconRect.top + iconRect.height / 2),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await captureReviewScreenshot(page, testInfo, "command-active-expanded");

  const commandCompleted = commandEvent(now + 3_000, turnId, {
    lifecycle: "completed",
    status: "completed",
    exitCode: 0,
    durationMs: 1_600,
    aggregatedOutput: "test result: ok",
  });
  await emitTaskEvent(page, threadId, commandCompleted, 3);
  await expect(command).toHaveAttribute("data-command-terminal", "");
  await expect(command).toHaveAttribute("data-command-status", "completed");
  await expect(command.locator(":scope > details")).toHaveCount(0);
  await expect(command).toContainText("Completed");
  await expect(command).toContainText("cargo test");
  await expect(command).toContainText("2s");
  await expect(command).not.toContainText("test result: ok");
  await expect(
    command.getByRole("button", { name: "View output" }),
  ).toBeVisible();
  await expectCommandIdentity(page, { activeStructure: false });
  await captureReviewScreenshot(page, testInfo, "command-terminal");

  const completed = turnEvent(
    "event_turn_completed",
    "turn_completed",
    now + 4_000,
    turnId,
    { status: "completed" },
  );
  const completedTask = {
    ...task,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: now + 4_000,
    recencyMs: now + 4_000,
  };
  await emitTaskSync(
    page,
    threadId,
    taskDetail(
      completedTask,
      [started, commandCompleted, completed],
      4,
    ),
    4,
  );
  await expect(page.locator(".task-command")).toHaveCount(0);
  const workDetails = page.locator("caffold-task-work-details > details");
  await workDetails.locator(":scope > summary").click();
  const completedCommand = workDetails.locator(
    ".task-work-details-command > caffold-task-command",
  );
  await expect(completedCommand).toHaveAttribute("data-command-terminal", "");
  await expect(completedCommand).toContainText("Completed");
  expect(await completedCommand.evaluate((element) => element.localName)).toBe(
    "caffold-task-command",
  );
});

function activeTask(threadId, turnId, startedAtMs) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId,
      startedAtMs,
      latestTurnStatus: "inProgress",
    }),
    title: "Command component ownership",
    preview: "Running cargo test",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: startedAtMs,
    updatedMs: startedAtMs,
    recencyMs: startedAtMs,
    lastEventSummary: "Running command",
    unseen: false,
  };
}

function commandEvent(createdMs, turnId, payload) {
  return turnEvent(
    "event_command",
    "command_execution",
    createdMs,
    turnId,
    {
      itemId: "command_item",
      command: "cargo test",
      cwd: "src",
      ...payload,
    },
  );
}

function turnEvent(id, type, createdMs, turnId, payload = {}) {
  return {
    id,
    threadId: "thread_command_component",
    type,
    summary: type.replaceAll("_", " "),
    payload: { turnId, ...payload },
    createdMs,
  };
}

function taskDetail(task, events, revision) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
  };
}

async function emitTaskEvent(page, threadId, event, revision) {
  await page.evaluate(({ threadId, event, revision }) => {
    const source = window.__commandEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-event", { threadId, revision, event });
  }, { threadId, event, revision });
}

async function emitTaskSync(page, threadId, detail, revision) {
  await page.evaluate(({ threadId, detail, revision }) => {
    const source = window.__commandEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", { threadId, revision, detail });
  }, { threadId, detail, revision });
}

async function rememberCommandIdentity(command) {
  await command.evaluate((element) => {
    window.__commandIdentity = {
      element,
      details: element.querySelector(":scope > details"),
      summary: element.querySelector(":scope > details > summary"),
    };
  });
}

async function expectCommandIdentity(page, { activeStructure }) {
  expect(
    await page.evaluate(({ activeStructure }) => {
      const identity = window.__commandIdentity;
      const current = document.querySelector(
        ".task-command > caffold-task-command",
      );
      return (
        current === identity.element &&
        (activeStructure
          ? current.querySelector(":scope > details") === identity.details &&
            current.querySelector(":scope > details > summary") ===
              identity.summary
          : !identity.details.isConnected && !identity.summary.isConnected)
      );
    }, { activeStructure }),
  ).toBe(true);
}

async function disclosureOffset(summary) {
  return summary.evaluate((element) => {
    const scroller = element.closest(".task-conversation-scroll");
    return (
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top
    );
  });
}
