import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";
import { OTHER_WORK, TOOL_CALLS } from "../support/tool-call-fixture.js";

const threadId = "thread_tool_call";
const turnId = "turn_tool_call";
const now = 1_767_450_000_000;

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__toolCallSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
});

test("a tool call is one line that measures as a finished command's", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await openTask(page, activeTask(), [
    started(),
    prompt(),
    commandEvent("fmt", now + 1_000, {
      command: "cargo fmt --check",
      status: "completed",
      exitCode: 0,
      durationMs: 1_250,
    }),
    toolCall("codexMcp", now + 2_000),
    progress("between", now + 2_500),
    toolCall("failed", now + 3_000),
    toolCall("grokRunning", now + 4_000),
    toolCall("longName", now + 5_000),
  ]);

  const conversation = page.locator("caffold-task-conversation");
  const command = conversation.locator(
    ".task-command > caffold-task-command[data-command-terminal]",
  );
  const rows = conversation.locator(".task-tool-call > caffold-task-tool-call");
  await expect(rows).toHaveCount(4);
  const commandRow = await rowGeometry(command, "command");
  for (let index = 0; index < 4; index += 1) {
    const row = await rowGeometry(rows.nth(index), "tool-call");
    expect(row.height).toBeCloseTo(commandRow.height, 1);
    expect(row.status).toBeCloseTo(commandRow.status, 1);
    expect(row.action).toBeCloseTo(commandRow.action, 1);
    expect(row.border).toBe(commandRow.border);
  }
  // The name starts where the command does after the same status word.
  expect((await rowGeometry(rows.nth(0), "tool-call")).label).toBeCloseTo(
    commandRow.label,
    1,
  );

  const codex = rows.nth(0);
  await expect(codex.locator(".task-tool-call-summary-status")).toHaveText("Completed");
  await expect(codex.locator(".task-tool-call-summary-label")).toHaveText("create_note");
  // A narrow row drops its server and duration, as a command row drops its
  // duration.
  const meta = codex.locator(".task-tool-call-summary-meta");
  if (page.viewportSize().width <= 620) {
    await expect(meta).toBeHidden();
  } else {
    await expect(meta).toHaveText("caffold · 2s");
  }
  await expect(rows.nth(1)).toHaveAttribute("data-tool-call-tone", "danger");
  await expect(rows.nth(1).locator(".task-tool-call-summary-status")).toHaveText("Failed");
  await expect(rows.nth(2).locator(".task-tool-call-summary-status")).toHaveText(
    "In progress",
  );
  expect(
    await rows.nth(3).evaluate((element) => {
      const label = element.shadowRoot.querySelector(".task-tool-call-summary-label");
      return {
        ellipsized: label.scrollWidth > label.clientWidth,
        overflow: element.scrollWidth - element.clientWidth,
      };
    }),
  ).toEqual({ ellipsized: true, overflow: 0 });

  await captureReviewScreenshot(page, testInfo, "tool-call-rows");
});

test("View details shows what a call was given and what came back, piece by piece", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await openTask(page, activeTask(), [
    started(),
    prompt(),
    toolCall("codexMcp", now + 1_000),
    progress("first", now + 1_500),
    toolCall("claudeScreenshot", now + 2_000),
    progress("second", now + 2_500),
    toolCall("claudeToolSearch", now + 3_000),
  ]);

  const rows = page.locator(".task-tool-call > caffold-task-tool-call");
  const dialog = page.locator("caffold-task-tool-call-dialog > dialog");
  const parts = dialog.locator('[data-tool-call-dialog-section="result"] pre');
  const viewDetails = rows.nth(0).getByRole("button", { name: "View details" });
  await viewDetails.click();

  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h2")).toHaveText("Tool call details");
  expect(await detailRows(dialog)).toEqual([
    ["Tool", "create_note"],
    ["Server", "caffold"],
    ["Status", "Completed"],
    ["Duration", "2s"],
  ]);
  await expect(dialog.locator('[data-tool-call-dialog-section="input"] pre')).toHaveText(
    JSON.stringify(TOOL_CALLS.codexMcp.input, null, 2),
  );
  await expect(parts).toHaveText([
    TOOL_CALLS.codexMcp.result[0].text,
    JSON.stringify(TOOL_CALLS.codexMcp.result[1].value, null, 2),
  ]);
  expect(
    await dialog.evaluate((element) => {
      const card = element.querySelector(".task-tool-call-dialog-card");
      const title = element.querySelector("h2");
      return {
        card: card.scrollWidth - card.clientWidth,
        title: title.scrollWidth - title.clientWidth,
      };
    }),
  ).toEqual({ card: 0, title: 0 });
  await captureReviewScreenshot(page, testInfo, "tool-call-details");

  await dialog.getByRole("button", { name: "Close tool call details" }).click();
  await expect(dialog).toBeHidden();
  await expect(viewDetails).toBeFocused();

  await rows.nth(1).getByRole("button", { name: "View details" }).click();
  await expect(parts).toHaveText(["(image/png not shown)", "(Binary content not shown)"]);
  await captureReviewScreenshot(page, testInfo, "tool-call-details-binary");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await rows.nth(2).getByRole("button", { name: "View details" }).click();
  await expect(parts).toHaveText(
    TOOL_CALLS.claudeToolSearch.result.map(({ value }) => JSON.stringify(value, null, 2)),
  );
});

