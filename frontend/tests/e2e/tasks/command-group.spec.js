import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  enterActionHints,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  isScrolledToBottom,
  mockAgentModels,
} from "../support/task-fixtures.js";

const threadId = "thread_command_group";
const turnId = "turn_command_group";
const now = 1_767_450_000_000;

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__commandGroupSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
});

test("a finished command folds into the group beside it and only its frame changes", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const task = activeTask();
  const fmt = commandEvent("fmt", now + 1_000, {
    command: "cargo fmt --check",
    status: "completed",
    exitCode: 0,
    durationMs: 1_250,
  });
  const clippy = commandEvent("clippy", now + 2_000, {
    command: "cargo clippy --all-targets",
    status: "inProgress",
  });
  await openTask(page, task, [started(), prompt(), fmt, clippy]);

  const conversation = page.locator("caffold-task-conversation");
  const standalone = conversation.locator(
    ".task-command > caffold-task-command[data-command-terminal]",
  );
  await expect(standalone).toHaveCount(1);
  const card = await rowGeometry(standalone);

  await emitTaskEvent(page, {
    ...clippy,
    payload: { ...clippy.payload, status: "completed", exitCode: 0, durationMs: 3_400 },
  }, 2);
  const group = conversation.locator(
    ".task-command-group > caffold-task-command-group",
  );
  const summary = group.locator(".task-command-group-summary");
  await expect(group).toHaveCount(1);
  await expect(conversation.locator(".task-command")).toHaveCount(0);
  await expect(summary).toContainText("Ran 2 commands");
  await expect(group.locator(".task-command-group-failed")).toBeHidden();
  // The group sits where the card was and is as tall as the card was.
  const folded = await hostGeometry(group);
  expect(folded.top).toBeCloseTo(card.top, 1);
  expect(folded.height).toBeCloseTo(card.height, 1);

  // A running command stays on its own until it ends, and a failure is
  // counted on the folded line.
  const cargoTest = commandEvent("test", now + 3_000, {
    command: "cargo test --package intentionally-missing",
    status: "inProgress",
  });
  await emitTaskEvent(page, cargoTest, 3);
  await expect(
    conversation.locator(".task-command > caffold-task-command:not([data-command-terminal])"),
  ).toHaveCount(1);
  await expect(summary).toContainText("Ran 2 commands");
  await emitTaskEvent(page, {
    ...cargoTest,
    payload: { ...cargoTest.payload, status: "failed", exitCode: 101, durationMs: 2_400 },
  }, 4);
  await expect(conversation.locator(".task-command")).toHaveCount(0);
  await expect(summary).toContainText("Ran 3 commands");
  await expect(group.locator(".task-command-group-failed")).toHaveText("1 failed");
  expect((await hostGeometry(group)).top).toBeCloseTo(card.top, 1);
  await expectNothingClipped(group);
  await captureReviewScreenshot(page, testInfo, "command-group-folded");

  await summary.click();
  await expect(group.locator(":scope > details")).toHaveAttribute("open", "");
  const rows = group.locator(".task-command-group-item > caffold-task-command");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("cargo fmt --check");
  await expect(rows.nth(2)).toContainText("Failed");
  // The rows read exactly as the card did: only the frame moved to the group.
  const row = await rowGeometry(rows.nth(0));
  expect(row.status).toBeCloseTo(card.status, 1);
  expect(row.label).toBeCloseTo(card.label, 1);
  expect(row.action).toBeCloseTo(card.action, 1);
  expect(row.border).toBe(0);
  await expect(rows.nth(2)).toHaveAttribute("data-command-tone", "danger");
  await expectNothingClipped(group);
  await captureReviewScreenshot(page, testInfo, "command-group-expanded");
});

