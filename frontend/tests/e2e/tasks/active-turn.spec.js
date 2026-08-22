import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__activeTurnEventSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
});

test("shows context compaction only while its lifecycle item is active", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = "thread_context_compaction_status";
  const turnId = "turn_context_compaction_status";
  const startedAtMs = Date.now() - 1_000;
  const task = activeTask({
    threadId,
    title: "Context compaction status",
    turnId,
    startedAtMs,
  });
  const turnStarted = turnEvent({
    id: "event_context_compaction_turn_started",
    threadId,
    turnId,
    type: "turn_started",
    createdMs: startedAtMs,
    payload: { status: "inProgress" },
  });
  const initialDetail = taskDetail(task, [turnStarted], 1);

  await routeTaskList(page, [task]);
  await page.route(
    new RegExp(`/api/tasks/${threadId}(?:\\?|$)`),
    (route) => route.fulfill({ json: initialDetail }),
  );

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, { ...initialDetail, threadId });
  const activeTurn = page.locator(".task-turn-active");
  const state = activeTurn.locator(".task-turn-active-state");
  await expect(state).toHaveText("Thinking");
  await rememberActiveTurnIdentity(page);

  const compactionStarted = turnEvent({
    id: `${turnId}:context-compaction-1`,
    threadId,
    turnId,
    type: "tool_call",
    createdMs: startedAtMs + 1_000,
    payload: {
      itemId: "context-compaction-1",
      name: "Compacting context",
      status: "inProgress",
    },
  });
  await emitTaskEvent(page, threadId, compactionStarted, 2);
  await expect(state).toHaveText("Compacting context…");
  await expect(state).toHaveAttribute("title", "Compacting context…");
  await expectActiveTurnIdentity(page, true);

  const compactionCompleted = {
    ...compactionStarted,
    summary: "Compacting context: completed",
    payload: {
      ...compactionStarted.payload,
      status: "completed",
    },
    updatedMs: startedAtMs + 2_000,
  };
  await emitTaskEvent(page, threadId, compactionCompleted, 3);
  await expect(state).toHaveText("Thinking");
  await expect(state).toHaveAttribute("title", "Thinking");
  await expectActiveTurnIdentity(page, true);
  await expect(
    page.getByText("Compacting context…", { exact: true }),
  ).toHaveCount(0);
});