test("a dialog opened on a running call shows its result once the call ends", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  const running = toolCall("grokRunning", now + 1_000);
  await openTask(page, activeTask(), [started(), prompt(), running]);

  const dialog = page.locator("caffold-task-tool-call-dialog > dialog");
  const parts = dialog.locator('[data-tool-call-dialog-section="result"] pre');
  await page
    .locator(".task-tool-call > caffold-task-tool-call")
    .getByRole("button", { name: "View details" })
    .click();
  await expect(parts).toHaveText(["(No result yet)"]);
  expect(await detailRows(dialog)).toEqual([
    ["Tool", "caffold__create_note_directory"],
    ["Status", "In progress"],
  ]);
  await captureReviewScreenshot(page, testInfo, "tool-call-details-running");

  await emitTaskEvent(
    page,
    {
      ...running,
      summary: "caffold__create_note_directory: completed",
      payload: { ...running.payload, ...TOOL_CALLS.grokFinished },
    },
    2,
  );

  await expect(parts).toHaveText(['{"directoryId":"d-1"}']);
  expect(await detailRows(dialog)).toEqual([
    ["Tool", "caffold__create_note_directory"],
    ["Server", "caffold"],
    ["Status", "Completed"],
  ]);
  await expect(dialog).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "tool-call-details-finished");
});

test("a call says when it had no input or no result", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  await openTask(page, activeTask(), [
    started(),
    prompt(),
    toolCall("noInput", now + 1_000),
    progress("between", now + 1_500),
    toolCall("antigravitySearchReloaded", now + 2_000),
  ]);

  const rows = page.locator(".task-tool-call > caffold-task-tool-call");
  const dialog = page.locator("caffold-task-tool-call-dialog > dialog");
  const input = dialog.locator('[data-tool-call-dialog-section="input"] pre');
  const parts = dialog.locator('[data-tool-call-dialog-section="result"] pre');

  await rows.nth(0).getByRole("button", { name: "View details" }).click();
  await expect(input).toHaveText("(No input)");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await rows.nth(1).getByRole("button", { name: "View details" }).click();
  await expect(input).toHaveText(
    JSON.stringify(TOOL_CALLS.antigravitySearchReloaded.input, null, 2),
  );
  await expect(parts).toHaveText(["(No result)"]);
  await captureReviewScreenshot(page, testInfo, "tool-call-details-no-result");
});

test("a finished turn's work details hold the call's row and other work's card", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  const task = {
    ...activeTask(),
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  };
  await openTask(page, task, [
    started(),
    prompt(),
    toolCall("antigravityMcp", now + 1_000),
    otherWork("compaction", now + 2_000),
    finalMessage(now + 3_000),
    turnCompleted(now + 4_000),
  ]);

  const workDetails = page.locator("caffold-task-work-details > details");
  await activateActionHint(page, /Expand (?:Worked for|Work details)/);
  await expect(workDetails).toHaveAttribute("open", "");
  const row = workDetails.locator(".task-work-details-tool-call > caffold-task-tool-call");
  await expect(row.locator(".task-tool-call-summary-label")).toHaveText("rename_current_task");
  const card = workDetails.locator('.task-work-details-item[data-event-type="other_work"]');
  await expect(card.locator("header strong")).toHaveText("Compacting context");
  await expect(card).toContainText("Status: completed");
  await captureReviewScreenshot(page, testInfo, "tool-call-work-details");

  const dialog = page.locator("caffold-task-tool-call-dialog > dialog");
  await activateActionHint(page, "View details");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-tool-call-dialog-section="input"] pre')).toHaveText(
    JSON.stringify(TOOL_CALLS.antigravityMcp.input, null, 2),
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(row.getByRole("button", { name: "View details" })).toBeFocused();
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
    title: "Tool calls",
    preview: "Calling tools",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Calling tools",
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
    text: "Take notes on the release.",
  });
}

// Finished calls in a row fold into one group; a message between two keeps
// each on a line of its own.
function progress(itemId, anchorMs) {
  return turnEvent(`event_${itemId}`, "assistant_message", anchorMs, {
    itemId,
    phase: "progress",
    text: "Checking the next one.",
  });
}

function finalMessage(anchorMs) {
  return turnEvent("event_final", "assistant_message", anchorMs, {
    itemId: "final",
    phase: "final",
    text: "The notes are written.",
  });
}

function turnCompleted(anchorMs) {
  return turnEvent("event_turn_completed", "turn_completed", anchorMs, {
    status: "completed",
  });
}

function commandEvent(itemId, anchorMs, payload) {
  return turnEvent(`event_command_${itemId}`, "command_execution", anchorMs, {
    itemId,
    cwd: "src",
    ...payload,
  });
}

function toolCall(name, anchorMs) {
  return turnEvent(`event_tool_${name}`, "tool_call", anchorMs, {
    itemId: `tool_${name}`,
    ...TOOL_CALLS[name],
  });
}

function otherWork(name, anchorMs) {
  return turnEvent(`event_work_${name}`, "other_work", anchorMs, {
    itemId: `work_${name}`,
    ...OTHER_WORK[name],
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
    const source = window.__toolCallSources.find((candidate) =>
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

// A row's frame and the edges of what it shows, measured from the top of the
// conversation list so scrolling cannot move them.
async function rowGeometry(row, kind) {
  return row.evaluate((element, kind) => {
    const box = element.getBoundingClientRect();
    const list = element.closest(".task-conversation").getBoundingClientRect();
    const edge = (part, side) =>
      element.shadowRoot
        .querySelector(`.task-${kind}-summary-${part}`)
        .getBoundingClientRect()[side];
    return {
      top: box.top - list.top,
      height: box.height,
      status: edge("status", "left"),
      label: edge("label", "left"),
      action: edge("action", "right"),
      border: parseFloat(getComputedStyle(element).borderTopWidth),
    };
  }, kind);
}

async function detailRows(dialog) {
  return dialog
    .locator(".task-tool-call-dialog-details > div")
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.querySelector("dt").textContent.trim(),
        row.querySelector("dd").textContent.trim(),
      ]),
    );
}
