import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  canonicalTaskState,
  isScrolledToBottom,
  mockCodexModels,
  scrollTop,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("raw active flags prioritize approval over user input", async ({ page }) => {
  await installTaskApiFixture(page);
  const detail = taskDetailFixture({ running: true });
  detail.task.threadStatus.activeFlags = [
    "waitingOnUserInput",
    "waitingOnApproval",
  ];
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");

  await expect(
    page.locator(
      '.task-detail-summary .task-status-chip[data-status="waiting_for_approval"]',
    ),
  ).toBeVisible();
  await expect(page.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
});

test("active task without a canonical turn omits controls and elapsed time", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  const detail = taskDetailFixture({ running: true });
  detail.task.latestTurnStatus = null;
  detail.task.activeTurn = null;
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");

  await expect(
    page.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Interrupt" })).toHaveCount(0);
  const active = page.locator(".task-turn-active");
  await expect(active).toBeVisible();
  await expect(active).not.toHaveAttribute("data-active-turn-started-ms");
  await expect(active.locator(".task-turn-active-duration")).toHaveText("Working");
});

test("loading detail accepts a canonical task sync without a synthetic task", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: {
        threadId: "thread-1",
        syncState: "loading",
        managed: true,
        revision: 0,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: true,
      },
    }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  await expect(page.getByText("Loading task...")).toBeVisible();
  await expect(page.locator(".task-detail")).toHaveCount(0);

  const detail = taskDetailFixture();
  detail.revision = 2;
  await page.evaluate((detail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-bootstrap",
    });
  }, detail);

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await expect(page.getByText("Loading task...")).toHaveCount(0);

  await page.evaluate((detail) => {
    window.__taskListSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail: { ...detail, managed: false },
      reason: "late-sync-after-removal",
    });
  }, detail);
  await expect(
    page.locator('.task-row[data-thread-id="thread-1"]'),
  ).toHaveCount(0);

  await page.evaluate(() => {
    const message = {
      threadId: "thread-1",
      revision: 3,
      detail: {
        threadId: "thread-1",
        syncState: "loading",
        managed: true,
        revision: 3,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: true,
      },
      reason: "canonical-source-error",
      error: "Codex app-server is unavailable",
    };
    window.__taskDetailSource.emit("task-sync", message);
    window.__taskListSource.emit("task-sync", message);
  });

  await expect(
    page.getByText("Task details are temporarily unavailable."),
  ).toBeVisible();
  await expect(
    page.locator(".task-detail-error-message"),
  ).toHaveText("Codex app-server is unavailable");
  await expect(page.locator(".task-detail")).toHaveCount(0);
  await expect(page.locator(".task-status-chip")).toHaveCount(0);
  await expect(
    page.locator('.task-list-section[data-task-section="managed"]'),
  ).toContainText("Codex app-server is unavailable");
  await expect(
    page.locator('.task-row[data-thread-id="thread-1"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-task-action="retry-task-detail"]'),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '.task-list-section[data-task-section="managed"] [data-task-action="retry-task-list"]',
    ),
  ).toHaveCount(1);
});

