import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  PASTED_IMAGE_BASE64,
  activeTaskProjection,
  canonicalTaskState,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  isScrolledToBottom,
  mockAgentModels,
  scrollTop,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("keeps a large task usable while conversation history is loading", { tag: "@all-viewports" }, async ({
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
        window.__caffoldRegisterTaskSseSource?.(this);
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
  await mockAgentModels(page);

  const threadId = "thread_large_history";
  const now = 1_767_300_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Large task history",
    preview: "Most recent response",
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "frontend/tests/e2e/fixtures/home",
    worktree: null,
    createdMs: now,
    updatedMs: now + 1,
    recencyMs: now + 1,
    lastEventSummary: "Assistant response",
  };
  const pendingDetail = {
    revision: 1,
    eventRevision: 0,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: true,
  };

  await page.route("**/api/tasks**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method() === "GET" && segments.length === 2) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeTaskProjection([task])),
      });
    }
    if (
      request.method() === "GET" &&
      segments.length === 3 &&
      segments[2] === threadId
    ) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pendingDetail),
      });
    }
    return route.continue();
  });

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, pendingDetail);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".task-detail-heading h2")).toContainText(
    "Large task history",
  );
  await expect(tasksPage.getByText("Loading task...")).toHaveCount(0);
  await expect(tasksPage.getByText("Loading conversation...")).toBeVisible();

  const composer = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await composer.fill("Keep this draft while history arrives");
  await expect
    .poll(() =>
      page.evaluate(() => window.__caffoldMockEventSources.length),
    )
    .toBeGreaterThan(0);

  const canonicalDetail = {
    ...pendingDetail,
    revision: 2,
    eventRevision: 2,
    historyLoading: false,
    events: [
      {
        id: "event_user",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: { text: "Load the recent history" },
        position: { anchorMs: now, index: 0 },
      },
      {
        id: "event_assistant",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "Recent history is ready." },
        position: { anchorMs: now + 1, index: 0 },
      },
    ],
  };
  await page.evaluate(({ threadId, canonicalDetail }) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: canonicalDetail.revision,
      detail: canonicalDetail,
      reason: "initial",
    });
  }, { threadId, canonicalDetail });

  await expect(tasksPage.getByText("Loading conversation...")).toHaveCount(0);
  await expect(tasksPage.getByText("Recent history is ready.")).toBeVisible();
  await expect(composer).toHaveValue("Keep this draft while history arrives");
});
test("keeps the visible conversation anchor while loading older events by cursor", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
        window.__caffoldRegisterTaskSseSource?.(this);
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
  await mockAgentModels(page);
  const threadId = "thread_cursor_fixture";
  const detailCursors = [];
  const now = 1_767_100_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("notLoaded"),
    title: "Long running thread",
    preview: "Latest answer",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 10,
    recencyMs: now + 10,
    lastEventSummary: "Latest answer",
  };
  const eventRecord = (id, type, summary, payload, offset) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    position: { anchorMs: now + offset, index: 0 },
  });
  const latestEvents = Array.from({ length: 12 }, (_, index) => {
    const isUserPrompt = index % 2 === 0;
    const blockNumber = index + 1;
    return eventRecord(
      `event_latest_${index}`,
      isUserPrompt ? "user_message" : "assistant_message",
      isUserPrompt ? "User prompt" : "Assistant response",
      {
        text: `${isUserPrompt ? "This is the latest prompt block" : "This is the latest answer block"} ${blockNumber}.\n\n${"Latest transcript line. ".repeat(18)}`,
      },
      10 + index,
    );
  });
  const olderPrompt = Array.from(
    { length: 28 },
    (_, index) => `Older prompt line ${index + 1} keeps the prepended page tall.`,
  ).join("\n");
  const olderFileLinkSource = "[Older source](older.rs#L7)";
  let releaseOlderImage;
  const olderImageGate = new Promise((resolve) => {
    releaseOlderImage = resolve;
  });
  const olderEvents = [
    eventRecord(
      "event_older",
      "user_message",
      "User prompt",
      {
        text: olderPrompt,
        content: [{ type: "localImage", path: "/tmp/older-image.png" }],
      },
      1,
    ),
    eventRecord(
      "event_older_answer",
      "assistant_message",
      "Assistant response",
      { text: olderFileLinkSource },
      2,
    ),
  ];
  const ancientEvents = [
    eventRecord(
      "event_ancient",
      "assistant_message",
      "Assistant response",
      {
        text: Array.from(
          { length: 20 },
          (_, index) => `Ancient answer line ${index + 1} expands the next page.`,
        ).join("\n"),
      },
      0,
    ),
  ];

  await page.route(/\/api\/task-image(?:\?|$)/, async (route) => {
    await olderImageGate;
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(PASTED_IMAGE_BASE64, "base64"),
    });
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    });
  });

  await page.route(/\/api\/tasks\/thread_cursor_fixture(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    const cursor = url.searchParams.get("cursor");
    detailCursors.push(cursor);
    const events = cursor === "older_cursor"
      ? olderEvents
      : cursor === "ancient_cursor"
        ? ancientEvents
        : latestEvents;
    const nextCursor = cursor === "older_cursor"
      ? "ancient_cursor"
      : cursor === "ancient_cursor"
        ? null
        : "older_cursor";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: cursor === "ancient_cursor" ? 4 : cursor === "older_cursor" ? 3 : 1,
        eventRevision: cursor === "ancient_cursor" ? 4 : cursor === "older_cursor" ? 3 : 1,
        task,
        events,
        fileLinks: cursor === "older_cursor"
          ? [
              {
                eventId: "event_older_answer",
                linkId: 0,
                target: "older.rs#L7",
                status: "resolved",
                path: "src/older.rs",
                taskRelativePath: "older.rs",
                line: 7,
              },
            ]
          : [],
        eventsPage: { nextCursor },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto("/tasks?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const taskRow = page.locator("caffold-task-navigator .task-row", {
    hasText: "Long running thread",
  });
  await expect(taskRow.locator(".task-row-time")).toBeVisible();
  await expect(taskRow).not.toContainText("notLoaded");
  await taskRow.click();
  await emitTaskDetailBootstrap(page, {
    threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events: latestEvents,
    eventsPage: { nextCursor: "older_cursor" },
    pendingApprovals: [],
    historyLoading: false,
  });
  await expect(tasksPage.locator(".task-detail-summary")).not.toContainText("notLoaded");
  await expect(tasksPage).toContainText("This is the latest answer block 12.");
  await expect(tasksPage).not.toContainText("This is the older prompt.");
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThan(0);
  await page.evaluate(
    ({ threadId, task }) => {
      const source = window.__taskEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: 2,
        reason: "session-bootstrap",
        detail: {
          revision: 2,
          // This is a newer live-projection cut, but provider history is still
          // loading. Its absent history entries are therefore not deletions.
          eventRevision: 2,
          task,
          events: [],
          eventsPage: { nextCursor: null },
          pendingApprovals: [],
          historyLoading: true,
        },
      });
    },
    { threadId, task },
  );
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(1);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
        return element.scrollHeight > element.clientHeight;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
        return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
      }),
    )
    .toBe(true);

  const visibleAnchor = await tasksPage
    .locator(".task-conversation-scroll")
    .evaluate((element) => {
      element.scrollTop = 0;
      const scrollerRect = element.getBoundingClientRect();
      const anchor = [...element.querySelectorAll(".task-event[data-event-id]")].find(
        (event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1,
      );
      const snapshot = {
        eventId: anchor?.dataset.eventId ?? "",
        offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : null,
      };
      element.dispatchEvent(new Event("scroll"));
      return snapshot;
    });
  expect(visibleAnchor.eventId).toBe("event_latest_0");
  await expect.poll(() => detailCursors).toContain("older_cursor");
  await expect(tasksPage).toContainText("Older prompt line 1");
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(1);
  await expect(
    tasksPage.locator(
      '.task-event[data-event-id="event_older_answer"] caffold-task-markdown',
    ),
  ).toHaveAttribute("data-render-state", "markdown");
  await expect(
    tasksPage
      .locator('.task-event[data-event-id="event_older_answer"] caffold-task-markdown')
      .getByRole("link", { name: "Older source" }),
  ).toHaveAttribute(
    "href",
    `/tasks/${threadId}/review?nav=files&view=source&file=older.rs&line=7`,
  );
  await expect
    .poll(async () => {
      const currentOffset = await tasksPage
        .locator('.task-event[data-event-id="event_latest_0"]')
        .evaluate((anchor) => {
          const scroller = anchor.closest(".task-conversation-scroll");
          return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
      return Math.abs(currentOffset - visibleAnchor.offset);
    })
    .toBeLessThan(1);

  releaseOlderImage();
  const olderImage = tasksPage.locator(
    '.task-event[data-event-id="event_older"] .task-message-attachment img',
  );
  await expect
    .poll(() => olderImage.evaluate((image) => image.naturalHeight))
    .toBeGreaterThan(0);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const offsetAfterImageLoad = await tasksPage
    .locator('.task-event[data-event-id="event_latest_0"]')
    .evaluate((anchor) => {
      const scroller = anchor.closest(".task-conversation-scroll");
      return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
  expect(Math.abs(offsetAfterImageLoad - visibleAnchor.offset)).toBeLessThan(1);

  const secondPageAnchor = await tasksPage
    .locator(".task-conversation-scroll")
    .evaluate((element) => {
      element.scrollTop = 0;
      const scrollerRect = element.getBoundingClientRect();
      const anchor = [...element.querySelectorAll(".task-event[data-event-id]")].find(
        (event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1,
      );
      const snapshot = {
        eventId: anchor?.dataset.eventId ?? "",
        offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : null,
      };
      element.dispatchEvent(new Event("scroll"));
      return snapshot;
    });
  expect(secondPageAnchor.eventId).toBe("event_older");
  await expect.poll(() => detailCursors).toContain("ancient_cursor");
  await expect(tasksPage).toContainText("Ancient answer line 1");
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(0);
  await expect(
    tasksPage.locator(
      '.task-event[data-event-id="event_ancient"] caffold-task-markdown',
    ),
  ).toHaveAttribute("data-render-state", "markdown");
  await expect
    .poll(async () => {
      const currentOffset = await tasksPage
        .locator('.task-event[data-event-id="event_older"]')
        .evaluate((anchor) => {
          const scroller = anchor.closest(".task-conversation-scroll");
          return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
      return Math.abs(currentOffset - secondPageAnchor.offset);
    })
    .toBeLessThan(1);
});
test("keeps the latest conversation when older history times out", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);
  const threadId = "thread_history_timeout_fixture";
  const now = 1_767_300_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle"),
    title: "Preserve latest task history",
    preview: "Latest canonical response",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Latest canonical response",
  };
  const latestEvents = Array.from({ length: 12 }, (_, index) => ({
    id: `event_latest_timeout_${index}`,
    threadId,
    type: index % 2 === 0 ? "user_message" : "assistant_message",
    summary: index % 2 === 0 ? "User prompt" : "Assistant response",
    payload: {
      text: `${index % 2 === 0 ? "Latest prompt" : "Latest response"} ${index + 1}. ${"Keep this visible. ".repeat(24)}`,
    },
    position: { anchorMs: now + index, index: 0 },
  }));
  const latestDetail = {
    threadId,
    revision: 1,
    eventRevision: 1,
    task,
    events: latestEvents,
    eventsPage: { nextCursor: "older-timeout-cursor" },
    pendingApprovals: [],
  };
  let olderRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(/\/api\/tasks\/thread_history_timeout_fixture(?:\?|$)/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === "older-timeout-cursor") {
      olderRequests += 1;
      if (olderRequests === 1) {
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
          eventRevision: 2,
          task,
          events: [
            {
              id: "event_older_recovered",
              threadId,
              type: "user_message",
              summary: "User prompt",
              payload: { text: "Recovered older prompt." },
              position: { anchorMs: now - 1, index: 0 },
            },
          ],
          eventsPage: { nextCursor: null },
          pendingApprovals: [],
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(latestDetail),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, latestDetail);
  const tasksPage = page.locator("caffold-tasks-page");
  const conversation = tasksPage.locator(".task-conversation-scroll");
  const textarea = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await expect(tasksPage).toContainText("Latest response 12.");
  await textarea.fill("Draft survives history timeout");

  await conversation.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => olderRequests).toBe(1);
  await expect(tasksPage.locator(".task-history-error")).toContainText(
    "Older messages are temporarily unavailable.",
  );
  await expect(tasksPage).toContainText("Latest response 12.");
  await expect(textarea).toHaveValue("Draft survives history timeout");

  await tasksPage.locator('[data-task-action="retry-task-history"]').click();
  await expect.poll(() => olderRequests).toBe(2);
  await expect(tasksPage).toContainText("Recovered older prompt.");
  await expect(tasksPage.locator(".task-history-error")).toHaveCount(0);
  await expect(textarea).toHaveValue("Draft survives history timeout");
});
test("renders normalized Codex user messages instead of raw ambient context", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);

  const threadId = "thread_normalized_user_message";
  const now = 1_767_190_400_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Normalized user message",
    preview: "Only this request should be visible.",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Only this request should be visible.",
  };
  const rawAmbientPrompt = [
    "# Files mentioned by the user:",
    "",
    "codex-clipboard-example.png: /tmp/codex-clipboard-example.png",
    "",
    '<in-app-browser-context source="ambient-ui-state">',
    "# In app browser:",
    "- Current URL: http://127.0.0.1:5178/tasks/example",
    "</in-app-browser-context>",
    "",
    "## My request for Codex:",
    "Only this request should be visible.",
  ].join("\n");
  const detail = {
    revision: 1,
    eventRevision: 1,
    task,
    events: [
      {
        id: "event_normalized_user_prompt",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: {
          turnId: "turn_initial",
          id: "item_normalized_user_prompt",
          type: "userMessage",
          content: [{ type: "input_text", text: rawAmbientPrompt }],
        },
        position: { anchorMs: now, index: 0 },
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail) }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Only this request should be visible.");
  await expect(tasksPage).not.toContainText("in-app-browser-context");
  await expect(tasksPage).not.toContainText("Files mentioned by the user");
});
test("orders separate turns by message chronology when a newer start marker is stale", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);

  const threadId = "thread_cross_turn_chronology";
  const oldMs = 1_767_192_000_000;
  const newMs = oldMs + 7 * 24 * 60 * 60 * 1_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Cross-turn chronology",
    preview: "New answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: oldMs,
    updatedMs: newMs,
    recencyMs: newMs,
    lastEventSummary: "New answer",
  };
  const event = (id, type, anchorMs, turnId, text = null, index = 0) => ({
    id,
    threadId,
    type,
    summary: type,
    payload: {
      threadId,
      turnId,
      ...(text === null ? {} : { text }),
      ...(type === "turn_completed" ? { status: "completed" } : {}),
    },
    position: { anchorMs, index },
  });
  const events = [
    event("new-start-stale", "turn_started", oldMs, "turn-new"),
    event("old-start", "turn_started", oldMs + 1_000, "turn-old"),
    event("old-user", "user_message", oldMs + 1_000, "turn-old", "Old prompt", 1),
    event(
      "old-answer",
      "assistant_message",
      oldMs + 1_000,
      "turn-old",
      "Old answer",
      2,
    ),
    event("old-completed", "turn_completed", oldMs + 2_000, "turn-old"),
    event("new-user", "user_message", newMs, "turn-new", "New prompt", 1),
    event(
      "new-answer",
      "assistant_message",
      newMs,
      "turn-new",
      "New answer",
      2,
    ),
    event("new-completed", "turn_completed", newMs + 1_000, "turn-new"),
  ];
  const detail = {
    threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: null,
    model: null,
    reasoningEffort: null,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail);
  const messages = page.locator(
    ".task-conversation .task-message, .task-conversation .task-assistant-message",
  );
  await expect
    .poll(() =>
      messages.evaluateAll((entries) =>
        entries.map((entry) => entry.dataset.eventId),
      ),
    )
    .toEqual(["old-user", "old-answer", "new-user", "new-answer"]);
});
test("keeps cross-turn work chronological and the active status at the timeline tail", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__crossTurnChronologySources",
    autoOpen: true,
  });
  await mockAgentModels(page);

  const threadId = "thread_cross_turn_work_chronology";
  const activeTurnId = "turn-A";
  const foreignTurnId = "turn-B";
  const now = 1_767_192_000_000;
  const activeTask = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: activeTurnId,
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Cross-turn work chronology",
    preview: "Keep the timeline chronological",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 2_000,
    recencyMs: now + 2_000,
    lastEventSummary: "Files changed",
  };
  const event = (id, type, anchorMs, turnId, payload = {}) => ({
    id,
    threadId,
    type,
    summary: type,
    payload: { threadId, turnId, ...payload },
    position: { anchorMs, index: 0 },
  });
  const user = event("event_user_a", "user_message", now, activeTurnId, {
    text: "Keep cross-turn work in order.",
  });
  const reasoning = event(
    "event_reasoning_a",
    "reasoning",
    now + 500,
    activeTurnId,
    {
      itemId: "reasoning_a",
      summary: ["Inspect the active timeline."],
    },
  );
  const foreignCommand = event(
    "event_command_b",
    "command_execution",
    now + 1_000,
    foreignTurnId,
    {
      itemId: "command_b",
      command: "cargo test",
      status: "completed",
      exitCode: 0,
      output: "test result: ok",
    },
  );
  const fileChange = event(
    "event_file_a",
    "file_change",
    now + 2_000,
    activeTurnId,
    {
      itemId: "file_a",
      status: "completed",
      paths: ["src/app.rs"],
    },
  );
  const activeDetail = {
    revision: 1,
    eventRevision: 1,
    task: activeTask,
    events: [user, reasoning, foreignCommand, fileChange],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([activeTask])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeDetail),
    }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, activeDetail);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Keep cross-turn work in order.");
  await expect
    .poll(() => page.evaluate(() => window.__crossTurnChronologySources.length))
    .toBeGreaterThan(0);

  const visibleTimelineOrder = () =>
    tasksPage.locator(".task-conversation").evaluate((conversation) =>
      [...conversation.children].map((entry) => {
        if (entry.classList.contains("task-turn-active")) {
          return `active:${entry.dataset.turnId}`;
        }
        if (entry.classList.contains("task-turn-work")) {
          return `work:${entry.dataset.turnId}`;
        }
        return entry.dataset.eventId ?? entry.dataset.eventType ?? null;
      }),
    );
  const emitTaskSync = (detail, revision) =>
    page.evaluate(({ threadId, detail, revision }) => {
      const source = window.__crossTurnChronologySources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", { threadId, revision, detail });
    }, { threadId, detail, revision });
  const emitTaskEvent = (entry, revision) =>
    page.evaluate(({ threadId, entry, revision }) => {
      const source = window.__crossTurnChronologySources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-event", {
        threadId,
        revision,
        eventRevision: revision,
        event: entry,
      });
    }, { threadId, entry, revision });

  expect(await visibleTimelineOrder()).toEqual([
    "event_user_a",
    "reasoning",
    "event_command_b",
    "event_file_a",
    `active:${activeTurnId}`,
  ]);
  await expect(
    tasksPage.locator(".task-conversation > .task-turn-active:last-child"),
  ).toHaveAttribute("data-turn-id", activeTurnId);

  await emitTaskSync(
    {
      ...activeDetail,
      revision: 2,
      events: [fileChange, reasoning, user, foreignCommand],
    },
    2,
  );
  expect(await visibleTimelineOrder()).toEqual([
    "event_user_a",
    "reasoning",
    "event_command_b",
    "event_file_a",
    `active:${activeTurnId}`,
  ]);

  const plan = event("event_plan_a", "plan", now + 3_000, activeTurnId, {
    itemId: "plan_a",
    text: "Keep the active status after every completed event.",
  });
  await emitTaskEvent(plan, 3);
  expect(await visibleTimelineOrder()).toEqual([
    "event_user_a",
    "reasoning",
    "event_command_b",
    "event_file_a",
    "plan",
    `active:${activeTurnId}`,
  ]);

  const finalAnswer = event(
    "event_final_a",
    "assistant_message",
    now + 4_000,
    activeTurnId,
    {
      itemId: "final_a",
      phase: "final",
      text: "The timeline remains chronological.",
    },
  );
  const turnCompleted = event(
    "event_turn_completed_a",
    "turn_completed",
    now + 5_000,
    activeTurnId,
    { status: "completed" },
  );
  const completedTask = {
    ...activeTask,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: now + 5_000,
    recencyMs: now + 5_000,
    lastEventSummary: "The timeline remains chronological.",
  };
  await emitTaskSync(
    {
      revision: 4,
      eventRevision: 4,
      task: completedTask,
      events: [
        turnCompleted,
        plan,
        foreignCommand,
        finalAnswer,
        fileChange,
        reasoning,
        user,
      ],
      eventsPage: { nextCursor: null },
      pendingApprovals: [],
    },
    4,
  );

  expect(await visibleTimelineOrder()).toEqual([
    "event_user_a",
    "event_command_b",
    `work:${activeTurnId}`,
    "event_final_a",
  ]);
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  await expect(tasksPage.locator(".task-turn-active")).toHaveCount(0);
});
test("keeps task event chronology stable through approval, completion, and reload", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
        window.__caffoldRegisterTaskSseSource?.(this);
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
  await mockAgentModels(page);

  const threadId = "thread_event_chronology";
  const turnId = "turn_event_chronology";
  const now = 1_767_192_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId,
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Event chronology",
    preview: "Keep task events ordered",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Working",
  };
  const event = (id, type, anchorMs, payload = {}) => ({
    id,
    threadId,
    type,
    summary: type,
    payload: { threadId, turnId, ...payload },
    position: { anchorMs, index: 0 },
  });
  const user = event("event_user", "user_message", now, {
    itemId: "user_1",
    text: "Keep every task event in order.",
  });
  const reasoning = event("event_reasoning", "reasoning", now + 100, {
    itemId: "reasoning_1",
    summary: ["Inspected the current event sequence."],
  });
  const commentary = event("event_commentary", "assistant_message", now + 200, {
    itemId: "commentary_1",
    phase: "progress",
    text: "I found the ordering boundary.",
  });
  const matchingCommentary = event(
    "event_matching_commentary",
    "assistant_message",
    now + 250,
    {
      itemId: "commentary_2",
      phase: "progress",
      text: "The event order is stable.",
    },
  );
  const approvalRequested = event(
    "event_approval_requested",
    "approval_requested",
    now + 300,
    {
      approvalId: "approval_chronology",
      turnId,
      itemId: "command_1",
      title: "Command approval requested",
      reason: "Run the regression test",
      command: "cargo test",
      cwd: "src",
      decisions: ["allow", "deny"],
    },
  );
  const approvalResolved = event(
    "event_approval_resolved",
    "approval_resolved",
    now + 350,
    {
      approvalId: "approval_chronology",
      kind: "command",
      outcome: "allow",
    },
  );
  const commandStarted = event(
    "event_command",
    "command_execution",
    now + 400,
    {
      itemId: "command_1",
      command: "cargo test",
      cwd: "src",
      status: "inProgress",
    },
  );
  const plan = event("event_plan", "plan", now + 500, {
    itemId: "plan_1",
    text: "Record the stable ordering contract.",
  });
  const commandCompleted = event(
    "event_command",
    "command_execution",
    now + 600,
    {
      itemId: "command_1",
      command: "cargo test",
      cwd: "src",
      status: "completed",
      exitCode: 0,
      durationMs: 1_600,
      output: "test result: ok",
    },
  );
  const finalAnswer = event("event_final", "assistant_message", now + 700, {
    itemId: "final_1",
    phase: "final",
    text: "The event order is stable.",
  });
  const threadIdle = event(
    "event_thread_idle",
    "thread_status_changed",
    now + 725,
    { status: "idle" },
  );
  const turnCompleted = event("event_turn_completed", "turn_completed", now + 800, {
    status: "completed",
  });
  let detailEvents = [user, reasoning, commentary];
  let detailTask = task;
  let detailRevision = 1;
  const currentDetail = () => ({
    threadId,
    revision: detailRevision,
    eventRevision: detailRevision,
    task: detailTask,
    events: detailEvents,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });

  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(currentDetail()),
    }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, currentDetail());
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("I found the ordering boundary.");
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThan(0);

  const emitTaskEvent = (entry, revision) =>
    page.evaluate(({ threadId, entry, revision }) => {
      const source = window.__taskEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-event", {
        threadId,
        revision,
        eventRevision: revision,
        event: entry,
      });
    }, { threadId, entry, revision });
  const emitTaskSync = (detail, revision) =>
    page.evaluate(({ threadId, detail, revision }) => {
      const source = window.__taskEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", { threadId, revision, detail });
    }, { threadId, detail, revision });
  const visibleEventOrder = () =>
    tasksPage.locator(".task-conversation").evaluate((conversation) =>
      [...conversation.children]
        .map((entry) => {
          if (entry.classList.contains("task-turn-active")) {
            return null;
          }
          if (entry.classList.contains("task-approval-flow")) {
            return "approval_requested";
          }
          return entry.dataset.eventType ?? null;
        })
        .filter(Boolean),
    );

  await emitTaskEvent(matchingCommentary, 2);
  await emitTaskEvent(approvalRequested, 3);
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(1);
  expect(await visibleEventOrder()).toEqual([
    "user_message",
    "reasoning",
    "assistant_message",
    "assistant_message",
    "approval_requested",
  ]);

  // The command Codex is asking about is announced while the question is
  // still open. It joins the turn; it does not replace the card.
  await emitTaskEvent(commandStarted, 4);
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(1);

  await emitTaskEvent(approvalResolved, 5);
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  expect(await visibleEventOrder()).toEqual([
    "user_message",
    "reasoning",
    "assistant_message",
    "assistant_message",
    "approval_resolved",
    "command_execution",
  ]);

  await emitTaskEvent(finalAnswer, 6);
  await emitTaskEvent(threadIdle, 7);
  await emitTaskEvent(plan, 8);
  await emitTaskEvent(commandCompleted, 9);
  await expect(tasksPage).toContainText("The event order is stable.");
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(0);
  await expect(tasksPage.locator(".task-turn-active")).toHaveCount(1);

  await emitTaskEvent(turnCompleted, 10);
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();

  const canonicalUser = {
    ...user,
    id: "event_canonical_user",
    position: { ...user.position, index: 1 },
  };
  const canonicalCommentary = {
    ...commentary,
    id: "event_canonical_commentary",
    position: { anchorMs: now, index: 2 },
  };
  const canonicalFinal = {
    ...finalAnswer,
    id: "event_canonical_final",
    position: { anchorMs: now, index: 3 },
    payload: {
      ...finalAnswer.payload,
      phase: "final",
    },
  };
  detailEvents = [
    user,
    reasoning,
    commentary,
    matchingCommentary,
    approvalRequested,
    approvalResolved,
    { ...commandCompleted, position: commandStarted.position },
    plan,
    finalAnswer,
    turnCompleted,
    canonicalUser,
    canonicalCommentary,
    canonicalFinal,
  ];
  detailTask = {
    ...task,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: turnCompleted.position.anchorMs,
    recencyMs: turnCompleted.position.anchorMs,
  };
  detailRevision = 12;
  await emitTaskSync(
    {
      revision: detailRevision,
      eventRevision: detailRevision,
      task: detailTask,
      events: detailEvents,
      eventsPage: { nextCursor: null },
      pendingApprovals: [],
    },
    detailRevision,
  );
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  const completedWorkOwner = tasksPage.locator("caffold-task-work-details");
  const completedWorkDetails = completedWorkOwner.locator(":scope > details");
  const completedWorkSummary = completedWorkDetails.locator(":scope > summary");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  await conversationScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => isScrolledToBottom(conversationScroller)).toBe(true);
  const disclosureOffset = await completedWorkSummary.evaluate((summary) => {
    const scroller = summary.closest(".task-conversation-scroll");
    return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  await completedWorkSummary.click();
  await expect(completedWorkDetails).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      completedWorkSummary.evaluate((summary) => {
        const scroller = summary.closest(".task-conversation-scroll");
        return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }),
    )
    .toBeCloseTo(disclosureOffset, 1);
  await expect.poll(() => isScrolledToBottom(conversationScroller)).toBe(false);
  const completedWorkOrder = () =>
    completedWorkOwner.locator(".task-work-details-item").evaluateAll((items) =>
      items.map((item) => item.dataset.eventType),
    );
  expect(await completedWorkOrder()).toEqual([
    "assistant_message",
    "reasoning",
    "assistant_message",
    "approval_resolved",
    "command_execution",
    "plan",
  ]);
  const liveWhileExpanded = event(
    "event_live_while_expanded",
    "assistant_message",
    now + 900,
    {
      turnId: "turn_2",
      phase: "progress",
      text: "New work arrived while older logs are open.",
    },
  );
  const disclosureOffsetBeforeLive = await completedWorkSummary.evaluate((summary) => {
    const scroller = summary.closest(".task-conversation-scroll");
    return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  await emitTaskEvent(liveWhileExpanded, 13);
  await expect(tasksPage).toContainText("New work arrived while older logs are open.");
  await expect(completedWorkDetails).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      completedWorkSummary.evaluate((summary) => {
        const scroller = summary.closest(".task-conversation-scroll");
        return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }),
    )
    .toBeCloseTo(disclosureOffsetBeforeLive, 1);
  await expect.poll(() => isScrolledToBottom(conversationScroller)).toBe(false);
  const completedCommandRow = tasksPage.locator(
    '.task-work-details-item[data-event-type="command_execution"] > caffold-task-command',
  );
  const completedCommandAction = completedCommandRow.getByRole("button", {
    name: "View output",
  });
  await expect(completedCommandRow).toContainText("Completed");
  await completedCommandAction.click();
  const commandDialog = tasksPage.locator("caffold-task-command-dialog dialog");
  await expect(completedWorkDetails).toHaveAttribute("open", "");
  await expect(commandDialog).toHaveAttribute("open", "");
  await expect(commandDialog).toContainText("cargo test");
  await expect(commandDialog).toContainText("test result: ok");

  await test.step("keeps the command dialog and work disclosure stable through a live rerender", async () => {
    await emitTaskEvent(turnCompleted, 14);
    await expect(completedWorkDetails).toHaveAttribute("open", "");
    await expect(commandDialog).toHaveAttribute("open", "");
    await expect(commandDialog).toContainText("test result: ok");
  });
  await commandDialog.getByRole("button", { name: "Close command output" }).click();
  await expect(completedCommandAction).toBeFocused();
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const final = element
          .querySelector("caffold-task-detail")
          .events.find(
          (entry) =>
            entry.type === "assistant_message" &&
            entry.payload?.phase === "final",
        );
        return final?.position?.anchorMs;
      }),
    )
    .toBe(canonicalFinal.position.anchorMs);
  await expect(
    tasksPage.locator(
      '.task-work-details-item[data-event-type="assistant_message"]',
    ),
  ).toHaveCount(2);

  await page.reload();
  await emitTaskDetailBootstrap(page, currentDetail());
  await expect(tasksPage).toContainText("The event order is stable.");
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  await tasksPage.locator("caffold-task-work-details > details > summary").click();
  expect(await completedWorkOrder()).toEqual([
    "assistant_message",
    "reasoning",
    "assistant_message",
    "approval_resolved",
    "command_execution",
    "plan",
  ]);
});
test("keeps task conversation scroll anchored during live updates", { tag: "@all-viewports" }, async ({ page }) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__taskEventSources.push(this);
        window.__caffoldRegisterTaskSseSource?.(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, data) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(data) });
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

  await mockAgentModels(page);
  const threadId = "thread_scroll_fixture";
  const now = 1_767_200_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", { latestTurnStatus: "inProgress" }),
    title: "Scroll fixture",
    preview: "Latest answer",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 20,
    recencyMs: now + 20,
    lastEventSummary: "Latest answer",
  };
  const eventRecord = (id, type, summary, payload, offset) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    position: { anchorMs: now + offset, index: 0 },
  });
  const events = Array.from({ length: 18 }, (_, index) =>
    eventRecord(
      `event_scroll_${index}`,
      "assistant_message",
      "Assistant response",
      {
        turnId: `turn_scroll_${index}`,
        text: `Existing answer block ${index + 1}.\n\n${"Scrollable transcript content. ".repeat(14)}`,
      },
      index,
    ),
  );
  const taskDetail = {
    threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: null,
    model: null,
    reasoningEffort: null,
  };
  let taskDetailReadRequests = 0;

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        files: [],
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_scroll_fixture(?:\?|$)/, async (route) => {
    taskDetailReadRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(taskDetail),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, taskDetail);
  const tasksPage = page.locator("caffold-tasks-page");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect(tasksPage).toContainText("Existing answer block 18.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
  expect(taskDetailReadRequests).toBe(0);

  await page.evaluate(
    ({ threadId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      taskSource.emit("task-event", {
        threadId,
        revision: 2,
        eventRevision: 2,
        event: {
          id: "event_live_bottom",
          threadId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: {
            turnId: "turn_live_bottom",
            text: `Live answer at the bottom.\n\n${"New live transcript content. ".repeat(16)}`,
          },
          position: { anchorMs: now + 100, index: 0 },
        },
      });
    },
    { threadId, now },
  );
  await expect(tasksPage).toContainText("Live answer at the bottom.");
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(
    ({ threadId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      taskSource.emit("task-event", {
        threadId,
        revision: 3,
        eventRevision: 3,
        event: {
          id: "event_live_preserve",
          threadId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: {
            turnId: "turn_live_preserve",
            text: `Live answer while reading older content.\n\n${"Preserve the reader position. ".repeat(16)}`,
          },
          position: { anchorMs: now + 101, index: 0 },
        },
      });
    },
    { threadId, now },
  );
  await expect(tasksPage).toContainText("Live answer while reading older content.");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(16);
  const readsBeforeBurst = taskDetailReadRequests;
  await page.evaluate(
    ({ threadId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      for (let index = 0; index < 3; index += 1) {
        taskSource.emit("task-event", {
          threadId,
          revision: 4 + index,
          eventRevision: 4 + index,
          event: {
            id: `event_burst_${index}`,
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: {
              turnId: "turn_burst",
              text: `Burst update ${index + 1}`,
            },
            position: { anchorMs: now + 200 + index, index: 0 },
          },
        });
      }
    },
    { threadId, now },
  );
  await expect(tasksPage).toContainText("Burst update 3");
  await page.waitForTimeout(100);
  expect(taskDetailReadRequests).toBe(readsBeforeBurst);

  const canonicalEvent = eventRecord(
    "event_external_sync",
    "assistant_message",
    "Assistant response",
    {
      turnId: "turn_external_sync",
      text: "Synced from an external Codex process.",
    },
    400,
  );
  await page.evaluate(({ threadId, taskDetail, canonicalEvent }) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emit("task-sync", {
      threadId,
      revision: 7,
      reason: "external-update",
      detail: {
        ...taskDetail,
        revision: 7,
        eventRevision: 7,
        events: [...taskDetail.events, canonicalEvent],
      },
    });
  }, { threadId, taskDetail, canonicalEvent });
  await expect(tasksPage).toContainText("Synced from an external Codex process.");
  expect(taskDetailReadRequests).toBe(readsBeforeBurst);

  await page.evaluate(({ threadId, taskDetail }) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emit("task-event", {
      threadId,
      revision: 6,
      eventRevision: 6,
      event: {
        id: "event_stale_revision",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { turnId: "turn_stale", text: "Stale event must stay hidden." },
        position: { anchorMs: Date.now(), index: 0 },
      },
    });
    taskSource.emit("task-sync", {
      threadId,
      revision: 6,
      reason: "stale-test",
      detail: {
        ...taskDetail,
        revision: 6,
        eventRevision: 6,
        events: [
          ...taskDetail.events,
          {
            id: "snapshot_stale_revision",
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: {
              turnId: "turn_stale_snapshot",
              text: "Stale snapshot must stay hidden.",
            },
            position: { anchorMs: Date.now(), index: 0 },
          },
        ],
      },
    });
  }, { threadId, taskDetail });
  await expect(tasksPage).not.toContainText("Stale event must stay hidden.");
  await expect(tasksPage).not.toContainText("Stale snapshot must stay hidden.");
});
