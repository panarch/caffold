import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  isScrolledToBottom,
  mockCodexModels,
  pasteImage,
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

test("active task without a canonical turn keeps a disabled composer Stop action", async ({
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
  await expect(
    page.locator(".task-detail-info-button .task-status-spinner"),
  ).toHaveCSS("color", "rgb(74, 74, 74)");
  await expect(page.getByRole("button", { name: "Interrupt" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Stop current turn", exact: true }),
  ).toBeDisabled();
  const active = page.locator(".task-turn-active");
  await expect(active).toBeVisible();
  await expect(active.locator(".task-status-spinner")).toHaveCSS(
    "color",
    "rgb(74, 74, 74)",
  );
  await expect(active).not.toHaveAttribute("data-active-turn-started-ms");
  await expect(active.locator(".task-turn-active-duration")).toHaveText("Working");
});

test("keeps the composer Stop action stable while an interrupt request is pending", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Interrupt request state is viewport-independent",
  );
  await installTaskApiFixture(page);
  const runningDetail = taskDetailFixture({ running: true });
  const stoppedDetail = taskDetailFixture();
  stoppedDetail.revision = 2;
  stoppedDetail.task.title = runningDetail.task.title;
  let interruptRequests = 0;
  let releaseInterrupt;
  const interruptGate = new Promise((resolve) => {
    releaseInterrupt = resolve;
  });
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: runningDetail }),
  );
  await page.route("**/api/tasks/thread-1/interrupt", async (route) => {
    interruptRequests += 1;
    await interruptGate;
    return route.fulfill({ json: stoppedDetail });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  const prompt = form.getByRole("textbox", { name: "Follow-up prompt" });
  const primaryAction = form.locator(".task-primary-action-button");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");

  await primaryAction.click();
  await expect.poll(() => interruptRequests).toBe(1);
  await expect(form).toHaveAttribute("aria-busy", "true");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await expect(primaryAction).toBeDisabled();

  await prompt.fill("Continue after the current turn stops");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "stop");
  await expect(primaryAction).toBeDisabled();
  expect(interruptRequests).toBe(1);

  releaseInterrupt();
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(primaryAction).toHaveAttribute("data-primary-action", "send");
  await expect(primaryAction).toBeEnabled();
});

