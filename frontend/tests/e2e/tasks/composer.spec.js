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
  pasteImage,
  routeTaskUploads,
  scrollTop,
  withAttachedFiles,
} from "../support/task-fixtures.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("starts a completed task follow-up clock only from canonical turn metadata", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__taskEventSources",
  });
  await mockAgentModels(page);

  const threadId = "thread_follow_up_clock";
  const firstTurnStartedMs = Date.now() - 2 * 60 * 60 * 1_000;
  const firstTurnCompletedMs = firstTurnStartedMs + 30_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Follow-up clock fixture",
    preview: "Initial answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: firstTurnStartedMs,
    updatedMs: firstTurnCompletedMs,
    recencyMs: firstTurnCompletedMs,
    lastEventSummary: "Initial answer",
  };
  const firstTurnEvents = [
    {
      id: "turn_initial:started",
      threadId,
      type: "turn_started",
      summary: "Turn started",
      payload: { turnId: "turn_initial" },
      position: { anchorMs: firstTurnStartedMs, index: 0 },
    },
    {
      id: "turn_initial:answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_initial",
        phase: "final",
        text: "Initial answer",
      },
      position: { anchorMs: firstTurnCompletedMs - 1, index: 0 },
    },
    {
      id: "turn_initial:completed",
      threadId,
      type: "turn_completed",
      summary: "Turn completed",
      payload: { turnId: "turn_initial", status: "completed" },
      position: { anchorMs: firstTurnCompletedMs, index: 0 },
    },
  ];
  const detail = (overrides = {}) => ({
    threadId,
    syncState: "ready",
    revision: overrides.revision ?? 1,
    eventRevision:
      overrides.eventRevision ?? overrides.revision ?? 1,
    task: { ...task, ...(overrides.task ?? {}) },
    events: overrides.events ?? firstTurnEvents,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    eventsRange: { from: null, to: null },
    historyLoading: false,
    permissionMode: "approveForMe",
  });

  let markPromptRequested;
  const promptRequested = new Promise((resolve) => {
    markPromptRequested = resolve;
  });
  let releasePromptResponse;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail()),
    }),
  );
  await page.route(
    new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`),
    async (route) => {
      await new Promise((resolve) => {
        releasePromptResponse = resolve;
        markPromptRequested();
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId,
          turnId: "turn_follow_up",
          userMessageId: "message-follow-up-1",
          steered: false,
        }),
      });
    },
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail());
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Start a fresh timed turn");
  await expect(form.locator(".task-primary-action-button")).toBeEnabled();
  await prompt.press("Enter");
  await promptRequested;

  const activeTurn = tasksPage.locator(".task-turn-active");
  await expect(activeTurn).toHaveCount(0);

  releasePromptResponse();
  await expect(form).toHaveAttribute("aria-busy", "false");
  const canonicalStartedMs = Date.now();
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-follow-up",
    });
  }, {
    threadId,
    detail: detail({
      revision: 2,
      task: {
        ...canonicalTaskState("active", {
          turnId: "turn_follow_up",
          startedAtMs: canonicalStartedMs,
          latestTurnStatus: "inProgress",
        }),
        updatedMs: canonicalStartedMs,
        recencyMs: canonicalStartedMs,
      },
      events: [
        ...firstTurnEvents,
        {
          id: "turn_follow_up:started",
          threadId,
          type: "turn_started",
          summary: "Turn started",
          payload: { turnId: "turn_follow_up" },
          position: { anchorMs: canonicalStartedMs, index: 0 },
        },
      ],
    }),
  });

  await expect(activeTurn).toHaveAttribute("data-turn-id", "turn_follow_up");
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${canonicalStartedMs}`,
  );
});
test("submits completed task follow-ups and reloads canonical messages", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, {
    registryKey: "__taskEventSources",
  });
  await mockAgentModels(page);

  const threadId = "thread_completed_follow_up";
  const now = 1_767_190_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Completed follow-up fixture",
    preview: "Initial canonical answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial canonical answer",
  };
  const initialEvent = {
    id: "event_initial_answer",
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: { turnId: "turn_initial", text: "Initial canonical answer" },
    position: { anchorMs: now, index: 0 },
  };
  let revision = 1;
  let canonicalEvents = [initialEvent];
  const submittedPrompts = [];
  const submittedBodies = [];
  let rejectedAttempts = 0;
  let timedOutAttempts = 0;
  const detail = () => ({
    revision,
    eventRevision: revision,
    task,
    events: canonicalEvents,
    eventsPage: { nextCursor: null },
    eventsRange: { from: null, to: null },
    pendingApprovals: [],
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail()) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), async (route) => {
    const body = route.request().postDataJSON();
    submittedPrompts.push(body.prompt);
    submittedBodies.push(body);
    if (body.prompt.startsWith("Rejected image prompt") && rejectedAttempts++ === 0) {
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "Follow-up rejected by fixture" }),
      });
    }
    if (body.prompt === "Timed out prompt" && timedOutAttempts++ === 0) {
      return route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "agent_timeout",
            message: "Codex app-server request timed out.",
          },
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId,
        turnId: `turn_follow_up_${submittedPrompts.length}`,
        userMessageId: `message-follow-up-${submittedPrompts.length}`,
        steered: false,
      }),
    });
  });

  const sent = await routeTaskUploads(page);

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail());
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  const send = form.locator(".task-primary-action-button");
  await expect(tasksPage).toContainText("Initial canonical answer");

  const runningEvent = {
    id: "event_external_running",
    threadId,
    type: "assistant_message",
    summary: "Assistant update",
    payload: {
      turnId: "turn_external_running",
      text: "External work is still running",
      status: "inProgress",
      startedAt: Math.floor(now / 1000),
    },
    position: { anchorMs: now + 1, index: 0 },
  };
  Object.assign(
    task,
    canonicalTaskState("active", {
      turnId: "turn_external_running",
      latestTurnStatus: "inProgress",
    }),
  );
  canonicalEvents = [...canonicalEvents, runningEvent];
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "external-canonical-running",
    });
  }, { threadId, detail: detail() });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect(tasksPage.locator(".task-turn-active")).toBeVisible();

  const conversation = tasksPage.locator(".task-conversation-scroll");
  await conversation.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40);
    element.dispatchEvent(new Event("scroll"));
  });
  const scrollBeforeSync = await conversation.evaluate((element) => element.scrollTop);

  // Synchronization progress is transport state. It must never replace the
  // canonical running task/turn state or reset the current conversation.
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "external-sync-start",
    });
  }, { threadId, detail: detail() });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect(tasksPage.locator(".task-turn-active")).toBeVisible();
  await expect(tasksPage).toContainText("External work is still running");
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(scrollBeforeSync);
  await expect(prompt).toBeEnabled();
  await expect(send).toHaveAttribute("data-primary-action", "stop");
  await expect(send).toBeEnabled();

  await prompt.fill("Submitted by button");
  await expect(send).toHaveAttribute("data-primary-action", "send");
  await expect(send).toBeEnabled();
  await activateActionHint(page, /Send prompt$/);
  await expect.poll(() => submittedPrompts).toEqual(["Submitted by button"]);
  await expect(tasksPage).toContainText("Submitted by button");
  await expect(tasksPage).toContainText("Submitted by button");
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).not.toBeFocused();

  canonicalEvents = [
    ...canonicalEvents,
    {
      id: "event_button_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: { turnId: "turn_follow_up_1", text: "Submitted by button" },
      position: { anchorMs: now + 1, index: 0 },
    },
    {
      id: "event_button_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_follow_up_1", text: "Button response" },
      position: { anchorMs: now + 2, index: 0 },
    },
  ];
  Object.assign(
    task,
    canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  );
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-button-response",
    });
  }, { threadId, detail: detail() });
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(tasksPage).toContainText("Button response");

  await prompt.fill("Submitted by Enter");
  await prompt.press("Enter");
  await expect.poll(() => submittedPrompts).toEqual([
    "Submitted by button",
    "Submitted by Enter",
  ]);
  await expect(tasksPage).toContainText("Submitted by Enter");
  await expect(prompt).not.toBeFocused();

  canonicalEvents = [
    ...canonicalEvents,
    {
      id: "event_enter_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: { turnId: "turn_follow_up_2", text: "Submitted by Enter" },
      position: { anchorMs: now + 3, index: 0 },
    },
    {
      id: "event_enter_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_follow_up_2", text: "Latest canonical response" },
      position: { anchorMs: now + 4, index: 0 },
    },
  ];
  revision += 1;
  await page.reload();
  await emitTaskDetailBootstrap(page, detail());
  await expect(tasksPage).toContainText("Submitted by Enter");
  await expect(tasksPage).toContainText("Latest canonical response");

  await prompt.fill("Rejected image prompt");
  await pasteImage(prompt, "retry-after-failure.png");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await send.click();
  await expect.poll(() => sent.uploads.length).toBe(1);
  const [firstUpload] = sent.uploads;
  expect(firstUpload.name).toBe("retry-after-failure.png");
  expect(firstUpload.bytes.subarray(1, 4).toString()).toBe("PNG");
  await expect
    .poll(() => submittedPrompts.at(-1))
    .toBe(withAttachedFiles("Rejected image prompt", [firstUpload.path]));
  expect(submittedBodies.at(-1).imagePaths).toEqual([firstUpload.path]);
  // The agent never received it, so nothing it uploaded stays.
  await expect.poll(() => sent.discarded).toEqual([firstUpload.folder]);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).not.toBeFocused();
  await expect(prompt).toHaveValue("Rejected image prompt");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(tasksPage).toContainText("Follow-up rejected by fixture");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Rejected image prompt",
    }),
  ).toHaveCount(0);

  await send.click();
  await expect.poll(() => sent.uploads.length).toBe(2);
  const retriedUpload = sent.uploads[1];
  await expect.poll(() => submittedPrompts.slice(-2)).toEqual([
    withAttachedFiles("Rejected image prompt", [firstUpload.path]),
    withAttachedFiles("Rejected image prompt", [retriedUpload.path]),
  ]);
  expect(submittedBodies.at(-1).imagePaths).toEqual([retriedUpload.path]);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toHaveValue("");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Rejected image prompt",
    }),
  ).toBeVisible();

  await prompt.fill("Timed out prompt");
  await prompt.press("Enter");
  await expect.poll(() => timedOutAttempts).toBe(1);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toHaveValue("");
  await expect(prompt).not.toBeFocused();
  await expect(tasksPage).toContainText("Codex app-server request timed out.");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Timed out prompt",
    }),
  ).toHaveAttribute("data-delivery-state", "outcomeUnknown");
});
test("keeps exact prompt order when Detail or live content arrives before the prompt response", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__taskEventSources",
  });
  await mockAgentModels(page);

  const threadId = "thread_canonical_item_ack";
  const now = 1_767_190_300_000;
  // Keep optimistic placement after the server positions so retaining the
  // browser clock would fail the exact-identity handoff assertion.
  await page.clock.setFixedTime(new Date(now + 1_000));
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Canonical item acknowledgement",
    preview: "Initial response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial response",
  };
  let revision = 1;
  let canonicalEvents = [
    {
      id: "event_initial_response",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_initial", text: "Initial response" },
      position: { anchorMs: now, index: 0 },
    },
  ];
  const submittedPrompts = [];
  let releaseFirstPrompt;
  const firstPromptGate = new Promise((resolve) => {
    releaseFirstPrompt = resolve;
  });
  let releaseSecondPrompt;
  const secondPromptGate = new Promise((resolve) => {
    releaseSecondPrompt = resolve;
  });
  const detail = () => ({
    revision,
    eventRevision: revision,
    task,
    events: canonicalEvents,
    eventsPage: { nextCursor: null },
    eventsRange: { from: null, to: null },
    pendingApprovals: [],
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail()) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), async (route) => {
    const body = route.request().postDataJSON();
    submittedPrompts.push(body.prompt);
    if (submittedPrompts.length === 1) {
      await firstPromptGate;
    } else if (submittedPrompts.length === 2) {
      await secondPromptGate;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId,
        turnId: `turn_${submittedPrompts.length}`,
        userMessageId: `message-${submittedPrompts.length}`,
        steered: false,
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail());
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  const primaryAction = form.locator(".task-primary-action-button");
  await expect(tasksPage).toContainText("Initial response");

  await prompt.fill("Canonical item prompt");
  await primaryAction.click();
  await expect.poll(() => submittedPrompts).toEqual(["Canonical item prompt"]);
  await expect(form).toHaveAttribute("aria-busy", "true");

  canonicalEvents = [
    ...canonicalEvents,
    {
      id: "event_canonical_item_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: {
        turnId: "turn_1",
        itemId: "message-1",
        content: [{ type: "input_text", text: "Canonical item prompt" }],
      },
      position: { anchorMs: now + 1, index: 0 },
    },
    {
      id: "event_canonical_item_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_1",
        itemId: "answer-1",
        text: "Canonical item answer",
      },
      position: { anchorMs: now + 2, index: 0 },
    },
  ];
  Object.assign(
    task,
    canonicalTaskState("active", {
      turnId: "turn_1",
      latestTurnStatus: "inProgress",
    }),
  );
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-item-ack",
    });
  }, { threadId, detail: detail() });

  await expect(tasksPage).toContainText("Canonical item prompt");
  const messages = tasksPage.locator(
    ".task-message, .task-assistant-message",
  );
  await expect(messages.nth(1)).toContainText("Canonical item prompt");
  await expect(messages.nth(2)).toContainText("Canonical item answer");
  await expect(form).toHaveAttribute("aria-busy", "true");
  releaseFirstPrompt();
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(messages.nth(1)).toContainText("Canonical item prompt");
  await expect(messages.nth(2)).toContainText("Canonical item answer");
  await expect(prompt).toBeEnabled();
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await expect(primaryAction).toBeEnabled();

  await prompt.fill("Submitted after canonical item acknowledgement");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "send");
  await expect(primaryAction).toBeEnabled();
  await primaryAction.click();
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical item prompt",
    "Submitted after canonical item acknowledgement",
  ]);
  await expect(form).toHaveAttribute("aria-busy", "true");

  const liveTurnAnchorMs = now + 3;
  const liveAnswerRevision = ++revision;
  const acceptedPromptRevision = ++revision;
  await page.evaluate((payload) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${payload.threadId}/stream`),
    );
    source.emit("task-event", {
      threadId: payload.threadId,
      revision: payload.liveAnswerRevision,
      eventRevision: payload.liveAnswerRevision,
      event: payload.liveAnswer,
    });
    source.emit("task-event", {
      threadId: payload.threadId,
      revision: payload.acceptedPromptRevision,
      eventRevision: payload.acceptedPromptRevision,
      event: payload.acceptedPrompt,
    });
  }, {
    threadId,
    liveAnswerRevision,
    acceptedPromptRevision,
    liveAnswer: {
      id: "event_live_race_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_2",
        itemId: "answer-2",
        text: "Live race answer",
      },
      position: { anchorMs: liveTurnAnchorMs, index: 2 },
    },
    acceptedPrompt: {
      id: "event_live_race_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt accepted",
      payload: {
        turnId: "turn_2",
        itemId: "message-2",
        text: "Submitted after canonical item acknowledgement",
      },
      position: { anchorMs: liveTurnAnchorMs, index: 1 },
    },
  });

  // Both live items must be rendered before POST supplies their exact prompt
  // identity. Delivery order does not change their backend-owned positions.
  await expect(
    tasksPage.locator('[data-event-id="event_live_race_prompt"]'),
  ).toContainText("Submitted after canonical item acknowledgement");
  await expect(
    tasksPage.locator('[data-event-id="event_live_race_answer"]'),
  ).toContainText("Live race answer");
  await expect(form).toHaveAttribute("aria-busy", "true");
  releaseSecondPrompt();
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(messages).toHaveCount(5);
  await expect(messages.nth(3)).toContainText(
    "Submitted after canonical item acknowledgement",
  );
  await expect(messages.nth(3)).toHaveAttribute(
    "data-event-id",
    "event_live_race_prompt",
  );
  await expect(messages.nth(4)).toContainText("Live race answer");
  await expect(messages.nth(4)).toHaveAttribute(
    "data-event-id",
    "event_live_race_answer",
  );

});
test("unlocks canonical follow-ups after switching tasks with a pending response", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);

  const now = 1_767_190_300_000;
  const taskA = {
    id: "thread_pending_a",
    threadId: "thread_pending_a",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Pending response task",
    preview: "Initial A response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial A response",
  };
  const taskB = {
    id: "thread_running_b",
    threadId: "thread_running_b",
    ...canonicalTaskState("active", {
      turnId: "turn_running_b",
      latestTurnStatus: "inProgress",
    }),
    title: "Externally running task",
    preview: "External work is running",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now - 100,
    updatedMs: now + 100,
    recencyMs: now + 100,
    lastEventSummary: "External work is running",
  };
  const revisions = new Map([
    [taskA.threadId, 1],
    [taskB.threadId, 1],
  ]);
  const eventsByThread = new Map([
    [
      taskA.threadId,
      [
        {
          id: "event_a_initial",
          threadId: taskA.threadId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: { turnId: "turn_a_initial", text: "Initial A response" },
          position: { anchorMs: now, index: 0 },
        },
      ],
    ],
    [
      taskB.threadId,
      Array.from({ length: 24 }, (_, index) => ({
        id: `event_b_progress_${index}`,
        threadId: taskB.threadId,
        type: "assistant_message",
        summary: "Assistant update",
        payload: {
          turnId: "turn_running_b",
          text: `External running update ${index + 1}`,
        },
        position: { anchorMs: now + index, index: 0 },
      })),
    ],
  ]);
  const taskFor = (threadId) =>
    threadId === taskA.threadId ? taskA : taskB;
  const detailFor = (threadId) => ({
    revision: revisions.get(threadId),
    eventRevision: revisions.get(threadId),
    task: taskFor(threadId),
    events: eventsByThread.get(threadId),
    eventsPage: { nextCursor: null },
    eventsRange: { from: null, to: null },
    pendingApprovals: [],
  });
  const submittedPrompts = [];
  const submittedBPrompts = [];
  let releaseFirstPrompt;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([taskA, taskB])),
    }),
  );
  await page.route(/\/api\/tasks\/(thread_pending_a|thread_running_b)(?:\?|$)/, (route) => {
    const threadId = route.request().url().match(/\/api\/tasks\/([^?]+)/)?.[1];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detailFor(threadId)),
    });
  });
  await page.route(/\/api\/tasks\/thread_pending_a\/prompts(?:\?|$)/, async (route) => {
    const body = route.request().postDataJSON();
    submittedPrompts.push(body.prompt);
    if (submittedPrompts.length === 1) {
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId: taskA.threadId,
        turnId: `turn_a_follow_up_${submittedPrompts.length}`,
        userMessageId: `message-a-${submittedPrompts.length}`,
        steered: false,
      }),
    });
  });
  await page.route(/\/api\/tasks\/thread_running_b\/prompts(?:\?|$)/, async (route) => {
    const body = route.request().postDataJSON();
    submittedBPrompts.push(body.prompt);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId: taskB.threadId,
        turnId: "turn_running_b",
        userMessageId: "message-b-running",
        steered: true,
      }),
    });
  });

  await page.goto(`/tasks/${taskA.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detailFor(taskA.threadId));
  const tasksPage = page.locator("caffold-tasks-page");
  const taskNavigator = page.locator("caffold-task-navigator");
  let form = tasksPage.locator(".task-follow-up-form");
  let prompt = form.locator('textarea[name="prompt"]');
  let send = form.locator(".task-primary-action-button");

  await prompt.fill("Canonical while response is pending");
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical while response is pending",
  ]);
  await expect(form).toHaveAttribute("aria-busy", "true");

  eventsByThread.set(taskA.threadId, [
    ...eventsByThread.get(taskA.threadId),
    {
      id: "event_a_canonical_prompt",
      threadId: taskA.threadId,
      type: "user_message",
      summary: "User prompt",
      payload: {
        turnId: "turn_a_follow_up_1",
        itemId: "message-a-1",
        text: "Canonical while response is pending",
      },
      position: { anchorMs: now + 200, index: 0 },
    },
    {
      id: "event_a_canonical_answer",
      threadId: taskA.threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_a_follow_up_1",
        text: "Canonical A response",
      },
      position: { anchorMs: now + 201, index: 0 },
    },
  ]);
  revisions.set(taskA.threadId, 2);

  await taskNavigator.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskB.threadId));
  await expect(tasksPage).toContainText("External running update 24");
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  form = tasksPage.locator(".task-follow-up-form");
  prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Steer B while A response is pending");
  await expect(send).toBeEnabled();
  await prompt.press("Enter");
  await expect.poll(() => submittedBPrompts).toEqual([
    "Steer B while A response is pending",
  ]);
  await expect(form).toHaveAttribute("aria-busy", "false");
  const conversation = tasksPage.locator(".task-conversation-scroll");
  await conversation.evaluate((element) => {
    element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
  });
  const savedScrollTop = await conversation.evaluate((element) => element.scrollTop);
  expect(savedScrollTop).toBeGreaterThan(0);

  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskA.threadId));
  await expect(tasksPage).toContainText("Canonical A response");
  form = tasksPage.locator(".task-follow-up-form");
  prompt = form.locator('textarea[name="prompt"]');
  send = form.locator(".task-primary-action-button");
  await expect(form).toHaveAttribute("aria-busy", "true");
  releaseFirstPrompt?.();
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toBeEnabled();
  await expect(send).toBeDisabled();

  await prompt.fill("Sent after canonical unlock");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical while response is pending",
    "Sent after canonical unlock",
  ]);
  await expect(form).toHaveAttribute("aria-busy", "false");

  await prompt.fill("Enter after canonical unlock");
  await prompt.press("Enter");
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical while response is pending",
    "Sent after canonical unlock",
    "Enter after canonical unlock",
  ]);

  await taskNavigator.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskB.threadId));
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(savedScrollTop);
});