test("preserves active-turn and spinner identity until the turn changes", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const threadId = "thread_active_turn_identity";
  const firstTurnId = "turn_active_identity_first";
  const secondTurnId = "turn_active_identity_second";
  const startedAtMs = Date.now() - 1_500;
  const initialTask = activeTask({
    threadId,
    title: "Active turn identity",
    turnId: firstTurnId,
    startedAtMs,
  });
  const started = turnEvent({
    id: "event_turn_started",
    threadId,
    turnId: firstTurnId,
    type: "turn_started",
    createdMs: startedAtMs,
    payload: { status: "inProgress" },
  });
  const initialDetail = taskDetail(initialTask, [started], 1);

  await routeTaskList(page, [initialTask]);
  await page.route(
    new RegExp(`/api/tasks/${threadId}(?:\\?|$)`),
    (route) => route.fulfill({ json: initialDetail }),
  );

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, {
    ...initialDetail,
    threadId,
  });
  const activeTurn = page.locator(
    `.task-turn-active[data-turn-id="${firstTurnId}"]`,
  );
  const duration = activeTurn.locator(".task-turn-active-duration");
  const state = activeTurn.locator(".task-turn-active-state");
  await expect(activeTurn).toBeVisible();
  await expect(state).toHaveText("Thinking");
  await expect(state).toHaveAttribute("aria-live", "polite");
  await rememberActiveTurnIdentity(page);

  expect(
    await page.evaluate(
      ({ threadId, detail }) => {
        const element = document.querySelector(".task-turn-active");
        const observer = new MutationObserver(() => {});
        observer.observe(element, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        const source = window.__activeTurnEventSources.find((candidate) =>
          candidate.url.includes(`/api/tasks/${threadId}/stream`),
        );
        if (!source) {
          throw new Error(`Missing detail stream for ${threadId}`);
        }
        source.emit("task-sync", { threadId, revision: 2, detail });
        const mutationCount = observer.takeRecords().filter((mutation) => {
          const target =
            mutation.target.nodeType === Node.ELEMENT_NODE
              ? mutation.target
              : mutation.target.parentElement;
          return !target?.closest(".task-turn-active-duration");
        }).length;
        observer.disconnect();
        return mutationCount;
      },
      {
        threadId,
        detail: taskDetail(initialTask, [started], 2),
      },
    ),
  ).toBe(0);
  await expectActiveTurnIdentity(page, true);
  await rememberActiveTurnAttachment(page);

  const initialDuration = await duration.textContent();
  await expect.poll(() => duration.textContent()).not.toBe(initialDuration);
  await expectActiveTurnIdentity(page, true);

  const command = turnEvent({
    id: "event_command_started",
    threadId,
    turnId: firstTurnId,
    type: "command_execution",
    createdMs: startedAtMs + 2_000,
    payload: {
      itemId: "command_started",
      status: "inProgress",
      command: "cargo test",
    },
  });
  await emitTaskEvent(page, threadId, command, 3);
  await expect(state).toHaveText("Running command");
  await expect(state).toHaveAttribute("title", "Running command");
  await expectActiveTurnIdentity(page, true);
  await expectActiveTurnAttachment(page);

  const fileChange = turnEvent({
    id: "event_file_change_started",
    threadId,
    turnId: firstTurnId,
    type: "file_change",
    createdMs: startedAtMs + 3_000,
    payload: {
      itemId: "file_change_started",
      status: "inProgress",
      paths: ["src/lib.rs"],
    },
  });
  const canonicalStartedAtMs = startedAtMs - 500;
  const canonicalTask = {
    ...initialTask,
    activeTurn: {
      ...initialTask.activeTurn,
      startedAtMs: canonicalStartedAtMs,
    },
  };
  await emitTaskSync(
    page,
    threadId,
    taskDetail(canonicalTask, [started, command, fileChange], 4),
    4,
  );
  await expect(state).toHaveText("Editing files");
  await expect(state).toHaveAttribute("title", "Editing files");
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${canonicalStartedAtMs}`,
  );
  await expectActiveTurnIdentity(page, true);
  await expectActiveTurnAttachment(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(activeTurn.locator(".task-active-turn-spinner")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expectActiveTurnIdentity(page, true);
  await expectActiveTurnAttachment(page);
  await forgetActiveTurnAttachment(page);

  const completed = turnEvent({
    id: "event_turn_completed",
    threadId,
    turnId: firstTurnId,
    type: "turn_completed",
    createdMs: startedAtMs + 4_000,
    payload: { status: "completed" },
  });
  const completedTask = {
    ...initialTask,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: startedAtMs + 4_000,
    recencyMs: startedAtMs + 4_000,
  };
  await emitTaskSync(
    page,
    threadId,
    taskDetail(
      completedTask,
      [started, command, fileChange, completed],
      5,
    ),
    5,
  );
  await expect(page.locator(".task-turn-active")).toHaveCount(0);
  await expectActiveTurnIdentity(page, false);

  const secondStartedAtMs = Date.now();
  const secondTask = activeTask({
    threadId,
    title: "Active turn identity",
    turnId: secondTurnId,
    startedAtMs: secondStartedAtMs,
  });
  const secondStarted = turnEvent({
    id: "event_second_turn_started",
    threadId,
    turnId: secondTurnId,
    type: "turn_started",
    createdMs: secondStartedAtMs,
    payload: { status: "inProgress" },
  });
  await emitTaskSync(
    page,
    threadId,
    taskDetail(
      secondTask,
      [started, command, fileChange, completed, secondStarted],
      6,
    ),
    6,
  );

  const secondActiveTurn = page.locator(
    `.task-turn-active[data-turn-id="${secondTurnId}"]`,
  );
  await expect(secondActiveTurn).toBeVisible();
  await expect(secondActiveTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${secondStartedAtMs}`,
  );
  expect(
    await secondActiveTurn.evaluate(
      (element) =>
        element !== window.__activeTurnIdentity.element &&
        element.querySelector(".task-active-turn-spinner") !==
          window.__activeTurnIdentity.spinner,
    ),
  ).toBe(true);

  await rememberActiveTurnIdentity(page);
  const interrupted = turnEvent({
    id: "event_second_turn_interrupted",
    threadId,
    turnId: secondTurnId,
    type: "turn_completed",
    createdMs: secondStartedAtMs + 1_000,
    payload: { status: "interrupted" },
  });
  const interruptedTask = {
    ...secondTask,
    ...canonicalTaskState("idle", { latestTurnStatus: "interrupted" }),
    updatedMs: secondStartedAtMs + 1_000,
    recencyMs: secondStartedAtMs + 1_000,
  };
  await emitTaskSync(
    page,
    threadId,
    taskDetail(
      interruptedTask,
      [started, command, fileChange, completed, secondStarted, interrupted],
      7,
    ),
    7,
  );
  await expect(page.locator(".task-turn-active")).toHaveCount(0);
  await expectActiveTurnIdentity(page, false);
});