test("updates stable detail regions and preserves an active IME composition", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  const detail = taskDetailFixture({
    running: true,
    model: "gpt-test",
    reasoningEffort: "medium",
  });
  const liveEvent = {
    id: "event-live-render-boundary",
    threadId: "thread-1",
    type: "assistant_message",
    summary: "Assistant response",
    payload: {
      turnId: "turn-1",
      text: "Only the conversation changed.",
    },
    createdMs: 3,
  };
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  await expect(form.locator(".task-model-button")).toContainText("Test");
  await expect(form.locator(".task-permission-button")).toContainText(
    "Auto review",
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__taskDetailSource)))
    .toBe(true);

  await prompt.focus();
  await prompt.evaluate((textarea) => {
    const detailElement = textarea.closest("caffold-task-detail");
    if (!detailElement) {
      throw new Error("Follow-up prompt is outside the task detail owner");
    }
    textarea.dispatchEvent(
      new CompositionEvent("compositionstart", {
        bubbles: true,
        data: "ㅎ",
      }),
    );
    textarea.value = "한";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    window.__detailRegionNodes = {
      summaryHeading: detailElement.querySelector(
        "caffold-task-detail-summary h2",
      ),
      conversationScroller: detailElement.querySelector(
        ".task-conversation-scroll",
      ),
      prompt: textarea,
    };
  });

  await page.evaluate((event) => {
    window.__taskDetailSource.emit("task-event", {
      threadId: "thread-1",
      revision: 2,
      event,
    });
  }, liveEvent);

  await expect(tasksPage).toContainText("Only the conversation changed.");
  expect(
    await tasksPage.evaluate((element) => {
      const nodes = window.__detailRegionNodes;
      return {
        summaryPreserved:
          element.querySelector("caffold-task-detail-summary h2") ===
          nodes.summaryHeading,
        conversationPreserved:
          element.querySelector(".task-conversation-scroll") ===
          nodes.conversationScroller,
        promptPreserved:
          element.querySelector(
            '.task-follow-up-form textarea[name="prompt"]',
          ) === nodes.prompt,
        promptValue: nodes.prompt.value,
        promptFocused: document.activeElement === nodes.prompt,
      };
    }),
  ).toEqual({
    summaryPreserved: true,
    conversationPreserved: true,
    promptPreserved: true,
    promptValue: "한",
    promptFocused: true,
  });

  await tasksPage.evaluate((element) => {
    const detailElement = element.querySelector("caffold-task-detail");
    window.__detailRegionNodes = {
      summaryHeading: detailElement.querySelector(
        "caffold-task-detail-summary h2",
      ),
      conversationScroller: detailElement.querySelector(
        ".task-conversation-scroll",
      ),
      prompt: detailElement.querySelector(
        '.task-follow-up-form textarea[name="prompt"]',
      ),
    };
  });
  await page.evaluate((nextDetail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: "thread-1",
      revision: nextDetail.revision,
      detail: nextDetail,
      reason: "equivalent-canonical-detail",
    });
  }, {
    ...detail,
    revision: 3,
    task: { ...detail.task },
    events: [liveEvent],
  });
  expect(
    await tasksPage.evaluate((element) => {
      const nodes = window.__detailRegionNodes;
      return {
        summaryPreserved:
          element.querySelector("caffold-task-detail-summary h2") ===
          nodes.summaryHeading,
        conversationPreserved:
          element.querySelector(".task-conversation-scroll") ===
          nodes.conversationScroller,
        promptPreserved:
          element.querySelector(
            '.task-follow-up-form textarea[name="prompt"]',
          ) === nodes.prompt,
      };
    }),
  ).toEqual({
    summaryPreserved: true,
    conversationPreserved: true,
    promptPreserved: true,
  });

  const completedDetail = {
    ...detail,
    revision: 4,
    task: {
      ...detail.task,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      updatedMs: 4,
      recencyMs: 4,
    },
    events: [liveEvent],
  };
  await page.evaluate((nextDetail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: "thread-1",
      revision: nextDetail.revision,
      detail: nextDetail,
      reason: "composition-boundary",
    });
  }, completedDetail);

  await expect(
    tasksPage.getByRole("button", { name: "Task details, idle" }),
  ).toBeVisible();
  expect(
    await tasksPage.evaluate((element) => {
      const composer = element.querySelector(
        ".task-follow-up-composer-slot > caffold-task-composer",
      );
      return {
        promptPreserved:
          element.querySelector(
            '.task-follow-up-form textarea[name="prompt"]',
          ) ===
          window.__detailRegionNodes.prompt,
        renderDeferred: composer.pendingRender,
      };
    }),
  ).toEqual({ promptPreserved: true, renderDeferred: true });

  await prompt.evaluate((textarea) => {
    textarea.value = "한글";
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "한글",
      }),
    );
  });

  await expect(prompt).toHaveValue("한글");
  await expect(prompt).toBeFocused();
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const composer = element.querySelector(
          ".task-follow-up-composer-slot > caffold-task-composer",
        );
        return !composer.compositionActive && !composer.pendingRender;
      }),
    )
    .toBe(true);
});