test("places attachment remove controls over thumbnail corners inside the attachment strip", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);
  const form = page.locator('form[data-task-form="create"]');
  const prompt = form.locator('textarea[name="prompt"]');
  const attachments = form.locator(".task-composer-attachment");
  for (let count = 1; count <= 4; count += 1) {
    await pasteImage(prompt, `corner-${count}.png`);
    await expect(attachments).toHaveCount(count);
  }
  const strip = form.locator(".task-composer-attachments");
  const removes = form.locator(".task-composer-attachment-remove");

  for (const interfaceScalePercent of [90, 100, 120]) {
    await page.evaluate(async (value) => {
      const { setAppearanceRangeSetting } = await import("/assets/settings.js");
      setAppearanceRangeSetting("interfaceScalePercent", value);
    }, interfaceScalePercent);
    await prompt.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(removes.last()).toBeFocused();
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });

    const controls = await strip.evaluate(attachmentRemoveGeometry);
    for (const [index, control] of controls.entries()) {
      const label = `remove control ${index + 1} at ${interfaceScalePercent}%`;
      expect(
        control.centerInsetFromRight,
        `${label} centers a quarter circle inside the thumbnail's right edge`,
      ).toBeCloseTo(control.circleDiameter / 4, 0);
      expect(
        control.centerInsetFromTop,
        `${label} centers a quarter circle below the thumbnail's top edge`,
      ).toBeCloseTo(control.circleDiameter / 4, 0);
      expect(control.reachTop, `${label} stays inside the strip's top edge`).toBeGreaterThanOrEqual(
        control.stripTop,
      );
      expect(
        control.reachRight,
        `${label} stays clear of the next thumbnail or the strip's end`,
      ).toBeLessThanOrEqual(control.rightLimit);
    }
    for (let index = 0; index < controls.length; index += 1) {
      expect(
        await removes.nth(index).evaluate(receivesTapOutsideThumbnail),
        `remove control ${index + 1} at ${interfaceScalePercent}% receives taps outside its thumbnail`,
      ).toBe(true);
    }
  }
});