test("recovers task detail and prompt submission across bootstrap races", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve() },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__caffoldMockEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const now = 1_767_300_100_000;
  const taskRecord = (threadId, title) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} response`,
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: `${title} response`,
  });
  const detailFor = (task, revision, response) => ({
    revision,
    task,
    events: [
      {
        id: `${task.threadId}_assistant`,
        threadId: task.threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { turnId: `${task.threadId}_turn`, text: response },
        createdMs: now,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
  });
  const taskBeforeFailure = taskRecord(
    "thread_sync_before_failure",
    "Sync before request failure",
  );
  const taskAfterFailure = taskRecord(
    "thread_sync_after_failure",
    "Sync after request failure",
  );
  const detailBeforeFailure = detailFor(
    taskBeforeFailure,
    2,
    "The stream arrived before the failed request.",
  );
  const detailAfterFailure = detailFor(
    taskAfterFailure,
    2,
    "The stream recovered the failed request.",
  );

  let releaseFirstDetail;
  const firstDetailStarted = new Promise((resolve) => {
    releaseFirstDetail = { started: resolve, route: null };
  });
  const submittedPrompts = [];

  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method() === "GET" && segments.length === 2) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [taskBeforeFailure, taskAfterFailure] }),
      });
    }
    if (
      request.method() === "GET" &&
      segments.length === 3 &&
      segments[2] === taskBeforeFailure.threadId
    ) {
      releaseFirstDetail.route = route;
      releaseFirstDetail.started();
      await new Promise((resolve) => {
        releaseFirstDetail.fulfill = resolve;
      });
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "codex_process_unavailable",
            message: "Codex app-server is unavailable.",
          },
        }),
      });
    }
    if (
      request.method() === "GET" &&
      segments.length === 3 &&
      segments[2] === taskAfterFailure.threadId
    ) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "codex_process_unavailable",
            message: "Codex app-server is unavailable.",
          },
        }),
      });
    }
    if (
      request.method() === "POST" &&
      segments.length === 4 &&
      segments[3] === "prompts"
    ) {
      const body = request.postDataJSON();
      submittedPrompts.push({ threadId: segments[2], prompt: body.prompt });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId: segments[2],
          turnId: `${segments[2]}_follow_up`,
          steered: false,
        }),
      });
    }
    return route.continue();
  });

  const emitTaskSync = async (threadId, detail) => {
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.__caffoldMockEventSources.some((source) =>
              source.url.includes(`/api/tasks/${id}/stream`),
            ),
          threadId,
        ),
      )
      .toBe(true);
    await page.evaluate(({ threadId, detail }) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        detail,
        reason: "canonical-bootstrap",
      });
    }, { threadId, detail });
  };

  await page.goto(`/tasks/${taskBeforeFailure.threadId}?cwd=src`);
  await firstDetailStarted;
  const tasksPage = page.locator("caffold-tasks-page");
  await emitTaskSync(taskBeforeFailure.threadId, detailBeforeFailure);
  await expect(tasksPage).toContainText(
    "The stream arrived before the failed request.",
  );
  releaseFirstDetail.fulfill();
  await expect(tasksPage).not.toContainText("Codex app-server is unavailable.");

  let form = tasksPage.locator(".task-follow-up-form");
  let prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Submitted after the delayed failure");
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => submittedPrompts).toEqual([
    {
      threadId: taskBeforeFailure.threadId,
      prompt: "Submitted after the delayed failure",
    },
  ]);

  await page.goto(`/tasks/${taskAfterFailure.threadId}?cwd=src`);
  await expect(tasksPage).toContainText("Codex app-server is unavailable.");
  await emitTaskSync(taskAfterFailure.threadId, detailAfterFailure);
  await expect(tasksPage).toContainText(
    "The stream recovered the failed request.",
  );
  await expect(tasksPage).not.toContainText(
    "The stream arrived before the failed request.",
  );
  await expect(tasksPage).not.toContainText("Codex app-server is unavailable.");

  form = tasksPage.locator(".task-follow-up-form");
  prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Submitted after stream recovery");
  await prompt.press("Enter");
  await expect.poll(() => submittedPrompts).toEqual([
    {
      threadId: taskBeforeFailure.threadId,
      prompt: "Submitted after the delayed failure",
    },
    {
      threadId: taskAfterFailure.threadId,
      prompt: "Submitted after stream recovery",
    },
  ]);
});
test("keeps task context and retries after an initial detail timeout", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  const threadId = "thread_detail_timeout_fixture";
  const now = 1_767_200_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle"),
    title: "Recover delayed task detail",
    preview: "Canonical task summary",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Canonical task summary",
  };
  let detailRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_detail_timeout_fixture(?:\?|$)/, (route) => {
    detailRequests += 1;
    if (detailRequests === 1) {
      return route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "Codex app-server request timed out." }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 2,
        task,
        events: [
          {
            id: "event_recovered",
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: { text: "Recovered canonical response." },
            createdMs: now,
          },
        ],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Task details are temporarily unavailable.",
  );
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Codex app-server request timed out.",
  );
  await expect(tasksPage).toContainText("Recover delayed task detail");

  await tasksPage.locator('[data-task-action="retry-task-detail"]').click();
  await expect.poll(() => detailRequests).toBe(2);
  await expect(tasksPage).toContainText("Recovered canonical response.");
  await expect(tasksPage.locator(".task-detail-load-error")).toHaveCount(0);
});
test("accepts canonical task detail after stream revisions restart", async ({ page }) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_stream_bootstrap_after_completion";
  const now = 1_767_190_450_000;
  const staleTask = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_initial",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Stream bootstrap regression",
    preview: "Waiting for canonical response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Working",
  };
  const rawAmbientPrompt = [
    "This block is automatically supplied ambient UI state, not part of the user's request.",
    "## My request for Codex:",
    "Show only the canonical request.",
  ].join("\n");
  const userEvent = {
    id: "event_bootstrap_user_prompt",
    threadId,
    type: "user_message",
    summary: "User prompt",
    payload: {
      turnId: "turn_initial",
      item: {
        id: "item_bootstrap_user_prompt",
        type: "userMessage",
        content: [{ type: "input_text", text: rawAmbientPrompt }],
      },
    },
    createdMs: now,
  };
  const staleDetail = {
    revision: 43,
    task: staleTask,
    events: [userEvent],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  const canonicalDetail = {
    revision: 1,
    task: {
      ...staleTask,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      preview: "Canonical response arrived before the stream connected.",
      updatedMs: now + 2,
      lastEventSummary: "Canonical response arrived before the stream connected.",
    },
    events: [
      userEvent,
      {
        id: "event_bootstrap_assistant_response",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_initial",
          text: "Canonical response arrived before the stream connected.",
        },
        createdMs: now + 2,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [staleTask] }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(staleDetail) }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Show only the canonical request.");
  await expect(tasksPage).not.toContainText("automatically supplied ambient UI state");

  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__taskEventSources.some((source) =>
            source.url.includes(`/api/tasks/${id}/stream`),
          ),
        threadId,
      ),
    )
    .toBe(true);
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "stream-bootstrap",
    });
  }, { threadId, detail: canonicalDetail });

  await expect(tasksPage).toContainText(
    "Canonical response arrived before the stream connected.",
  );
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toHaveCount(0);
  await expect(tasksPage).not.toContainText("Working for");
  await expect(tasksPage.locator(".task-detail-loading")).toHaveCount(0);
});
test("accepts canonical task sync after stream revisions restart", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        if (url.startsWith("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError() {
        this.readyState = 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_list_revision_restart";
  const now = 1_767_190_475_000;
  let task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Task list revision restart",
    preview: "Initial result",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial result",
  };
  let taskListRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskListRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    });
  });
  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );

  await page.goto("/tasks");
  const row = page.locator(
    `caffold-tasks-page .task-row[data-thread-id="${threadId}"]`,
  );
  await expect(row).toHaveAttribute("data-task-status", "idle");

  await page.evaluate((threadId) => {
    window.__taskListEventSource.emit("task-event", {
      threadId,
      revision: 43,
      event: {
        id: "event_running_before_restart",
        threadId,
        type: "thread_status_changed",
        payload: { status: "running" },
        createdMs: Date.now(),
      },
    });
  }, threadId);
  await expect(row).toHaveAttribute("data-task-status", "idle");

  task = {
    ...task,
    ...canonicalTaskState("active", {
      turnId: "turn_before_restart",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
  };
  await page.evaluate(() => {
    window.__taskListEventSource.emitError();
    window.__taskListEventSource.emitOpen();
  });
  await expect.poll(() => taskListRequests).toBe(2);
  await expect(row).toHaveAttribute("data-task-status", "running");

  await page.evaluate(({ threadId, task }) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId,
      revision: 1,
      detail: {
        threadId,
        syncState: "ready",
        task,
      },
      reason: "canonical-idle-after-restart",
    });
  }, {
    threadId,
    task: {
      ...task,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    },
  });
  await expect(row).toHaveAttribute("data-task-status", "idle");
});
test("opens a running conversation at the latest message when stream sync wins the reload race", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Conversation reload scroll regression");
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, payload) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(payload) });
        }
      }

      close() {}
    };
  });
  await page.route("https://esm.sh/**", (route) => route.abort());
  await mockCodexModels(page);

  const threadId = "thread_reload_scroll_race";
  const now = 1_767_191_500_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_active",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Reload scroll race",
    preview: "Latest running response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 20,
    recencyMs: now + 20,
    lastEventSummary: "Latest running response",
  };
  const events = Array.from({ length: 20 }, (_, index) => ({
    id: `event_reload_scroll_${index}`,
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: {
      turnId: `turn_reload_scroll_${index}`,
      text: `Reload race response ${index + 1}.\n\n${"Long running conversation content. ".repeat(16)}`,
    },
    createdMs: now + index,
  }));
  const detail = (revision) => ({
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  let releaseDetailResponse;
  const detailResponseGate = new Promise((resolve) => {
    releaseDetailResponse = resolve;
  });

  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    await detailResponseGate;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail(2)),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThan(0);

  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: 1,
      detail,
      reason: "stream-bootstrap",
    });
  }, { threadId, detail: detail(1) });
  await expect(tasksPage).toContainText("Reload race response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);

  await page.evaluate(({ threadId, detail }) => {
    const scroller = document.querySelector(
      "caffold-tasks-page .task-conversation-scroll",
    );
    // A browser reload can restore a nested scroller before the async detail
    // request settles. That transient position must not become task history.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: 2,
      detail,
      reason: "running-progress",
    });
  }, { threadId, detail: detail(2) });
  const reachedLatestBeforeDetail = await isScrolledToBottom(scroller);
  releaseDetailResponse();

  expect(reachedLatestBeforeDetail).toBe(true);
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);
});
test("makes disconnected task state unavailable and reconciles an uncertain prompt", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, payload) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(payload) });
        }
      }

      emitOpen() {
        this.readyState = 1;
        for (const listener of this.listeners.get("open") ?? []) {
          listener({});
        }
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        for (const listener of this.listeners.get("error") ?? []) {
          listener({});
        }
      }

      close() {
        this.closed = true;
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_self_host_restart";
  const now = 1_767_210_000_000;
  const promptText = "Prompt accepted before the server stopped";
  let task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_before_restart",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Self-host restart fixture",
    preview: "Work is active",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Work is active",
  };
  let revision = 1;
  let reconnectDetailRead = null;
  let releaseReconnectDetailRead = null;
  let events = [
    {
      id: "event_before_restart",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_before_restart",
        text: "Work is active before the restart.",
      },
      createdMs: now,
    },
  ];
  let promptAccepted = false;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    await reconnectDetailRead;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail()),
    });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), (route) => {
    promptAccepted = true;
    revision += 1;
    task = {
      ...task,
      ...canonicalTaskState("idle", { latestTurnStatus: "interrupted" }),
      preview: "Restart interrupted the host task",
      updatedMs: now + 2,
      recencyMs: now + 2,
      lastEventSummary: "Restart interrupted the host task",
    };
    events = [
      ...events,
      {
        id: "event_prompt_after_restart",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: {
          turnId: "turn_after_restart",
          text: promptText,
        },
        createdMs: now + 1,
      },
      {
        id: "event_interrupted_after_restart",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_after_restart",
          phase: "commentary",
          text: "The host stopped after accepting the prompt.",
        },
        createdMs: now + 2,
      },
    ];
    return route.abort("failed");
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const textarea = form.locator('textarea[name="prompt"]');
  const taskRow = tasksPage.locator(
    `.task-row[data-thread-id="${threadId}"]`,
  );
  await expect(tasksPage).toContainText("Work is active before the restart.");

  reconnectDetailRead = new Promise((resolve) => {
    releaseReconnectDetailRead = resolve;
  });
  await page.evaluate((threadId) => {
    for (const source of window.__taskEventSources) {
      if (
        source.url.startsWith("/api/tasks/stream") ||
        source.url.includes(`/api/tasks/${threadId}/stream`)
      ) {
        source.emitOpen();
      }
    }
  }, threadId);

  await textarea.fill(promptText);
  await textarea.press("Enter");
  await expect.poll(() => promptAccepted).toBe(true);
  await expect(tasksPage.locator(".task-turn-active")).toBeVisible();

  await page.evaluate((threadId) => {
    for (const source of window.__taskEventSources) {
      if (
        source.url.startsWith("/api/tasks/stream") ||
        source.url.includes(`/api/tasks/${threadId}/stream`)
      ) {
        source.emitError();
      }
    }
  }, threadId);

  const uncertainPrompt = tasksPage
    .locator('.task-message[data-message-role="user"]')
    .filter({ hasText: promptText });
  await expect(uncertainPrompt).toHaveAttribute(
    "data-delivery-state",
    "outcomeUnknown",
  );
  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="reconnecting"]',
    ),
  ).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="running"]',
    ),
  ).toHaveCount(0);
  await expect(
    tasksPage.locator('[data-summary-action="interrupt"]'),
  ).toBeDisabled();
  await expect(textarea).toBeDisabled();
  await expect(taskRow).toHaveAttribute("data-task-status", "reconnecting");
  await expect(
    tasksPage.locator(
      '.task-stream-state[data-stream-state="reconnecting"]',
    ),
  ).toContainText("Caffold server connection lost");
  await expect(tasksPage.locator(".task-turn-active")).toBeHidden();

  await page.evaluate((threadId) => {
    for (const source of window.__taskEventSources) {
      if (
        source.url.startsWith("/api/tasks/stream") ||
        source.url.includes(`/api/tasks/${threadId}/stream`)
      ) {
        source.emitOpen();
      }
    }
  }, threadId);

  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="reconnecting"]',
    ),
  ).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-stream-state[data-stream-state="reconnecting"]',
    ),
  ).toBeVisible();
  releaseReconnectDetailRead();
  reconnectDetailRead = null;
  await expect(tasksPage).toContainText(
    "The host stopped after accepting the prompt.",
  );
  const canonicalPrompt = tasksPage
    .locator('.task-message[data-message-role="user"]')
    .filter({ hasText: promptText });
  await expect(canonicalPrompt).toHaveCount(1);
  await expect(canonicalPrompt).not.toHaveAttribute(
    "data-delivery-state",
    "outcomeUnknown",
  );
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="running"]',
    ),
  ).toHaveCount(0);
  await expect(taskRow).toHaveAttribute("data-task-status", "idle");
  await expect(textarea).toBeEnabled();

  await page.evaluate(() => {
    const listSource = window.__taskEventSources.find(
      (source) => source.url.startsWith("/api/tasks/stream") && !source.closed,
    );
    listSource.emitError();
  });
  await tasksPage.getByRole("button", { name: "New Task" }).click();
  const newTaskForm = tasksPage.locator(".task-new-form");
  await expect(newTaskForm.locator('textarea[name="prompt"]')).toBeDisabled();
  await expect(
    newTaskForm.getByRole("button", { name: "Start task" }),
  ).toBeDisabled();
});