test("the empty thinking around commands folds in as rows as tall as a command", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  // How a Claude turn arrives: an empty thinking block where the agent
  // thought, before each command.
  const task = activeTask();
  const opening = emptyThinking("t1", now + 500);
  const status = commandEvent("status", now + 1_000, {
    command: "git status --short",
    status: "completed",
    exitCode: 0,
  });
  const between = emptyThinking("t2", now + 1_500);
  const diff = commandEvent("diff", now + 2_000, {
    command: "git diff --stat",
    status: "inProgress",
  });
  await openTask(page, task, [started(), prompt(), opening, status, between, diff]);

  const conversation = page.locator("caffold-task-conversation");
  // One finished command is not a group yet: the thinking reads as it did.
  await expect(conversation.locator(".task-event-status")).toHaveCount(2);
  await expect(conversation.locator(".task-command-group")).toHaveCount(0);
  // A command with no duration still ends its View output at the row's edge.
  const card = conversation.locator(
    ".task-command > caffold-task-command[data-command-terminal]",
  );
  expect(
    await card.evaluate((element) => {
      const row = element.querySelector(":scope > .task-command-summary");
      const action = row.querySelector(".task-command-summary-action");
      return row.getBoundingClientRect().right -
        parseFloat(getComputedStyle(row).paddingRight) -
        action.getBoundingClientRect().right;
    }),
  ).toBeCloseTo(0, 1);

  await emitTaskEvent(page, {
    ...diff,
    payload: { ...diff.payload, status: "completed", exitCode: 0 },
  }, 2);
  await emitTaskEvent(page, emptyThinking("t3", now + 2_500), 3);
  const group = conversation.locator(
    ".task-command-group > caffold-task-command-group",
  );
  await expect(group).toHaveCount(1);
  await expect(conversation.locator(".task-event-status")).toHaveCount(0);
  await expect(group.locator(".task-command-group-summary")).toContainText(
    "Ran 2 commands",
  );

  await group.locator(".task-command-group-summary").click();
  const rows = group.locator(".task-command-group-item");
  await expect(rows).toHaveCount(5);
  expect(
    await rows.evaluateAll((items) =>
      items.map((item) =>
        item.classList.contains("task-command-group-thinking")
          ? `Thinking ${item.querySelector("time").textContent ? "with time" : "no time"}`
          : "command"
      )
    ),
  ).toEqual([
    "Thinking with time",
    "command",
    "Thinking with time",
    "command",
    "Thinking with time",
  ]);
  const heights = await rows.evaluateAll((items) =>
    [...new Set(items.map((item) =>
      Math.round(
        (item.getBoundingClientRect().height -
          parseFloat(getComputedStyle(item).borderTopWidth)) * 10,
      ) / 10
    ))]
  );
  expect(heights).toHaveLength(1);
  // Every row ends at the same right edge, View output and time alike.
  const rightEdges = await group.evaluate((element) =>
    [
      ...element.querySelectorAll(".task-command-summary-action"),
      ...element.querySelectorAll(".task-command-group-thinking-row > time"),
    ].map((node) => node.getBoundingClientRect().right)
  );
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(0.5);
  await expectNothingClipped(group);
  await captureReviewScreenshot(page, testInfo, "command-group-thinking");
});

test("an open group stays open when its finished turn folds into work details", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const task = activeTask();
  const fmt = commandEvent("fmt", now + 1_000, {
    command: "cargo fmt --check",
    status: "completed",
    exitCode: 0,
  });
  const clippy = commandEvent("clippy", now + 2_000, {
    command: "cargo clippy --all-targets",
    status: "completed",
    exitCode: 0,
  });
  await openTask(page, task, [started(), prompt(), fmt, clippy]);
  const conversation = page.locator("caffold-task-conversation");
  const activeGroup = conversation.locator(
    ".task-command-group > caffold-task-command-group",
  );
  await activeGroup.locator(".task-command-group-summary").click();
  await expect(activeGroup.locator(":scope > details")).toHaveAttribute("open", "");

  const completedTask = {
    ...task,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: now + 4_000,
    recencyMs: now + 4_000,
  };
  await emitTaskSync(
    page,
    taskDetail(completedTask, [
      started(),
      prompt(),
      fmt,
      clippy,
      finalMessage(now + 3_000),
      turnCompleted(now + 4_000),
    ], 5),
    5,
  );
  await expect(conversation.locator(".task-command-group")).toHaveCount(0);
  const workDetails = conversation.locator("caffold-task-work-details > details");
  await workDetails.locator(":scope > summary").click();
  const group = workDetails.locator(
    ".task-work-details-command-group > caffold-task-command-group",
  );
  await expect(group.locator(":scope > details")).toHaveAttribute("open", "");
  await expect(
    group.locator(".task-command-group-item > caffold-task-command"),
  ).toHaveCount(2);
});