test("attaches files from the picker, the clipboard, and a drop onto the Composer", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);
  const form = page.locator('form[data-task-form="create"]');
  const prompt = form.locator('textarea[name="prompt"]');
  const panel = form.locator(".task-composer-panel");
  const files = form.locator(".task-composer-file");

  await form.getByRole("button", { name: "Attach files" }).click();
  await form.locator("input[data-composer-file-input]").setInputFiles([
    { name: "photo.heic", mimeType: "image/heic", buffer: Buffer.from("heic") },
  ]);
  await expect(files).toHaveCount(1);

  await prompt.evaluate((textarea) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(["a,b\n"], "table.csv", { type: "text/csv" }));
    textarea.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  await expect(files).toHaveCount(2);

  const dropped = await panel.evaluateHandle(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["log"], "server.log", { type: "text/plain" }));
    return dataTransfer;
  });
  await panel.dispatchEvent("dragover", { dataTransfer: dropped });
  await expect(panel).toHaveAttribute("data-drop-target", "");
  await panel.dispatchEvent("drop", { dataTransfer: dropped });
  await expect(panel).not.toHaveAttribute("data-drop-target");

  await expect(files).toHaveCount(3);
  await expect(files.nth(0)).toHaveAttribute("title", "photo.heic");
  await expect(files.nth(1)).toHaveAttribute("title", "table.csv");
  await expect(files.nth(2)).toHaveAttribute("title", "server.log");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(0);

  await files.nth(1).getByRole("button", { name: "Remove table.csv" }).click();
  await expect(files).toHaveCount(2);
});