test("loading detail accepts a canonical task sync without a synthetic task", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([taskDetailFixture().task]) }),
  );
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({
      json: {
        threadId: "thread-1",
        syncState: "loading",
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
  const loadingMessage = page.getByText("Loading task...");
  await expect(loadingMessage).toBeVisible();
  const loadingClearance = await loadingMessage.evaluate((message) => {
    const close = document.querySelector(".task-workspace-back");
    const closeBounds = close.getBoundingClientRect();
    const textRange = document.createRange();
    textRange.selectNodeContents(message);
    return {
      closeVisible:
        getComputedStyle(close).display !== "none" && closeBounds.width > 0,
      closeRight: closeBounds.right,
      textLeft: textRange.getBoundingClientRect().left,
    };
  });
  if (loadingClearance.closeVisible) {
    expect(loadingClearance.textLeft).toBeGreaterThanOrEqual(
      loadingClearance.closeRight + 4,
    );
  }
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

  await page.evaluate(() => {
    const message = {
      threadId: "thread-1",
      revision: 3,
      detail: {
        threadId: "thread-1",
        syncState: "loading",
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
  await expect(page.locator(".task-detail")).toHaveCount(1);
  await expect(page.locator(".task-detail")).toBeHidden();
  await expect(page.locator(".task-status-chip")).toHaveCount(0);
  await expect(
    page.locator('.task-list-section[data-task-section="managed"]'),
  ).not.toContainText("Codex app-server is unavailable");
  await expect(
    page.locator('.task-row[data-thread-id="thread-1"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-task-action="retry-task-detail"]'),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '.task-list-section[data-task-section="managed"] [data-task-action="retry-task-list"]',
    ),
  ).toHaveCount(0);
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
        body: JSON.stringify(
          activeTaskProjection([taskBeforeFailure, taskAfterFailure]),
        ),
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
  await form.locator(".task-primary-action-button").click();
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
      body: JSON.stringify(activeTaskProjection([task])),
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
  const taskNavigator = page.locator("caffold-task-navigator");
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Task details are temporarily unavailable.",
  );
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Codex app-server request timed out.",
  );
  await expect(taskNavigator).toContainText("Recover delayed task detail");

  await tasksPage.locator('[data-task-action="retry-task-detail"]').click();
  await expect.poll(() => detailRequests).toBe(2);
  await expect(tasksPage).toContainText("Recovered canonical response.");
  await expect(tasksPage.locator(".task-detail-load-error")).toHaveCount(0);
});
test("preserves stable detail children through another task load failure", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Wide master-detail lifecycle regression",
  );
  await installTaskApiFixture(page);
  await page.unroute("**/api/tasks");

  const now = Date.now();
  const makeDetail = (threadId, title, { running = false } = {}) => {
    const detail = taskDetailFixture({
      running,
      model: "gpt-test",
      reasoningEffort: "medium",
    });
    detail.threadId = threadId;
    detail.task = {
      ...detail.task,
      id: threadId,
      threadId,
      title,
      preview: `${title} preview`,
      cwd: "src",
      cwdPath: "src",
      createdMs: now,
      updatedMs: now,
      recencyMs: now,
      activeTurn: running
        ? { id: `${threadId}-turn`, startedAtMs: now - 5_000 }
        : null,
    };
    detail.events = [
      {
        id: `${threadId}-assistant`,
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: `${threadId}-turn`,
          text: `${title} canonical response.`,
        },
        createdMs: now,
      },
    ];
    return detail;
  };
  const detailA = makeDetail("thread-stable-a", "Stable task A", {
    running: true,
  });
  const detailB = makeDetail("thread-stable-b", "Recover task B");
  let taskBRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: activeTaskProjection([detailB.task, detailA.task]),
    }),
  );
  await page.route(/\/api\/tasks\/thread-stable-a(?:\?|$)/, (route) =>
    route.fulfill({ json: detailA }),
  );
  await page.route(/\/api\/tasks\/thread-stable-b(?:\?|$)/, (route) => {
    taskBRequests += 1;
    return taskBRequests === 1
      ? route.fulfill({
          status: 504,
          json: { error: "Codex app-server request timed out." },
        })
      : route.fulfill({ json: detailB });
  });

  await page.goto("/tasks/thread-stable-a?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const taskNavigator = page.locator("caffold-task-navigator");
  await expect(tasksPage).toContainText("Stable task A canonical response.");
  const prompt = tasksPage.getByRole("textbox", { name: "Follow-up prompt" });
  await prompt.fill("Draft retained for task A");
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  const review = tasksPage.locator("caffold-task-review");
  await expect(review).toBeVisible();
  await review.evaluate((element) => {
    element.dataset.stableChild = "review";
    window.__stableTaskReview = element;
  });
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await tasksPage.evaluate((element) => {
    const markers = new Map([
      ["conversation", "caffold-task-conversation"],
      ["composer", "caffold-task-detail caffold-task-composer"],
    ]);
    for (const [name, selector] of markers) {
      element.querySelector(selector).dataset.stableChild = name;
    }
    window.__stableTaskComposer = element.querySelector(
      "caffold-task-detail caffold-task-composer",
    );
  });
  const conversation = tasksPage.locator(
    '[data-stable-child="conversation"]',
  );
  await expect
    .poll(() =>
      conversation.evaluate(
        (element) => element.activeTurnClockTimer !== null,
      ),
    )
    .toBe(true);

  await taskNavigator
    .locator('.task-row[data-thread-id="thread-stable-b"]')
    .click();
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Codex app-server request timed out.",
  );
  await expect(conversation).toHaveCount(1);
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const detail = element.querySelector("caffold-task-detail");
        return (
          detail.followUpComposers?.get("thread-stable-a") ===
            window.__stableTaskComposer &&
          !window.__stableTaskComposer.isConnected
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const detail = element.querySelector("caffold-task-detail");
        return (
          detail.reviewComponents?.get("thread-stable-a") ===
            window.__stableTaskReview &&
          !window.__stableTaskReview.isConnected
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      conversation.evaluate(
        (element) => element.activeTurnClockTimer === null,
      ),
    )
    .toBe(true);

  await tasksPage.locator('[data-task-action="retry-task-detail"]').click();
  await expect.poll(() => taskBRequests).toBe(2);
  await expect(tasksPage).toContainText("Recover task B canonical response.");
  await expect(conversation).toBeVisible();

  await taskNavigator
    .locator('.task-row[data-thread-id="thread-stable-a"]')
    .click();
  await expect(tasksPage).toContainText("Stable task A canonical response.");
  await expect(prompt).toHaveValue("Draft retained for task A");
  await expect(
    tasksPage.locator('[data-stable-child="composer"]'),
  ).toHaveCount(1);
});
test("keeps one Composer and its image draft per thread with a bounded clean inactive cache", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Wide master-detail Composer ownership regression",
  );
  await installTaskApiFixture(page);
  await page.unroute("**/api/tasks");

  const now = Date.now();
  const threadIds = Array.from(
    { length: 9 },
    (_, index) => `thread-composer-cache-${index}`,
  );
  const details = new Map(
    threadIds.map((threadId, index) => {
      const detail = taskDetailFixture({
        model: "gpt-test",
        reasoningEffort: "medium",
      });
      detail.threadId = threadId;
      detail.task = {
        ...detail.task,
        id: threadId,
        threadId,
        title: `Composer cache task ${index}`,
        preview: `Composer cache preview ${index}`,
        createdMs: now + index,
        updatedMs: now + index,
        recencyMs: now + index,
      };
      return [threadId, detail];
    }),
  );
  let promptRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        tasks: threadIds.map((threadId) => details.get(threadId).task),
        nextCursor: null,
      },
    }),
  );
  await page.route(
    /\/api\/tasks\/thread-composer-cache-\d+(?:\?|$)/,
    (route) => {
      const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
      return route.fulfill({ json: details.get(threadId) });
    },
  );
  await page.route(
    /\/api\/tasks\/thread-composer-cache-\d+\/prompts(?:\?|$)/,
    (route) => {
      promptRequests += 1;
      const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({
        json: { threadId, turnId: `${threadId}-turn`, steered: false },
      });
    },
  );

  await page.goto(`/tasks/${threadIds[0]}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const prompt = tasksPage.getByRole("textbox", { name: "Follow-up prompt" });
  await prompt.fill("Keep this thread-specific draft");
  await pasteImage(prompt, "thread-a-draft.png");
  const attachment = tasksPage.locator(
    '.task-follow-up-form .task-composer-attachment[title="thread-a-draft.png"]',
  );
  const previewImage = attachment.getByRole("button", {
    name: "Preview thread-a-draft.png",
  });
  const removeImage = attachment.getByRole("button", {
    name: "Remove thread-a-draft.png",
  });
  await expect(attachment).toHaveCount(1);
  const imageDraft = await attachment.evaluate((element) => {
    const preview = element.querySelector('[data-composer-action="preview-image"]');
    return {
      id: preview?.dataset.imageId ?? "",
      src: preview?.querySelector("img")?.getAttribute("src") ?? "",
    };
  });
  expect(imageDraft.id).not.toBe("");
  expect(imageDraft.src).toMatch(/^data:image\/png;base64,/);
  await tasksPage.evaluate((element) => {
    const detail = element.querySelector("caffold-task-detail");
    const composer = detail.followUpComposer();
    const image = composer.stateFor().images[0];
    composer.dataset.cacheIdentity = "stateful";
    window.__statefulTaskComposer = composer;
    window.__statefulTaskImage = image;
    window.__statefulTaskAttachment = composer.querySelector(
      ".task-composer-attachment",
    );
  });

  const workspaceNavigation = page.locator("caffold-task-workspace-navigation");
  await workspaceNavigation
    .locator('button[data-workspace-mode="settings"]')
    .click();
  await expect(page).toHaveURL("/settings");
  await expect(tasksPage).toBeHidden();
  const settingsRetention = await tasksPage.evaluate((element, threadId) => {
    const detail = element.querySelector("caffold-task-detail");
    const composer = detail.followUpComposers.get(threadId);
    return {
      sameComposer: composer === window.__statefulTaskComposer,
      sameImage: composer.stateFor().images[0] === window.__statefulTaskImage,
      sameAttachment:
        composer.querySelector(".task-composer-attachment") ===
        window.__statefulTaskAttachment,
      connected: composer.isConnected,
    };
  }, threadIds[0]);
  expect(settingsRetention).toEqual({
    sameComposer: true,
    sameImage: true,
    sameAttachment: true,
    connected: true,
  });
  await workspaceNavigation
    .locator('button[data-workspace-mode="tasks"]')
    .click();
  await expect(tasksPage).toBeVisible();
  await expect(prompt).toHaveValue("Keep this thread-specific draft");
  await expect(attachment).toHaveCount(1);

  await tasksPage.evaluate(async (element, threadId) => {
    await element.querySelector("caffold-task-detail").open(threadId);
    const detail = element.querySelector("caffold-task-detail");
    window.__oldestCleanTaskComposer =
      detail.followUpComposers.get(threadId);
  }, threadIds[1]);
  for (const threadId of threadIds.slice(2)) {
    await tasksPage.evaluate(async (element, targetThreadId) => {
      await element.querySelector("caffold-task-detail").open(targetThreadId);
    }, threadId);
  }

  const cache = await tasksPage.evaluate((element, ids) => {
    const detail = element.querySelector("caffold-task-detail");
    const active = detail.followUpComposer();
    const stateful = detail.followUpComposers.get(ids[0]);
    return {
      keys: [...detail.followUpComposers.keys()],
      statefulRetained: stateful === window.__statefulTaskComposer,
      statefulConnected: window.__statefulTaskComposer.isConnected,
      statefulImageRetained:
        stateful.stateFor().images[0] === window.__statefulTaskImage,
      oldestCleanRetained: detail.followUpComposers.has(ids[1]),
      oldestCleanConnected: window.__oldestCleanTaskComposer.isConnected,
      activeThreadId: active?.dataset.threadId ?? "",
      activeImageCount: active.stateFor().images.length,
      connectedComposers: element.querySelectorAll(
        "caffold-task-detail caffold-task-composer",
      ).length,
    };
  }, threadIds);
  expect(cache.keys).toHaveLength(8);
  expect(cache.statefulRetained).toBe(true);
  expect(cache.statefulConnected).toBe(false);
  expect(cache.statefulImageRetained).toBe(true);
  expect(cache.oldestCleanRetained).toBe(false);
  expect(cache.oldestCleanConnected).toBe(false);
  expect(cache.activeThreadId).toBe(threadIds.at(-1));
  expect(cache.activeImageCount).toBe(0);
  expect(cache.connectedComposers).toBe(1);
  await expect(attachment).toHaveCount(0);

  const staleSubmission = await tasksPage.evaluate(
    async (element, { staleThreadId, activeThreadId }) => {
      const detail = element.querySelector("caffold-task-detail");
      const composer = window.__statefulTaskComposer;
      const originalResolve = composer.resolveSubmission.bind(composer);
      let resolution = null;
      composer.resolveSubmission = (submissionId, result) => {
        resolution = result;
        return originalResolve(submissionId, result);
      };
      await detail.sendFollowUpSubmission(composer, {
        submissionId: "stale-submission",
        threadId: staleThreadId,
        prompt: "Do not send this stale prompt",
        images: [window.__statefulTaskImage.dataUrl],
        attachments: [window.__statefulTaskImage],
      });
      return {
        selectedThreadId: detail.selectedThreadId,
        activeThreadId,
        resolutionStatus: resolution?.status ?? "",
      };
    },
    {
      staleThreadId: threadIds[0],
      activeThreadId: threadIds.at(-1),
    },
  );
  expect(staleSubmission).toEqual({
    selectedThreadId: threadIds.at(-1),
    activeThreadId: threadIds.at(-1),
    resolutionStatus: "rejected",
  });
  expect(promptRequests).toBe(0);
  await prompt.fill("Keep this isolated Task B draft");

  await tasksPage.evaluate(async (element, threadId) => {
    const detail = element.querySelector("caffold-task-detail");
    await detail.open(threadId);
    if (
      detail.followUpComposer() !== detail.followUpComposers.get(threadId)
    ) {
      throw new Error("The activated clean cached Composer was evicted.");
    }
  }, threadIds[2]);
  await tasksPage.evaluate(async (element, threadId) => {
    await element.querySelector("caffold-task-detail").open(threadId);
  }, threadIds[0]);
  await expect(
    tasksPage.locator(
      'caffold-task-composer[data-cache-identity="stateful"]',
    ),
  ).toBeVisible();
  await expect(prompt).toHaveValue("Keep this thread-specific draft");
  await expect(attachment).toHaveCount(1);
  await expect(previewImage).toHaveAttribute("data-image-id", imageDraft.id);
  await expect(attachment.locator("img")).toHaveAttribute("src", imageDraft.src);
  await expect(removeImage).toBeVisible();
  const taskRetention = await tasksPage.evaluate((element) => {
    const detail = element.querySelector("caffold-task-detail");
    return {
      sameComposer: detail.followUpComposer() === window.__statefulTaskComposer,
      sameImage:
        detail.followUpComposer().stateFor().images[0] ===
        window.__statefulTaskImage,
    };
  });
  expect(taskRetention).toEqual({ sameComposer: true, sameImage: true });

  const previewDialog = tasksPage.locator(
    ":scope > caffold-task-image-preview-dialog > dialog",
  );
  await previewImage.click();
  await expect(previewDialog).toBeVisible();
  await expect(
    previewDialog.locator("[data-task-image-preview-name]"),
  ).toHaveText("thread-a-draft.png");
  await expect(
    previewDialog.locator("[data-task-image-preview-image]"),
  ).toHaveAttribute("src", imageDraft.src);
  await previewDialog
    .getByRole("button", { name: "Close image preview" })
    .click();
  await expect(previewDialog).not.toBeVisible();

  await removeImage.click();
  await expect(attachment).toHaveCount(0);

  await tasksPage.evaluate(async (element, threadId) => {
    await element.querySelector("caffold-task-detail").open(threadId);
  }, threadIds.at(-1));
  await expect(prompt).toHaveValue("Keep this isolated Task B draft");
  await expect(attachment).toHaveCount(0);
});

test("keeps prompt, interrupt, and approval request errors with their owning controls", async ({
  page,
}) => {
  await installTaskApiFixture(page);
  const detail = taskDetailFixture({
    running: true,
    model: "gpt-test",
    reasoningEffort: "medium",
  });
  detail.events = [
    {
      id: "event-request-error-approval",
      threadId: detail.threadId,
      type: "approval_requested",
      summary: "Approval requested",
      payload: {
        turnId: detail.task.activeTurn.id,
        approvalId: "approval-request-error",
        kind: "command",
        params: {
          command: ["cargo", "test"],
          cwd: "src",
          reason: "Run the regression tests",
          availableDecisions: ["accept", "decline"],
        },
      },
      createdMs: Date.now(),
    },
  ];
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/api/tasks/thread-1/interrupt", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "interrupt_failed",
          message: "Interrupt failed by fixture.",
        },
      },
    }),
  );
  await page.route(
    "**/api/tasks/thread-1/approvals/approval-request-error",
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: {
            code: "approval_failed",
            message: "Approval failed by fixture.",
          },
        },
      }),
  );
  await page.route("**/api/tasks/thread-1/prompts", (route) =>
    route.fulfill({
      status: 422,
      json: {
        error: {
          code: "prompt_rejected",
          message: "Prompt rejected by fixture.",
        },
      },
    }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const interruptError = tasksPage.locator(".task-composer-interrupt-error");
  const approvalCard = tasksPage.locator(
    '.task-approval-card:has([data-approval-id="approval-request-error"])',
  );
  const approvalError = approvalCard.locator(".task-approval-error");
  const composerError = tasksPage.locator(".task-composer-request-error");

  await tasksPage
    .getByRole("button", { name: "Stop current turn", exact: true })
    .click();
  await expect(interruptError).toHaveText("Interrupt failed by fixture.");
  await expect(approvalError).toHaveCount(0);
  await expect(composerError).toHaveCount(0);

  await approvalCard
    .locator('[data-task-action="approval"][data-decision="accept"]')
    .click();
  await expect(approvalError).toHaveText("Approval failed by fixture.");
  await expect(interruptError).toHaveText("Interrupt failed by fixture.");
  await expect(composerError).toHaveCount(0);

  const composer = tasksPage.locator(".task-follow-up-form");
  await composer
    .getByRole("textbox", { name: "Follow-up prompt" })
    .fill("Keep prompt errors in this composer");
  await composer.locator(".task-primary-action-button").click();
  await expect(composerError).toHaveText("Prompt rejected by fixture.");
  await expect(interruptError).toHaveText("Interrupt failed by fixture.");
  await expect(approvalError).toHaveText("Approval failed by fixture.");

  const ownedErrors = await tasksPage.evaluate((element) => {
    const detail = element.querySelector("caffold-task-detail");
    const summary = detail.querySelector("caffold-task-detail-summary");
    const conversation = detail.querySelector("caffold-task-conversation");
    const composer = detail.followUpComposer();
    return {
      detailErrorFields: ["error", "interruptError", "approvalErrors"].filter(
        (field) => Object.hasOwn(detail, field),
      ),
      summaryOwnsInterruptError: Object.hasOwn(summary, "interruptError"),
      interrupt: composer.context.interruptError,
      approval:
        conversation.approvalErrors
          .get("approval-request-error")
          ?.message ?? "",
      prompt: composer.context.requestError,
    };
  });
  expect(ownedErrors).toEqual({
    detailErrorFields: [],
    summaryOwnsInterruptError: false,
    interrupt: "Interrupt failed by fixture.",
    approval: "Approval failed by fixture.",
    prompt: "Prompt rejected by fixture.",
  });
});

test("canonical refresh clears errors and reconciles prompts without trusting older history", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Detail refresh ownership regression",
  );
  await installTaskApiFixture(page);
  const promptText = "Reconcile this prompt from the canonical refresh";
  const initialDetail = taskDetailFixture({
    model: "gpt-test",
    reasoningEffort: "medium",
  });
  initialDetail.eventsPage = { nextCursor: "older-matching-prompt" };
  let detailResponse = initialDetail;
  let releasePrompt;
  const promptGate = new Promise((resolve) => {
    releasePrompt = resolve;
  });

  await page.route(/\/api\/tasks\/thread-1(?:\?|$)/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === "older-matching-prompt") {
      return route.fulfill({
        json: {
          ...initialDetail,
          revision: 2,
          events: [
            {
              id: "event-older-matching-prompt",
              threadId: "thread-1",
              type: "user_message",
              summary: "User prompt",
              payload: {
                turnId: "turn-older-matching-prompt",
                text: promptText,
              },
              createdMs: 1,
            },
          ],
          eventsPage: { nextCursor: null },
        },
      });
    }
    return route.fulfill({ json: detailResponse });
  });
  await page.route("**/api/tasks/thread-1/prompts", async (route) => {
    await promptGate;
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-refresh-reconciled",
        steered: false,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const composer = tasksPage.locator(".task-follow-up-form");
  await composer
    .getByRole("textbox", { name: "Follow-up prompt" })
    .fill(promptText);
  await composer.locator(".task-primary-action-button").click();
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const detail = element.querySelector("caffold-task-detail");
        return {
          requests: detail.followUpRequests.size,
          submissions: detail.followUpComposer().activeSubmissions.size,
        };
      }),
    )
    .toEqual({ requests: 1, submissions: 1 });

  await tasksPage.evaluate(async (element) => {
    await element
      .querySelector("caffold-task-detail")
      .loadOlderEvents();
  });
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const detail = element.querySelector("caffold-task-detail");
        return {
          requests: detail.followUpRequests.size,
          submissions: detail.followUpComposer().activeSubmissions.size,
        };
      }),
    )
    .toEqual({ requests: 1, submissions: 1 });

  const unavailableDetail = {
    ...initialDetail,
    revision: 3,
  };
  await page.evaluate((detail) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-source-error",
      error: "Canonical refresh temporarily failed.",
    });
  }, unavailableDetail);
  await expect(
    tasksPage.locator(".task-detail-load-error-inline"),
  ).toContainText("Canonical refresh temporarily failed.");

  detailResponse = {
    ...initialDetail,
    revision: 4,
    events: [
      {
        id: "event-refresh-canonical-prompt",
        threadId: "thread-1",
        type: "user_message",
        summary: "User prompt",
        payload: {
          turnId: "turn-refresh-reconciled",
          text: promptText,
        },
        createdMs: Date.now(),
      },
    ],
  };
  await tasksPage.evaluate(async (element) => {
    await element
      .querySelector("caffold-task-detail")
      .refreshSelectedTask("thread-1");
  });

  await expect(
    tasksPage.locator(".task-detail-load-error-inline"),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const detail = element.querySelector("caffold-task-detail");
        return {
          requests: detail.followUpRequests.size,
          submissions: detail.followUpComposer().activeSubmissions.size,
        };
      }),
    )
    .toEqual({ requests: 0, submissions: 0 });

  releasePrompt();
});

test("canonical action responses reject foreign tasks and preserve history cursors", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Detail action response ownership regression",
  );
  await installTaskApiFixture(page);
  const initialDetail = taskDetailFixture({
    running: true,
    model: "gpt-test",
    reasoningEffort: "medium",
  });
  initialDetail.eventsPage = { nextCursor: "older-action-events" };
  let interruptRequests = 0;

  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: initialDetail }),
  );
  await page.route("**/api/tasks/thread-1/interrupt", (route) => {
    interruptRequests += 1;
    if (interruptRequests === 1) {
      return route.fulfill({
        json: {
          ...initialDetail,
          threadId: "foreign-thread",
          revision: 2,
          task: {
            ...initialDetail.task,
            id: "foreign-thread",
            threadId: "foreign-thread",
            title: "Foreign interrupt response",
          },
          eventsPage: { nextCursor: null },
          historyLoading: true,
        },
      });
    }
    return route.fulfill({
      json: {
        ...initialDetail,
        revision: 3,
        task: {
          ...initialDetail.task,
          title: "Canonical interrupt response",
        },
        eventsPage: { nextCursor: null },
        historyLoading: true,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  await tasksPage
    .getByRole("button", { name: "Stop current turn", exact: true })
    .click();
  await expect.poll(() => interruptRequests).toBe(1);
  await expect(
    tasksPage.getByRole("heading", { name: "Running task" }),
  ).toBeVisible();

  await tasksPage
    .getByRole("button", { name: "Stop current turn", exact: true })
    .click();
  await expect.poll(() => interruptRequests).toBe(2);
  await expect(
    tasksPage.getByRole("heading", { name: "Canonical interrupt response" }),
  ).toBeVisible();
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(1);
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const detail = element.querySelector("caffold-task-detail");
        return {
          threadId: detail.taskDetail?.task?.threadId,
          nextCursor: detail.eventsPage?.nextCursor,
        };
      }),
    )
    .toEqual({
      threadId: "thread-1",
      nextCursor: "older-action-events",
    });
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
      body: JSON.stringify(activeTaskProjection([staleTask])),
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
      body: JSON.stringify(activeTaskProjection([task])),
    });
  });
  await page.goto("/tasks");
  const row = page.locator(
    `caffold-task-navigator .task-row[data-thread-id="${threadId}"]`,
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
}, testInfo) => {
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
      body: JSON.stringify(activeTaskProjection([task])),
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
  const taskRow = page.locator(
    `caffold-task-navigator .task-row[data-thread-id="${threadId}"]`,
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
    tasksPage.getByRole("button", { name: "Stop current turn", exact: true }),
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
  if (testInfo.project.name === "phone") {
    await page
      .locator("caffold-task-workspace .task-workspace-back")
      .click();
    await expect(page).toHaveURL("/");
  }
  await page
    .locator("caffold-task-navigator")
    .getByRole("button", { name: "New Task" })
    .click();
  const newTaskForm = tasksPage.locator(".task-new-form");
  await expect(newTaskForm.locator('textarea[name="prompt"]')).toBeDisabled();
  await expect(
    newTaskForm.getByRole("button", { name: "Start task" }),
  ).toBeDisabled();
});