test("work details offer a folded group's rows to the keyboard only while it is open", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const task = {
    ...activeTask(),
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  };
  const events = [
    started(),
    prompt(),
    commandEvent("fmt", now + 1_000, {
      command: "cargo fmt --check",
      status: "completed",
      exitCode: 0,
    }),
    commandEvent("clippy", now + 2_000, {
      command: "cargo clippy --all-targets",
      status: "completed",
      exitCode: 0,
    }),
    commandEvent("test", now + 3_000, {
      command: "cargo test --package intentionally-missing",
      status: "failed",
      exitCode: 101,
      output: "error: package `intentionally-missing` was not found",
    }),
    turnEvent("event_thinking", "reasoning", now + 4_000, {
      itemId: "thinking",
      summary: ["The package name is wrong."],
    }),
    commandEvent("retry", now + 5_000, {
      command: "cargo test --workspace",
      status: "completed",
      exitCode: 0,
    }),
    finalMessage(now + 6_000),
    turnCompleted(now + 7_000),
  ];
  await openTask(page, task, events);

  const conversation = page.locator("caffold-task-conversation");
  const workDetails = conversation.locator("caffold-task-work-details > details");
  await expect(workDetails.locator(":scope > summary")).toContainText("3 updates");
  await activateActionHint(page, /Expand (?:Worked for|Work details)/);
  await expect(workDetails).toHaveAttribute("open", "");
  const group = workDetails.locator(
    ".task-work-details-command-group > caffold-task-command-group",
  );
  await expect(group).toContainText("Ran 3 commands");
  await expect(group).toContainText("1 failed");
  await expect(
    workDetails.locator(".task-work-details-command > caffold-task-command"),
  ).toHaveCount(1);

  let hints = await enterActionHints(page);
  await expect(hints.getByLabel("Expand Ran 3 commands")).toBeVisible();
  await expect(hints.getByLabel(/View output$/)).toHaveCount(1);
  await page.keyboard.press("Escape");

  await activateActionHint(page, "Expand Ran 3 commands");
  await expect(group.locator(":scope > details")).toHaveAttribute("open", "");
  hints = await enterActionHints(page);
  await expect(hints.getByLabel("Collapse Ran 3 commands")).toBeVisible();
  await expect(hints.getByLabel(/View output$/)).toHaveCount(4);
  await page.keyboard.press("Escape");

  await group
    .locator(".task-command-group-item")
    .nth(2)
    .getByRole("button", { name: "View output" })
    .click();
  const dialog = page.locator("caffold-task-command-dialog > dialog");
  await expect(dialog).toHaveAttribute("open", "");
  await expect(dialog).toContainText("intentionally-missing");
});

test("a reader anchored on a command keeps their place when it folds into a group", { tag: "@desktop" }, async ({
  page,
}) => {
  const task = activeTask();
  const progress = (index, anchorMs) =>
    turnEvent(`event_progress_${index}`, "assistant_message", anchorMs, {
      itemId: `progress_${index}`,
      phase: "progress",
      text: `Progress note ${index}: ${"the checks keep running while this note stays readable. ".repeat(4)}`,
    });
  const lint = commandEvent("lint", now + 20_000, {
    command: "npm run lint",
    status: "completed",
    exitCode: 0,
  });
  const build = commandEvent("build", now + 21_000, {
    command: "cargo build",
    status: "inProgress",
    output: "Compiling caffold v0.19.0",
  });
  const docs = commandEvent("docs", now + 22_000, {
    command: "uv run zensical build --strict",
    status: "completed",
    exitCode: 0,
  });
  const events = [
    started(),
    prompt(),
    ...Array.from({ length: 8 }, (_, index) => progress(index, now + 1_000 + index)),
    lint,
    build,
    docs,
    ...Array.from({ length: 8 }, (_, index) =>
      progress(index + 8, now + 30_000 + index)
    ),
  ];
  await openTask(page, task, events);

  const conversation = page.locator("caffold-task-conversation");
  const scroller = conversation.locator(".task-conversation-scroll");
  await expect(conversation.locator(".task-assistant-message")).toHaveCount(16);
  await expect
    .poll(() =>
      conversation
        .locator("caffold-task-markdown")
        .evaluateAll((elements) =>
          elements.every((element) => element.dataset.renderState !== "loading")
        ),
    )
    .toBe(true);
  const docsEntry = conversation.locator('.task-command[data-event-id="event_command_docs"]');
  await docsEntry.evaluate((entry) => {
    const scroller = entry.closest(".task-conversation-scroll");
    scroller.scrollTop +=
      entry.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    scroller.dispatchEvent(new Event("scroll"));
  });
  const readingOffset = await entryOffset(docsEntry);
  expect(readingOffset).toBeCloseTo(40, 0);
  expect(await isScrolledToBottom(scroller)).toBe(false);

  await emitTaskEvent(page, {
    ...build,
    payload: { ...build.payload, status: "completed", exitCode: 0 },
  }, 2);
  const groupEntry = conversation.locator(".task-command-group");
  await expect(groupEntry.locator("caffold-task-command-group")).toContainText(
    "Ran 3 commands",
  );
  await expect(docsEntry).toHaveCount(0);
  await expect.poll(() => entryOffset(groupEntry)).toBeCloseTo(readingOffset, 0);

  // Opening the group keeps its line where the reader is looking.
  const summary = groupEntry.locator(".task-command-group-summary");
  await summary.click();
  await expect(
    groupEntry.locator("caffold-task-command-group > details"),
  ).toHaveAttribute("open", "");
  await expect.poll(() => entryOffset(groupEntry)).toBeCloseTo(readingOffset, 0);
});