test("stops at ten attachments and says so", { tag: "@desktop" }, async ({ page }) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);
  const form = page.locator('form[data-task-form="create"]');

  await form.locator("input[data-composer-file-input]").setInputFiles(
    Array.from({ length: 11 }, (_, index) => ({
      name: `note-${index + 1}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`${index}`),
    })),
  );

  await expect(form.locator(".task-composer-file")).toHaveCount(10);
  await expect(form.locator(".task-composer-attachment-error")).toHaveText(
    "Attach up to 10 files.",
  );
});

test("keeps a file chip to its name, its extension whole, within the Composer", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);
  const form = page.locator('form[data-task-form="create"]');
  const longName = `release-metadata-${"with-a-deliberately-long-directory-name-".repeat(4)}cache.json`;

  await form.locator("input[data-composer-file-input]").setInputFiles(
    ["a.md", "b.txt", longName].map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(name),
    })),
  );
  await expect(form.locator(".task-composer-file")).toHaveCount(3);
  await pasteImage(form.locator('textarea[name="prompt"]'), "shot.png");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await captureReviewScreenshot(page, testInfo, "tasks-composer-file-chips");

  const chips = await form.locator(".task-composer-files").evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    const contentRight = rowBox.right - Number.parseFloat(rowStyle.paddingRight);
    return [...row.querySelectorAll(".task-composer-file")].map((chip) => {
      const box = chip.getBoundingClientRect();
      const stem = chip.querySelector(".task-composer-file-stem");
      const extension = chip.querySelector(".task-composer-file-extension");
      return {
        top: Math.round(box.top),
        width: box.width,
        withinRow: box.right <= contentRight + 0.5,
        stemClipped: stem.scrollWidth > stem.clientWidth,
        extensionWhole: extension.scrollWidth <= extension.clientWidth,
        extension: extension.textContent,
        rowWidth: contentRight - rowBox.left,
      };
    });
  });
  const [short, alsoShort, long] = chips;
  expect(short.top, "short names share a line").toBe(alsoShort.top);
  expect(short.stemClipped).toBe(false);
  expect(short.width, "a short name's chip is only as wide as its name").toBeLessThan(
    short.rowWidth / 2,
  );
  expect(long.withinRow, "a long name stops at the Composer's edge").toBe(true);
  expect(long.stemClipped, "a long name gives up the end of its stem").toBe(true);
  expect(long.extensionWhole, "the extension stays whole").toBe(true);
  expect(long.extension).toBe(".json");
  for (const chip of chips) {
    expect(chip.withinRow).toBe(true);
  }
});

// Only the focused control draws its ring, so it supplies the ring width for all.
function attachmentRemoveGeometry(strip) {
  const ring = getComputedStyle(document.activeElement, "::before");
  const ringOutset =
    Number.parseFloat(ring.outlineWidth) + Number.parseFloat(ring.outlineOffset);
  const stripBox = strip.getBoundingClientRect();
  const thumbnails = [...strip.querySelectorAll(".task-composer-attachment")];
  return thumbnails.map((thumbnail, index) => {
    const remove = thumbnail.querySelector(".task-composer-attachment-remove");
    const hitBox = remove.getBoundingClientRect();
    const circleInset = Number.parseFloat(getComputedStyle(remove, "::before").top);
    const reachBeyondHitBox = Math.max(0, ringOutset - circleInset);
    const thumbnailBox = thumbnail.getBoundingClientRect();
    const nextThumbnail = thumbnails[index + 1];
    return {
      centerInsetFromRight: thumbnailBox.right - (hitBox.left + hitBox.width / 2),
      centerInsetFromTop: hitBox.top + hitBox.height / 2 - thumbnailBox.top,
      circleDiameter: hitBox.width - circleInset * 2,
      reachTop: hitBox.top - reachBeyondHitBox,
      reachRight: hitBox.right + reachBeyondHitBox,
      stripTop: stripBox.top,
      rightLimit: nextThumbnail
        ? nextThumbnail.getBoundingClientRect().left
        : stripBox.right,
    };
  });
}

function receivesTapOutsideThumbnail(remove) {
  remove.scrollIntoView({ block: "nearest", inline: "nearest" });
  const hitBox = remove.getBoundingClientRect();
  return remove.contains(document.elementFromPoint(hitBox.right - 1, hitBox.top + 1));
}