test("does not reuse active-turn state between tasks with the same turn id", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const sharedTurnId = "turn_shared_between_tasks";
  const firstStartedAtMs = Date.now() - 5_000;
  const secondStartedAtMs = Date.now() - 1_000;
  const firstTask = activeTask({
    threadId: "thread_active_turn_first",
    title: "First active task",
    turnId: sharedTurnId,
    startedAtMs: firstStartedAtMs,
  });
  const secondTask = activeTask({
    threadId: "thread_active_turn_second",
    title: "Second active task",
    turnId: sharedTurnId,
    startedAtMs: secondStartedAtMs,
    activeFlags: ["waitingOnApproval"],
  });
  const details = new Map(
    [firstTask, secondTask].map((task) => [
      task.threadId,
      taskDetail(
        task,
        [
          turnEvent({
            id: `${task.threadId}_started`,
            threadId: task.threadId,
            turnId: sharedTurnId,
            type: "turn_started",
            createdMs: task.activeTurn.startedAtMs,
            payload: { status: "inProgress" },
          }),
        ],
        1,
      ),
    ]),
  );

  await routeTaskList(page, [firstTask, secondTask]);
  await page.route(
    /\/api\/tasks\/thread_active_turn_(?:first|second)(?:\?|$)/,
    (route) => {
      const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
      return route.fulfill({ json: details.get(threadId) });
    },
  );

  await page.goto(`/tasks/${firstTask.threadId}`);
  await emitTaskDetailBootstrap(page, {
    ...details.get(firstTask.threadId),
    threadId: firstTask.threadId,
  });
  const firstActiveTurn = page.locator(".task-turn-active");
  await expect(firstActiveTurn).toHaveAttribute(
    "data-conversation-entry-key",
    `active-turn:${firstTask.threadId}:${sharedTurnId}`,
  );
  await rememberActiveTurnIdentity(page);

  const secondTaskRow = page.locator(
    `caffold-task-navigator .task-row[data-thread-id="${secondTask.threadId}"]`,
  );
  if (!(await secondTaskRow.isVisible())) {
    await page.getByRole("button", { name: "Back to tasks" }).click();
  }
  await secondTaskRow.click();
  await emitTaskDetailBootstrap(page, {
    ...details.get(secondTask.threadId),
    threadId: secondTask.threadId,
  });
  await expect(page).toHaveURL(`/tasks/${secondTask.threadId}`);
  const secondActiveTurn = page.locator(".task-turn-active");
  await expect(secondActiveTurn).toHaveAttribute(
    "data-conversation-entry-key",
    `active-turn:${secondTask.threadId}:${sharedTurnId}`,
  );
  await expect(secondActiveTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${secondStartedAtMs}`,
  );
  await expect(secondActiveTurn.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
  expect(
    await secondActiveTurn.evaluate(
      (element) =>
        element !== window.__activeTurnIdentity.element &&
        element.querySelector(".task-active-turn-spinner") !==
          window.__activeTurnIdentity.spinner,
    ),
  ).toBe(true);
});

function activeTask({
  threadId,
  title,
  turnId,
  startedAtMs,
  activeFlags = [],
}) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      activeFlags,
      turnId,
      startedAtMs,
      latestTurnStatus: "inProgress",
    }),
    title,
    preview: "Working",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: startedAtMs,
    updatedMs: startedAtMs,
    recencyMs: startedAtMs,
    lastEventSummary: "Working",
    unseen: false,
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

function turnEvent({ id, threadId, turnId, type, createdMs, payload = {} }) {
  return {
    id,
    threadId,
    type,
    summary: type.replaceAll("_", " "),
    payload: { turnId, ...payload },
    createdMs,
  };
}

async function routeTaskList(page, tasks) {
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection(tasks) }),
  );
}

async function rememberActiveTurnIdentity(page) {
  await page.locator(".task-turn-active").evaluate((element) => {
    window.__activeTurnIdentity = {
      element,
      spinner: element.querySelector(".task-active-turn-spinner"),
      state: element.querySelector(".task-turn-active-state"),
    };
  });
}

async function expectActiveTurnIdentity(page, connected) {
  expect(
    await page.evaluate(({ connected }) => {
      const identity = window.__activeTurnIdentity;
      if (!identity) {
        return false;
      }
      if (!connected) {
        return !identity.element.isConnected && !identity.spinner.isConnected;
      }
      const current = document.querySelector(".task-turn-active");
      return (
        current === identity.element &&
        current?.querySelector(".task-active-turn-spinner") === identity.spinner &&
        current?.querySelector(".task-turn-active-state") === identity.state
      );
    }, { connected }),
  ).toBe(true);
}

async function rememberActiveTurnAttachment(page) {
  await page.locator(".task-turn-active").evaluate((activeTurn) => {
    const list = activeTurn.parentElement;
    if (!list) {
      throw new Error("Active turn is missing its conversation list");
    }
    const records = [];
    const collect = (mutations) => {
      for (const mutation of mutations) {
        if (
          [...mutation.addedNodes].includes(activeTurn) ||
          [...mutation.removedNodes].includes(activeTurn)
        ) {
          records.push({
            added: [...mutation.addedNodes].includes(activeTurn),
            removed: [...mutation.removedNodes].includes(activeTurn),
          });
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(list, { childList: true });
    window.__activeTurnAttachment = {
      activeTurn,
      collect,
      observer,
      records,
    };
  });
}

async function expectActiveTurnAttachment(page) {
  expect(
    await page.evaluate(() => {
      const attachment = window.__activeTurnAttachment;
      attachment.collect(attachment.observer.takeRecords());
      return attachment.records.splice(0);
    }),
  ).toEqual([]);
}

async function forgetActiveTurnAttachment(page) {
  await page.evaluate(() => {
    window.__activeTurnAttachment?.observer.disconnect();
    delete window.__activeTurnAttachment;
  });
}

async function emitTaskEvent(page, threadId, event, revision) {
  await page.evaluate(({ threadId, event, revision }) => {
    const source = window.__activeTurnEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    if (!source) {
      throw new Error(`Missing detail stream for ${threadId}`);
    }
    source.emit("task-event", { threadId, revision, event });
  }, { threadId, event, revision });
}

async function emitTaskSync(page, threadId, detail, revision) {
  await page.evaluate(({ threadId, detail, revision }) => {
    const source = window.__activeTurnEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    if (!source) {
      throw new Error(`Missing detail stream for ${threadId}`);
    }
    source.emit("task-sync", { threadId, revision, detail });
  }, { threadId, detail, revision });
}