function activeTask() {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId,
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Command groups",
    preview: "Running the checks",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Running command",
    unseen: false,
  };
}

function started() {
  return turnEvent("event_turn_started", "turn_started", now, {
    status: "inProgress",
  });
}

function prompt() {
  return turnEvent("event_prompt", "user_message", now + 100, {
    itemId: "prompt",
    text: "Run the checks.",
  });
}

function finalMessage(anchorMs) {
  return turnEvent("event_final", "assistant_message", anchorMs, {
    itemId: "final",
    phase: "final",
    text: "The checks ran.",
  });
}

function turnCompleted(anchorMs) {
  return turnEvent("event_turn_completed", "turn_completed", anchorMs, {
    status: "completed",
  });
}

function emptyThinking(itemId, anchorMs) {
  return {
    ...turnEvent(`event_thinking_${itemId}`, "reasoning", anchorMs, {
      itemId,
      summary: [],
      content: [""],
    }),
    observedMs: anchorMs,
  };
}

function commandEvent(itemId, anchorMs, payload) {
  return turnEvent(`event_command_${itemId}`, "command_execution", anchorMs, {
    itemId,
    cwd: "src",
    ...payload,
  });
}

function turnEvent(id, type, anchorMs, payload = {}) {
  return {
    id,
    threadId,
    type,
    summary: type.replaceAll("_", " "),
    payload: { turnId, ...payload },
    position: { anchorMs, index: 0 },
  };
}

function taskDetail(task, events, revision) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision,
    eventRevision: revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    eventsRange: { from: null, to: null },
    historyLoading: false,
  };
}

async function openTask(page, task, events) {
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail(task, events, 1) }),
  );
  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, taskDetail(task, events, 1));
}

async function emitTaskEvent(page, event, revision) {
  await page.evaluate(({ threadId, event, revision }) => {
    const source = window.__commandGroupSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-event", {
      threadId,
      revision,
      eventRevision: revision,
      event,
    });
  }, { threadId, event, revision });
}

async function emitTaskSync(page, detail, revision) {
  await page.evaluate(({ threadId, detail, revision }) => {
    const source = window.__commandGroupSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", { threadId, revision, detail });
  }, { threadId, detail, revision });
}

// A command row's frame and the left edges of what it shows, measured from the
// top of the conversation list so scrolling cannot move them.
async function rowGeometry(command) {
  return command.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const list = element.closest(".task-conversation").getBoundingClientRect();
    const edge = (selector, side) =>
      element.querySelector(selector).getBoundingClientRect()[side];
    return {
      top: box.top - list.top,
      height: box.height,
      status: edge(".task-command-summary-status", "left"),
      label: edge(".task-command-summary-label", "left"),
      action: edge(".task-command-summary-action", "right"),
      border: parseFloat(getComputedStyle(element).borderTopWidth),
    };
  });
}

async function hostGeometry(locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const list = element.closest(".task-conversation").getBoundingClientRect();
    return { top: box.top - list.top, height: box.height };
  });
}

async function entryOffset(entry) {
  return entry.evaluate((element) => {
    const scroller = element.closest(".task-conversation-scroll");
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
}

async function expectNothingClipped(group) {
  expect(
    await group.evaluate((element) =>
      [
        element,
        element.querySelector(".task-command-group-label"),
        element.querySelector(".task-command-group-results"),
      ].map((node) => node.scrollWidth - node.clientWidth),
    ),
  ).toEqual([0, 0, 0]);
}
