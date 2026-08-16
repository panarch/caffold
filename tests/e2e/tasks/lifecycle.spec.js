import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import {
  installBrowserDefaults,
  mockCodexStatus,
} from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockCodexModels,
  pasteImage,
  scrollTop,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

async function advanceClockUntil(page, predicate, {
  budgetMs,
  stepMs = 50,
}) {
  let elapsedMs = 0;
  while (!predicate() && elapsedMs < budgetMs) {
    const advanceMs = Math.min(stepMs, budgetMs - elapsedMs);
    await page.clock.runFor(advanceMs);
    elapsedMs += advanceMs;
    await page.evaluate(() => Promise.resolve());
  }
  expect(
    predicate(),
    `Condition was not reached within ${budgetMs}ms of virtual time`,
  ).toBe(true);
}

function transportOverlayTask(threadId) {
  const now = 1_767_190_475_000;
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Transport overlay stability",
    preview: "Stable conversation geometry",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Stable conversation geometry",
    unseen: false,
  };
}

async function installTransportOverlayFixture(page, threadId, registryKey) {
  const task = transportOverlayTask(threadId);
  const tasks = [
    task,
    ...Array.from({ length: 24 }, (_, index) => ({
      ...task,
      id: `${threadId}_${index + 1}`,
      threadId: `${threadId}_${index + 1}`,
      title: `Scrollable transport task ${index + 1}`,
      updatedMs: task.updatedMs - index - 1,
      recencyMs: task.recencyMs - index - 1,
    })),
  ];
  const detail = {
    threadId,
    syncState: "ready",
    revision: 1,
    task,
    events: [
      {
        id: "event_transport_overlay",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_transport_overlay",
          text: "Conversation stays fixed while transport notices change.",
        },
        createdMs: task.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  const bootstrapFunctionKey = `${registryKey}Bootstrap`;
  await installEventSourceMock(page, {
    registryKey,
    autoOpen: true,
    bootstrapFunctionKey,
  });
  await page.exposeFunction(bootstrapFunctionKey, (requestedThreadId) =>
    requestedThreadId === threadId ? detail : null,
  );
  await mockCodexModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );
}

async function elementGeometry(locator) {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function installConnectionMock(page) {
  await page.addInitScript(() => {
    const connection = new EventTarget();
    connection.type = "wifi";
    connection.effectiveType = "4g";
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: connection,
    });
  });
}

test("background Task tabs release list and detail streams", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__caffoldVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__caffoldVisibilityState,
    });
  });
  await installEventSourceMock(page, {
    registryKey: "__taskLifecycleEventSources",
    autoOpen: true,
  });
  await mockCodexModels(page);

  const threadId = "thread_background_stream_lifecycle";
  const now = 1_767_190_400_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Background stream lifecycle",
    preview: "Canonical detail loaded",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Canonical detail loaded",
  };
  const detail = {
    threadId,
    syncState: "ready",
    revision: 1,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  let detailReads = 0;
  let listReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail);
  await expect(page.locator("caffold-detail-layout")).toContainText(
    "Background stream lifecycle",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__taskLifecycleEventSources.filter(
          (source) => source.readyState !== 2,
        ).length,
      ),
    )
    .toBe(2);

  await page.evaluate(() => {
    window.__caffoldVisibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__taskLifecycleEventSources.every(
          (source) => source.readyState === 2,
        ),
      ),
    )
    .toBe(true);

  await page.evaluate(() => {
    window.__caffoldVisibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => listReads).toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__taskLifecycleEventSources.filter(
          (source) => source.readyState !== 2,
        ).length,
      ),
    )
    .toBe(2);
  await emitTaskDetailBootstrap(page, detail);
  expect(detailReads).toBe(0);
});

test("foreground recovery refreshes status and reconciles the Task ledger and transports", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__caffoldVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__caffoldVisibilityState,
    });
  });
  await installEventSourceMock(page, {
    registryKey: "__foregroundRecoverySources",
    autoOpen: true,
    bootstrapFunctionKey: "__foregroundRecoveryBootstrap",
  });
  await mockCodexModels(page);

  const threadId = "thread_foreground_recovery";
  const now = 1_767_190_450_000;
  const runtimeTask = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_foreground_recovery",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Foreground recovery before backgrounding",
    preview: "Initial runtime projection",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial runtime projection",
    conversationAvailable: true,
  };
  let foregroundState = false;
  let statusReads = 0;
  let listReads = 0;
  let detailReads = 0;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision: foregroundState ? 2 : 1,
    task: foregroundState
      ? { ...runtimeTask, title: "Foreground recovery renamed in Caffold" }
      : runtimeTask,
    events: [{
      id: foregroundState ? "event_recovered" : "event_initial",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_foreground_recovery",
        text: foregroundState
          ? "Detail reconciled after foreground recovery."
          : "Detail loaded before backgrounding.",
      },
      createdMs: now + (foregroundState ? 2 : 1),
    }],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  await page.exposeFunction("__foregroundRecoveryBootstrap", (requestedThreadId) =>
    requestedThreadId === threadId ? detail() : null,
  );

  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    const ledgerTask = foregroundState
      ? {
        ...runtimeTask,
        ...canonicalTaskState("notLoaded"),
        title: "Foreground recovery renamed in Caffold",
        preview: "",
        conversationAvailable: false,
      }
      : runtimeTask;
    return route.fulfill({
      json: {
        sections: [{
          id: foregroundState ? "section-after" : "section-before",
          name: foregroundState ? "src/Recovered Section" : "src/Original Section",
          repository: false,
          tasks: [ledgerTask],
        }],
        unsectioned: [],
      },
    });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: detail() });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const workspace = page.locator("caffold-task-workspace");
  const row = workspace.locator(`.task-row[data-thread-id="${threadId}"]`);
  const composer = workspace.locator('.task-follow-up-form textarea[name="prompt"]');
  await expect(row).toHaveAttribute("data-task-status", "running");
  await expect(workspace).toContainText("Detail loaded before backgrounding.");
  await composer.fill("Keep this foreground recovery draft");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__foregroundRecoverySources.filter(
          (source) => source.readyState !== 2,
        ).length,
      ),
    )
    .toBe(2);

  const readsBeforeHide = { statusReads, listReads, detailReads };
  foregroundState = true;
  await page.evaluate(() => {
    window.__caffoldVisibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__foregroundRecoverySources.every(
          (source) => source.readyState === 2,
        ),
      ),
    )
    .toBe(true);
  await page.waitForTimeout(300);
  expect({ statusReads, listReads, detailReads }).toEqual(readsBeforeHide);
  await expect(row).toHaveAttribute("data-task-status", "running");
  await expect(composer).toHaveValue("Keep this foreground recovery draft");

  await page.evaluate(() => {
    window.__caffoldVisibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => statusReads).toBeGreaterThan(readsBeforeHide.statusReads);
  await expect.poll(() => listReads).toBeGreaterThan(readsBeforeHide.listReads);
  expect(detailReads).toBe(readsBeforeHide.detailReads);
  await expect(row.locator(".task-row-title")).toHaveText(
    "Foreground recovery renamed in Caffold",
  );
  await expect(
    workspace.locator('.task-repository-select[title="src/Recovered Section"]'),
  ).toBeVisible();
  await expect(row).toHaveAttribute("data-task-status", "running");
  await expect(workspace).toContainText(
    "Detail reconciled after foreground recovery.",
  );
  await expect(composer).toHaveValue("Keep this foreground recovery draft");
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}(?:\\?|$)`));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__foregroundRecoverySources.filter(
          (source) => source.readyState !== 2,
        ).length,
      ),
    )
    .toBe(2);

  await page.evaluate(({ threadId, runtimeTask }) => {
    const listSource = [...window.__foregroundRecoverySources]
      .reverse()
      .find((source) => source.url.startsWith("/api/tasks/stream"));
    listSource.emit("task-list-snapshot", {
      tasks: [{
        ...runtimeTask,
        ...{
          threadStatus: { type: "idle" },
          latestTurnStatus: "completed",
          activeTurn: null,
        },
        title: "Foreground recovery renamed in Caffold",
      }],
    });
  }, { threadId, runtimeTask });
  await expect(row).toHaveAttribute("data-task-status", "idle");
  await expect(row.locator(".task-row-title")).toHaveText(
    "Foreground recovery renamed in Caffold",
  );
});

test("BFCache pageshow and top-level focus use the shared foreground recovery", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__foregroundSignalSources",
    autoOpen: true,
  });
  await mockCodexModels(page);
  const threadId = "thread_foreground_signals";
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Foreground signal recovery",
    preview: "Visible Task projection",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: 1_767_190_460_000,
    updatedMs: 1_767_190_460_000,
    recencyMs: 1_767_190_460_000,
    lastEventSummary: "Visible Task projection",
  };
  let statusReads = 0;
  let listReads = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return route.fulfill({ json: activeTaskProjection([task]) });
  });

  await page.goto("/tasks");
  await expect(
    page.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toBeVisible();
  expect(statusReads).toBe(1);
  expect(listReads).toBe(1);
  const beforePageShow = { statusReads, listReads };
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", {
      persisted: true,
    }));
  });
  await expect.poll(() => statusReads).toBeGreaterThan(beforePageShow.statusReads);
  await expect.poll(() => listReads).toBeGreaterThan(beforePageShow.listReads);
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-foreground-recovery-trigger",
    "pageshow",
  );

  const beforeFocus = { statusReads, listReads };
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => statusReads).toBeGreaterThan(beforeFocus.statusReads);
  await expect.poll(() => listReads).toBeGreaterThan(beforeFocus.listReads);
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-foreground-recovery-trigger",
    "focus",
  );
});

test("notification activation refreshes stale readiness and opens its pending Task route", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__notificationRecoverySources",
    autoOpen: true,
    bootstrapFunctionKey: "__notificationRecoveryBootstrap",
  });
  await mockCodexModels(page);
  const threadId = "thread_notification_pending_route";
  const now = 1_767_190_470_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("notLoaded"),
    title: "Notification pending Task",
    preview: "",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    conversationAvailable: false,
  };
  const blockedStatus = mockCodexStatus({
    readiness: {
      ...mockCodexStatus().readiness,
      state: "updateRequired",
      blocksTaskOperations: true,
      reasonCode: "versionBelowMinimum",
      diagnosticMessage: "The visible readiness snapshot is stale.",
    },
  });
  let ready = false;
  let statusReads = 0;
  let detailReads = 0;
  const detail = {
    threadId,
    syncState: "ready",
    revision: 1,
    task: {
      ...task,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      conversationAvailable: true,
    },
    events: [{
      id: "event_notification_recovered",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        text: "Pending Task opened after notification foreground recovery.",
      },
      createdMs: now + 1,
    }],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  await page.exposeFunction("__notificationRecoveryBootstrap", (requestedThreadId) =>
    ready && requestedThreadId === threadId ? detail : null,
  );
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return route.fulfill({ json: ready ? mockCodexStatus() : blockedStatus });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: detail });
  });

  await page.goto(`/tasks/${threadId}`);
  await expect(
    page.locator('[data-readiness-state="updateRequired"]'),
  ).toBeVisible();
  expect(detailReads).toBe(0);
  const readsBeforeActivation = statusReads;

  ready = true;
  await page.evaluate((route) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "caffold:notification-activation",
        route,
      },
    }));
  }, `/tasks/${threadId}`);

  await expect.poll(() => statusReads).toBeGreaterThan(readsBeforeActivation);
  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  expect(detailReads).toBe(0);
  await expect(page.locator("caffold-task-detail")).toContainText(
    "Pending Task opened after notification foreground recovery.",
  );
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}(?:\\?|$)`));
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-foreground-recovery-trigger",
    "notification",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__notificationRecoverySources.filter(
          (source) => source.readyState !== 2,
        ).length,
      ),
    )
    .toBe(2);
});

test("foreground recovery retries a blocking readiness snapshot with bounded backoff", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__foregroundRetrySources",
    autoOpen: true,
  });
  await mockCodexModels(page);
  const blockedStatus = mockCodexStatus({
    readiness: {
      ...mockCodexStatus().readiness,
      state: "updateRequired",
      blocksTaskOperations: true,
      reasonCode: "versionBelowMinimum",
      diagnosticMessage: "Foreground readiness has not recovered yet.",
    },
  });
  let recoveryBlockedReads = 0;
  let foregroundRecovery = false;
  let statusReads = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    if (foregroundRecovery && recoveryBlockedReads < 2) {
      recoveryBlockedReads += 1;
      return route.fulfill({ json: blockedStatus });
    }
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection() })
  );

  await page.goto("/tasks");
  await expect(page.locator("caffold-task-new .task-new-form")).toBeVisible();
  const readsBeforeRecovery = statusReads;
  foregroundRecovery = true;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(
    page.locator('[data-readiness-state="updateRequired"]'),
  ).toBeVisible();
  await expect.poll(() => recoveryBlockedReads).toBe(2);
  await expect.poll(() => statusReads).toBe(readsBeforeRecovery + 3);
  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
  const settledReads = statusReads;
  await page.waitForTimeout(500);
  expect(statusReads).toBe(settledReads);
});

test("fresh origin reachability recovers a foreground offline pause without an online edge", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const registryKey = "__foregroundOfflineSources";
  await installEventSourceMock(page, {
    registryKey,
    autoOpen: true,
    bootstrapFunctionKey: "__foregroundOfflineBootstrap",
  });
  await mockCodexModels(page);
  const threadId = "thread_foreground_offline";
  const task = transportOverlayTask(threadId);
  let recovered = false;
  let statusReads = 0;
  let listReads = 0;
  let detailReads = 0;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision: recovered ? 2 : 1,
    task,
    events: [
      {
        id: "event_foreground_offline",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_foreground_offline",
          text: recovered
            ? "Conversation reconciled after network recovery."
            : "Conversation stays available while offline.",
        },
        createdMs: task.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  await page.exposeFunction("__foregroundOfflineBootstrap", (requestedThreadId) =>
    requestedThreadId === threadId ? detail() : null,
  );

  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return route.fulfill({ json: activeTaskProjection([task]) });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: detail() });
  });

  await page.goto(`/tasks/${threadId}`);
  const appShell = page.locator("caffold-app-shell");
  const tasksPage = page.locator("caffold-tasks-page");
  const composer = tasksPage.locator(
    'caffold-task-composer[data-composer-mode="follow-up"] textarea',
  );
  await expect(tasksPage).toContainText("Conversation stays available while offline.");
  await composer.fill("Keep this foreground offline draft");
  await expect
    .poll(() =>
      page.evaluate((key) =>
        window[key].filter((source) => source.readyState !== 2).length,
      registryKey),
    )
    .toBe(2);

  const readsBeforeOffline = {
    detail: detailReads,
    list: listReads,
    status: statusReads,
  };
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  const notice = appShell.locator(".app-foreground-recovery");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-recovery-state", "offline");
  await expect(notice).toContainText(
    "No network connection. Waiting to reconnect...",
  );
  await expect(notice.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(notice.locator(".app-foreground-recovery-spinner")).toBeHidden();
  await expect(tasksPage).toContainText("Conversation stays available while offline.");
  await expect(composer).toHaveValue("Keep this foreground offline draft");
  await expect
    .poll(() =>
      page.evaluate((key) =>
        window[key].every((source) => source.readyState === 2),
      registryKey),
    )
    .toBe(true);

  await page.clock.runFor(30_000);
  expect({ detail: detailReads, list: listReads, status: statusReads }).toEqual(
    readsBeforeOffline,
  );
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-global-foreground-offline",
  );

  recovered = true;
  await page.evaluate(async () => {
    const { getHealth } = await import("/assets/api.js");
    await getHealth();
  });
  await expect(notice).toBeHidden();
  await expect(appShell).toHaveAttribute(
    "data-foreground-recovery-trigger",
    "origin",
  );
  await expect(tasksPage).toContainText(
    "Conversation reconciled after network recovery.",
  );
  await expect(composer).toHaveValue("Keep this foreground offline draft");
  expect(statusReads).toBe(readsBeforeOffline.status + 1);
  expect(listReads).toBe(readsBeforeOffline.list + 1);
  expect(detailReads).toBe(readsBeforeOffline.detail);
});

test("connection snapshots pause on missed offline and coalesce restored hints", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await installConnectionMock(page);
  const registryKey = "__connectionChangeSources";
  await installEventSourceMock(page, {
    registryKey,
    autoOpen: true,
    bootstrapFunctionKey: "__connectionChangeBootstrap",
  });
  await mockCodexModels(page);
  const threadId = "thread_connection_change";
  const task = transportOverlayTask(threadId);
  let disconnected = false;
  let recovered = false;
  let statusReads = 0;
  let listReads = 0;
  let detailReads = 0;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision: recovered ? 2 : 1,
    task,
    events: [
      {
        id: "event_connection_change",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_connection_change",
          text: recovered
            ? "Conversation reconciled after connection recovery."
            : "Conversation remains useful before connection loss.",
        },
        createdMs: task.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  await page.exposeFunction("__connectionChangeBootstrap", (requestedThreadId) =>
    !disconnected && requestedThreadId === threadId ? detail() : null,
  );

  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return disconnected
      ? route.abort("internetdisconnected")
      : route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return disconnected
      ? route.abort("internetdisconnected")
      : route.fulfill({ json: activeTaskProjection([task]) });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return disconnected
      ? route.abort("internetdisconnected")
      : route.fulfill({ json: detail() });
  });

  await page.goto(`/tasks/${threadId}`);
  const appShell = page.locator("caffold-app-shell");
  const tasksPage = page.locator("caffold-tasks-page");
  const composer = tasksPage.locator(
    'caffold-task-composer[data-composer-mode="follow-up"] textarea',
  );
  await expect(tasksPage).toContainText(
    "Conversation remains useful before connection loss.",
  );
  await composer.fill("Keep the connection-change draft");
  const readsBeforeDisconnect = {
    detail: detailReads,
    list: listReads,
    status: statusReads,
  };

  disconnected = true;
  await page.evaluate(() => {
    navigator.connection.type = "none";
    navigator.connection.dispatchEvent(new Event("change"));
  });

  const notice = appShell.locator(".app-foreground-recovery");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-recovery-state", "offline");
  await expect(notice).toContainText(
    "No network connection. Waiting to reconnect...",
  );
  await expect(tasksPage).toContainText(
    "Conversation remains useful before connection loss.",
  );
  await expect(composer).toHaveValue("Keep the connection-change draft");
  expect({ detail: detailReads, list: listReads, status: statusReads }).toEqual(
    readsBeforeDisconnect,
  );

  await page.clock.runFor(30_000);
  expect({ detail: detailReads, list: listReads, status: statusReads }).toEqual(
    readsBeforeDisconnect,
  );

  disconnected = false;
  recovered = true;
  await page.evaluate(() => {
    navigator.connection.type = "cellular";
    navigator.connection.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("online"));
  });

  await expect(notice).toBeHidden();
  await expect(tasksPage).toContainText(
    "Conversation reconciled after connection recovery.",
  );
  await expect(composer).toHaveValue("Keep the connection-change draft");
  expect(statusReads).toBe(readsBeforeDisconnect.status + 1);
  expect(listReads).toBe(readsBeforeDisconnect.list + 1);
  expect(detailReads).toBe(readsBeforeDisconnect.detail);
});

test("a late failed disconnect probe yields to a newer reconnect signal", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installConnectionMock(page);
  const registryKey = "__lateDisconnectProbeSources";
  await installEventSourceMock(page, {
    registryKey,
    autoOpen: true,
    bootstrapFunctionKey: "__lateDisconnectProbeBootstrap",
  });
  await mockCodexModels(page);
  const threadId = "thread_late_disconnect_probe";
  const task = transportOverlayTask(threadId);
  let recovered = false;
  let holdProbe = false;
  let heldProbe = false;
  let releaseProbe;
  let reportProbeStarted;
  let reportNewerProbeStarted;
  const probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const probeStarted = new Promise((resolve) => {
    reportProbeStarted = resolve;
  });
  const newerProbeStarted = new Promise((resolve) => {
    reportNewerProbeStarted = resolve;
  });
  let statusReads = 0;
  let listReads = 0;
  let detailReads = 0;
  let readsBeforeProbe = null;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision: recovered ? 2 : 1,
    task,
    events: [
      {
        id: "event_late_disconnect_probe",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_late_disconnect_probe",
          text: recovered
            ? "Conversation reconciled after the late failure."
            : "Conversation remains useful before the late failure.",
        },
        createdMs: task.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  await page.exposeFunction("__lateDisconnectProbeBootstrap", (requestedThreadId) =>
    requestedThreadId === threadId ? detail() : null,
  );

  await page.route(/\/api\/codex\/status(?:\?|$)/, async (route) => {
    statusReads += 1;
    if (readsBeforeProbe && statusReads === readsBeforeProbe.status + 2) {
      reportNewerProbeStarted();
    }
    if (holdProbe && !heldProbe) {
      heldProbe = true;
      reportProbeStarted();
      await probeGate;
      return route.abort("internetdisconnected");
    }
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return route.fulfill({ json: activeTaskProjection([task]) });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: detail() });
  });

  await page.goto(`/tasks/${threadId}`);
  const appShell = page.locator("caffold-app-shell");
  const tasksPage = page.locator("caffold-tasks-page");
  const composer = tasksPage.locator(
    'caffold-task-composer[data-composer-mode="follow-up"] textarea',
  );
  await expect(tasksPage).toContainText(
    "Conversation remains useful before the late failure.",
  );
  await composer.fill("Keep the late-failure draft");
  readsBeforeProbe = {
    detail: detailReads,
    list: listReads,
    status: statusReads,
  };

  holdProbe = true;
  await page.evaluate(() => {
    navigator.connection.type = "cellular";
    navigator.connection.dispatchEvent(new Event("change"));
  });
  await probeStarted;

  recovered = true;
  await page.evaluate(() => {
    navigator.connection.type = "wifi";
    navigator.connection.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("online"));
  });
  releaseProbe();
  await newerProbeStarted;

  const notice = appShell.locator(".app-foreground-recovery");
  await expect(notice).toBeHidden();
  await expect(tasksPage).toContainText(
    "Conversation reconciled after the late failure.",
  );
  await expect(composer).toHaveValue("Keep the late-failure draft");
  expect(statusReads).toBe(readsBeforeProbe.status + 2);
  expect(listReads).toBeGreaterThan(readsBeforeProbe.list);
  expect(detailReads).toBe(readsBeforeProbe.detail);
});

test("failed server recovery keeps useful Task UI behind one bounded global fallback", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const registryKey = "__offlineForegroundSources";
  await installEventSourceMock(page, {
    registryKey,
    autoOpen: true,
    bootstrapFunctionKey: "__offlineForegroundBootstrap",
  });
  await mockCodexModels(page);
  const threadId = "thread_offline_foreground";
  const task = transportOverlayTask(threadId);
  let unavailable = false;
  let recovered = false;
  let statusReads = 0;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision: recovered ? 2 : 1,
    task,
    events: [
      {
        id: "event_offline_foreground",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_offline_foreground",
          text: recovered
            ? "Conversation reconciled after recovery."
            : "Conversation stays available during recovery.",
        },
        createdMs: task.updatedMs,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  await page.exposeFunction("__offlineForegroundBootstrap", (requestedThreadId) =>
    requestedThreadId === threadId ? detail() : null,
  );

  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return unavailable
      ? route.fulfill({
          status: 502,
          json: { error: { message: "Caffold server unavailable." } },
        })
      : route.fulfill({ json: mockCodexStatus() });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    unavailable
      ? route.fulfill({
          status: 502,
          json: { error: { message: "Caffold server unavailable." } },
        })
      : route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    unavailable
      ? route.fulfill({
          status: 502,
          json: { error: { message: "Caffold server unavailable." } },
        })
      : route.fulfill({ json: detail() })
  );

  await page.goto(`/tasks/${threadId}`);
  const appShell = page.locator("caffold-app-shell");
  const tasksPage = page.locator("caffold-tasks-page");
  const composer = tasksPage.locator(
    'caffold-task-composer[data-composer-mode="follow-up"] textarea',
  );
  await expect(tasksPage).toContainText("Conversation stays available during recovery.");
  await composer.fill("Keep this offline recovery draft");
  await expect
    .poll(() =>
      page.evaluate((key) =>
        window[key].filter((source) => source.readyState !== 2).length,
      registryKey),
    )
    .toBe(2);
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));

  const readsBeforeRecovery = statusReads;
  unavailable = true;
  await page.evaluate((key) => {
    for (const source of window[key].filter((candidate) => candidate.readyState !== 2)) {
      source.emitError({ closed: true });
    }
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  }, registryKey);

  const notice = appShell.locator(".app-foreground-recovery");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-recovery-state", "reconnecting");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(tasksPage).toContainText("Conversation stays available during recovery.");
  await expect(composer).toHaveValue("Keep this offline recovery draft");
  await expect(page.locator(".task-list-stale-warning")).toHaveCount(0);
  await expect(page.locator(".task-list-availability, .task-stream-state")).toHaveCount(0);
  await expect.poll(() => statusReads).toBe(readsBeforeRecovery + 1);

  for (const [requestCount, presentation] of [
    [2, "reconnecting"],
    [3, "reconnecting"],
    [4, "unavailable"],
  ]) {
    await advanceClockUntil(
      page,
      () => statusReads >= readsBeforeRecovery + requestCount,
      { budgetMs: 5_000 },
    );
    expect(statusReads).toBe(readsBeforeRecovery + requestCount);
    await expect(notice).toHaveAttribute("data-recovery-state", presentation);
  }

  await expect(notice).toHaveAttribute("data-recovery-state", "unavailable");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
  await expect(tasksPage).toContainText("Conversation stays available during recovery.");
  await expect(composer).toHaveValue("Keep this offline recovery draft");
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-global-foreground-recovery-unavailable",
  );

  unavailable = false;
  recovered = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(notice).toBeHidden();
  await expect(tasksPage).toContainText("Conversation reconciled after recovery.");
  await expect(composer).toHaveValue("Keep this offline recovery draft");
});

test("reopened Task detail waits for a readable stream bootstrap", { tag: "@desktop" }, async ({
  page,
}) => {
  const registryKey = "__taskDetailReconnectSources";
  await installEventSourceMock(page, { registryKey, autoOpen: true });
  await mockCodexModels(page);

  const threadId = "thread_detail_stream_reconnect";
  const task = {
    ...transportOverlayTask(threadId),
    title: "Task detail stream reconnect",
  };
  const detail = (text, revision) => ({
    threadId,
    syncState: "ready",
    revision,
    task,
    events: [
      {
        id: `event_detail_reconnect_${revision}`,
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { turnId: `turn_detail_reconnect_${revision}`, text },
        createdMs: task.updatedMs + revision,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  const initialDetail = detail("Conversation before stream reconnect.", 1);
  const recoveredDetail = detail("Conversation after stream reconnect.", 2);
  let detailReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({ json: initialDetail });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, initialDetail);
  const tasksPage = page.locator("caffold-tasks-page");
  const notice = page.locator(".app-foreground-recovery");
  await expect(tasksPage).toContainText("Conversation before stream reconnect.");
  await expect(notice).toBeHidden();
  expect(detailReads).toBe(0);

  await page.evaluate((requestedThreadId) => {
    window.__caffoldTaskSse.source(requestedThreadId).emitError();
  }, threadId);
  await expect(notice).toHaveAttribute("data-recovery-state", "reconnecting");

  await page.evaluate((requestedThreadId) => {
    window.__caffoldTaskSse.open(
      window.__caffoldTaskSse.source(requestedThreadId),
    );
  }, threadId);
  await expect.poll(() => tasksPage.evaluate((element) => {
    const session = element.taskDetail().taskDetail().detailSession;
    return { phase: session.phase, state: session.state };
  })).toEqual({ phase: "waiting-bootstrap", state: "reconnecting" });
  await expect(notice).toHaveAttribute("data-recovery-state", "reconnecting");

  await page.evaluate(({ requestedThreadId, bootstrapDetail }) => {
    window.__caffoldTaskSse.source(requestedThreadId).emit("task-sync", {
      threadId: requestedThreadId,
      revision: bootstrapDetail.revision,
      detail: bootstrapDetail,
      reason: "stream-bootstrap",
    });
  }, { requestedThreadId: threadId, bootstrapDetail: recoveredDetail });
  await expect(notice).toBeHidden();
  await expect(tasksPage).toContainText("Conversation after stream reconnect.");
  expect(detailReads).toBe(0);
});

test("replaces terminal Task streams and reconciles list and detail", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__taskRecoveryServerAvailable = true;
    window.__taskRecoveryEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        this.closed = false;
        window.__taskRecoveryEventSources.push(this);
        window.__caffoldRegisterTaskSseSource?.(this);
        queueMicrotask(() => {
          if (window.__taskRecoveryServerAvailable && !this.closed) {
            this.emitOpen();
          }
        });
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

      emitTerminalError() {
        this.readyState = 2;
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

  const threadId = "thread_terminal_stream_recovery";
  const now = 1_767_190_450_000;
  const initialTask = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_before_terminal_disconnect",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Terminal stream recovery",
    preview: "Running before disconnect",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Running before disconnect",
    unseen: false,
  };
  const recoveredTask = {
    ...initialTask,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    preview: "Recovered canonical task",
    updatedMs: now + 2,
    recencyMs: now + 2,
    lastEventSummary: "Recovered canonical task",
  };
  const archivedTask = {
    ...recoveredTask,
    id: "thread_archived_terminal_recovery",
    threadId: "thread_archived_terminal_recovery",
    title: "Archived terminal recovery",
    conversationAvailable: true,
  };
  const detail = (task, text, revision) => ({
    threadId,
    syncState: "ready",
    revision,
    task,
    events: [
      {
        id: `event_${revision}`,
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { turnId: `turn_${revision}`, text },
        createdMs: now + revision,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  let canonicalTask = initialTask;
  let canonicalDetail = detail(initialTask, "Running before terminal disconnect.", 8);
  let listReads = 0;
  let detailReads = 0;

  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [archivedTask], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([canonicalTask])),
    });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    detailReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(canonicalDetail),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, canonicalDetail);
  const navigator = page.locator("caffold-task-navigator");
  const tasksPage = page.locator("caffold-tasks-page");
  const taskRow = navigator.locator(`.task-row[data-thread-id="${threadId}"]`);
  const restoreButton = navigator.locator(
    '[data-task-action="restore-archived-task"]',
  );
  await expect(taskRow).toHaveAttribute("data-task-status", "running");
  await expect(tasksPage).toContainText("Running before terminal disconnect.");
  await expect(restoreButton).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.__taskRecoveryEventSources.length))
    .toBe(2);

  await page.evaluate(() => {
    window.__taskRecoveryServerAvailable = false;
    for (const source of window.__taskRecoveryEventSources) {
      source.emitTerminalError();
    }
  });

  await expect(taskRow).toHaveAttribute("data-task-status", "running");
  await expect(restoreButton).toBeDisabled();
  await expect(
    page.locator('.app-foreground-recovery[data-recovery-state="reconnecting"]'),
  ).toBeVisible();

  canonicalTask = recoveredTask;
  canonicalDetail = detail(recoveredTask, "Recovered canonical baseline.", 1);
  await page.evaluate(() => {
    window.__taskRecoveryServerAvailable = true;
    for (const source of window.__taskRecoveryEventSources) {
      if (source.readyState === 0 && !source.closed) {
        source.emitOpen();
      }
    }
  });

  await expect.poll(() => listReads).toBeGreaterThan(1);
  expect(detailReads).toBe(0);
  const replacementDetail = detail(
    recoveredTask,
    "Recovered without a page reload.",
    2,
  );
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskRecoveryEventSources.findLast(
      (candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`) &&
        !candidate.closed,
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      reason: "stream-bootstrap",
      detail,
    });
  }, { threadId, detail: replacementDetail });
  await expect(taskRow).toHaveAttribute("data-task-status", "idle");
  await expect(tasksPage).toContainText("Recovered without a page reload.");
  await expect(tasksPage).not.toContainText("Recovered canonical baseline.");
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
  await expect(restoreButton).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__taskRecoveryEventSources.filter(
          (source) => source.readyState !== 2 && !source.closed,
        ).length,
      ),
    )
    .toBe(2);

  await page.evaluate(
    ({ threadId, staleTask }) => {
      const oldListSource = window.__taskRecoveryEventSources.find((source) =>
        source.url.startsWith("/api/tasks/stream"),
      );
      const oldDetailSource = window.__taskRecoveryEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      oldListSource.emit("task-updated", staleTask);
      oldDetailSource.emit("task-sync", {
        threadId,
        revision: 999,
        reason: "stale-generation",
        detail: {
          threadId,
          syncState: "ready",
          revision: 999,
          task: staleTask,
          events: [
            {
              id: "event_stale_generation",
              threadId,
              type: "assistant_message",
              summary: "Assistant response",
              payload: {
                turnId: "turn_stale_generation",
                text: "Stale generation must stay hidden.",
              },
              createdMs: Date.now(),
            },
          ],
          eventsPage: { nextCursor: null },
          pendingApprovals: [],
        },
      });
    },
    { threadId, staleTask: initialTask },
  );
  await expect(taskRow).toHaveAttribute("data-task-status", "idle");
  await expect(tasksPage).not.toContainText("Stale generation must stay hidden.");

  await page.getByRole("button", { name: /Task details/ }).click();
  await expect(page.getByRole("button", { name: "Archive task" })).toBeEnabled();
  await page.getByRole("button", { name: "New Task" }).click();
  const newTaskForm = tasksPage.locator(".task-new-form");
  const prompt = newTaskForm.locator('textarea[name="prompt"]');
  await expect(prompt).toBeEnabled();
  await prompt.fill("Verify recovered task creation controls");
  await expect(newTaskForm.getByRole("button", { name: "Start task" })).toBeEnabled();
});

test("shows one viewport recovery notice without moving Task surfaces", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_transport_overlay_geometry";
  await installTransportOverlayFixture(
    page,
    threadId,
    "__taskOverlayEventSources",
  );

  await page.goto("/tasks");
  const navigator = page.locator("caffold-task-navigator");
  const primaryHeader = navigator.locator(":scope > .task-list-primary-header");
  const scroller = navigator.locator(":scope > .task-list-scroll");
  const taskRow = navigator.locator(`.task-row[data-thread-id="${threadId}"]`);
  const initialHeader = await elementGeometry(primaryHeader);
  const initialTaskRow = await elementGeometry(taskRow);
  const notice = page.locator("caffold-app-shell > .app-foreground-recovery");
  await expect(notice).toHaveCount(1);

  for (const state of ["reconnecting", "unavailable"]) {
    await navigator.evaluate((element, nextState) => {
      element.setStreamState(nextState);
    }, state);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-recovery-state", state);
    await expect(notice).toHaveCSS("position", "fixed");
    if (state === "unavailable") {
      const retry = notice.getByRole("button", { name: "Retry" });
      await expect(retry).toBeVisible();
      await retry.focus();
      await expect(retry).toBeFocused();
      const initialNotice = await elementGeometry(notice);
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(await elementGeometry(primaryHeader)).toEqual(initialHeader);
      expect(await elementGeometry(notice)).toEqual(initialNotice);
      await captureReviewScreenshot(
        page,
        testInfo,
        "tasks-global-list-transport-unavailable",
      );
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
    }
    expect(await elementGeometry(taskRow)).toEqual(initialTaskRow);
  }
  await navigator.evaluate((element) => element.setStreamState("ready"));
  await expect(notice).toBeHidden();
  expect(await elementGeometry(taskRow)).toEqual(initialTaskRow);

  await page.goto(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const conversation = tasksPage.locator("caffold-task-conversation");
  const composer = tasksPage.locator(
    'caffold-task-composer[data-composer-mode="follow-up"]',
  );
  const initialConversation = await elementGeometry(conversation);
  const initialComposer = await elementGeometry(composer);

  for (const state of ["reconnecting", "unavailable"]) {
    await tasksPage.evaluate((element, nextState) => {
      element.taskDetail().taskDetail().detailSession.transport.setState(nextState);
    }, state);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-recovery-state", state);
    await expect(notice).toHaveCSS("position", "fixed");
    if (state === "unavailable") {
      const retry = notice.getByRole("button", { name: "Retry" });
      await expect(retry).toBeVisible();
      await retry.focus();
      await expect(retry).toBeFocused();
      await captureReviewScreenshot(
        page,
        testInfo,
        "tasks-global-detail-transport-unavailable",
      );
    }
    expect(await elementGeometry(conversation)).toEqual(initialConversation);
    expect(await elementGeometry(composer)).toEqual(initialComposer);
  }
  await tasksPage.evaluate((element) => {
    element.taskDetail().taskDetail().detailSession.transport.setState("ready");
  });
  await expect(notice).toBeHidden();
  expect(await elementGeometry(conversation)).toEqual(initialConversation);
  expect(await elementGeometry(composer)).toEqual(initialComposer);
});

test("routes the single viewport Retry through app-shell foreground recovery", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_parent_owned_transport_retry";
  const registryKey = "__taskRetryEventSources";
  await installTransportOverlayFixture(page, threadId, registryKey);
  let statusReads = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusReads += 1;
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.goto(`/tasks/${threadId}`);

  await expect
    .poll(() =>
      page.evaluate(
        ({ key }) =>
          window[key].filter((source) => source.readyState !== 2).length,
        { key: registryKey },
      ),
    )
    .toBe(2);

  const sourceCounts = () =>
    page.evaluate(
      ({ key, threadId: selectedThreadId }) => ({
        list: window[key].filter((source) =>
          source.url.startsWith("/api/tasks/stream"),
        ).length,
        detail: window[key].filter((source) =>
          source.url.includes(`/api/tasks/${selectedThreadId}/stream`),
        ).length,
      }),
      { key: registryKey, threadId },
    );
  const setStates = (list, detail) =>
    page.evaluate(
      ({ listState, detailState }) => {
        const workspace = document.querySelector("caffold-task-workspace");
        workspace.taskNavigator.taskListStream.setState(listState);
        workspace.tasksPage.taskDetail().taskDetail().detailSession.transport.setState(detailState);
      },
      { listState: list, detailState: detail },
    );
  const waitForReady = () =>
    expect
      .poll(() =>
        page.evaluate(() => {
          const workspace = document.querySelector("caffold-task-workspace");
          return {
            list: workspace.taskNavigator.streamState,
            detail: workspace.tasksPage.taskDetail().streamState,
          };
        }),
      )
      .toEqual({ list: "ready", detail: "ready" });

  const before = await sourceCounts();
  const statusBefore = statusReads;
  await setStates("unavailable", "ready");
  const globalNotice = page.locator(
    '.app-foreground-recovery[data-recovery-state="unavailable"]',
  );
  await expect(globalNotice).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
  await globalNotice.getByRole("button", { name: "Retry" }).click();
  await expect.poll(sourceCounts).toEqual({
    list: before.list + 1,
    detail: before.detail + 1,
  });
  await expect.poll(() => statusReads).toBe(statusBefore + 1);
  await waitForReady();
  await expect(globalNotice).toBeHidden();
});

test("reattaches Tasks component lifecycles without rebuilding stable children", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockCodexModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection()),
    }),
  );

  await page.goto("/tasks");
  const taskWorkspace = page.locator("caffold-task-workspace");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(taskWorkspace.locator("caffold-task-navigator")).toBeVisible();
  await expect(
    tasksPage.locator("caffold-task-directory-picker"),
  ).toHaveCount(1);
  await expect(
    tasksPage.locator("caffold-task-directory-picker dialog"),
  ).not.toHaveAttribute("open", "");

  const lifecycle = await taskWorkspace.evaluate((workspace) => {
    const element = workspace.querySelector("caffold-tasks-page");
    const parent = element.parentNode;
    const nextSibling = element.nextSibling;
    const navigator = workspace.querySelector("caffold-task-navigator");
    const taskNew = element.querySelector("caffold-task-new");
    const detail = element.querySelector("caffold-task-detail");
    const composer = taskNew.querySelector("caffold-task-composer");
    const turnOptions = composer.querySelector("caffold-task-turn-options");
    turnOptions.modelLoading = true;
    turnOptions.permissionLoading = true;

    element.remove();
    const detached = !element.isConnected;
    parent.insertBefore(element, nextSibling);
    const attached = element.isConnected;
    window.dispatchEvent(new CustomEvent("caffold:icons-ready"));

    return {
      attached,
      detached,
      sameNavigator: navigator === workspace.querySelector("caffold-task-navigator"),
      navigatorStillConnected: element.taskNavigator() === navigator,
      sameTaskNew: taskNew === element.querySelector("caffold-task-new"),
      sameDetail: detail === element.querySelector("caffold-task-detail"),
      turnOptionRequestsReleased:
        !turnOptions.modelLoading && !turnOptions.permissionLoading,
    };
  });

  expect(lifecycle).toEqual({
    attached: true,
    detached: true,
    sameNavigator: true,
    navigatorStillConnected: true,
    sameTaskNew: true,
    sameDetail: true,
    turnOptionRequestsReleased: true,
  });
});
test("keeps task list and detail revisions independent", { tag: "@desktop" }, async ({ page }, testInfo) => {
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
  await mockCodexModels(page);

  const threadId = "thread_independent_stream_revisions";
  const now = 1_767_190_500_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Independent task stream revisions",
    preview: "Initial answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial answer",
  };
  const initialEvents = [
    {
      id: "event_normalized_user_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: {
        turnId: "turn_initial",
        prompt: "Initial prompt",
        text: "Only this request should be visible.",
      },
      createdMs: now,
    },
    {
      id: "event_initial_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_initial", text: "Initial answer" },
      createdMs: now + 1,
    },
  ];
  const detail = (revision, events = initialEvents) => ({
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  const submittedPrompts = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail(1)) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), async (route) => {
    submittedPrompts.push(route.request().postDataJSON().prompt);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, turnId: "turn_follow_up", steered: false }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail(1));
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Only this request should be visible.");

  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThanOrEqual(2);
  await page.evaluate(({ threadId, task }) => {
    const listSource = window.__taskEventSources.find(
      (source) => source.url.startsWith("/api/tasks/stream"),
    );
    listSource.emit("task-sync", {
      threadId,
      revision: 100,
      detail: {
        revision: 100,
        task: { ...task, updatedMs: task.updatedMs + 100 },
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      },
    });
  }, { threadId, task });

  const externalEvent = {
    id: "event_external_detail_update",
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: { turnId: "turn_external", text: "Detail stream update is visible." },
    createdMs: now + 2,
  };
  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "external-update",
    });
  }, { threadId, detail: detail(2, [...initialEvents, externalEvent]) });
  await expect(tasksPage).toContainText("Detail stream update is visible.");

  const runningTask = {
    ...task,
    ...canonicalTaskState("active", { latestTurnStatus: "inProgress" }),
    lastEventSummary: "Running command",
  };
  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-status-sync",
    });
  }, {
    threadId,
    detail: {
      ...detail(3, [...initialEvents, externalEvent]),
      task: runningTask,
    },
  });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();

  const historyEvent = {
    id: "event_history_after_status",
    threadId,
    type: "assistant_message",
    summary: "Assistant progress",
    payload: { turnId: "turn_external", text: "History synchronized after status." },
    createdMs: now + 3,
  };
  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-sync",
    });
  }, {
    threadId,
    detail: {
      ...detail(4, [...initialEvents, externalEvent, historyEvent]),
      task: runningTask,
    },
  });
  await expect(tasksPage).toContainText("History synchronized after status.");
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();

  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-status-sync",
    });
  }, {
    threadId,
    detail: detail(5, [...initialEvents, externalEvent, historyEvent]),
  });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toHaveCount(0);

  const form = tasksPage.locator(".task-follow-up-form");
  await form.locator('textarea[name="prompt"]').fill("Follow-up after list update");
  await form.getByRole("button", { name: "Send prompt" }).click();
  await expect.poll(() => submittedPrompts).toEqual(["Follow-up after list update"]);
});
test("isolates task detail responses and conversation scroll by thread", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__isolatedTaskDetailSources",
    autoOpen: true,
  });
  await mockCodexModels(page);

  const now = 1_767_191_000_000;
  const makeTask = (threadId, title, offset) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + offset,
    recencyMs: now + offset,
    lastEventSummary: `${title} preview`,
    worktree: {
      rootPath: `${threadId}-worktree`,
      branch: `${threadId}-branch`,
      headSha: "0123456789abcdef",
      relativeCwd: "",
      linked: false,
    },
  });
  const taskA = makeTask("thread_scroll_a", "Thread A", 1);
  const taskB = makeTask("thread_scroll_b", "Thread B", 2);
  const tasks = [taskB, taskA];
  const detailFor = (task) => ({
    revision: 1,
    task,
    model: "gpt-5.6-sol",
    reasoningEffort: task.threadId === taskA.threadId ? "xhigh" : "low",
    permissionMode:
      task.threadId === taskA.threadId
        ? "askForApproval"
        : "approveForMe",
    events: Array.from({ length: 20 }, (_, index) => ({
      id: `${task.threadId}_event_${index}`,
      threadId: task.threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: `${task.threadId}_turn_${index}`,
        text: `${task.title} response ${index + 1}.\n\n${"Thread-specific scroll content. ".repeat(16)}`,
      },
      createdMs: now + index,
    })),
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  let releaseThreadAGitStatus;
  const threadAGitStatusGate = new Promise((resolve) => {
    releaseThreadAGitStatus = resolve;
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    }),
  );
  await page.route(/\/api\/tasks\/thread_scroll_[ab](?:\?|$)/, async (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
    const task = threadId === taskA.threadId ? taskA : taskB;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detailFor(task)),
    });
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    const rootPath = new URL(route.request().url()).searchParams.get("path");
    if (rootPath === taskA.worktree.rootPath) {
      await threadAGitStatusGate;
    }
    const task = rootPath === taskA.worktree.rootPath ? taskA : taskB;
    const marker = task.threadId === taskA.threadId ? "thread-a.rs" : "thread-b.rs";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: task.worktree.rootPath,
          branch: task.worktree.branch,
          dirty: true,
        },
        additions: 1,
        deletions: 0,
        files: [
          {
            path: marker,
            repoRelativePath: marker,
            status: "M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
      }),
    });
  });

  await page.goto(`/tasks/${taskB.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detailFor(taskB));
  const tasksPage = page.locator("caffold-tasks-page");
  const taskNavigator = page.locator("caffold-task-navigator");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const followUp = tasksPage.locator(".task-follow-up-form");
  const followUpPrompt = followUp.getByRole("textbox", {
    name: "Follow-up prompt",
  });
  await expect(
    followUp.getByRole("button", { name: /Choose model/ }),
  ).toContainText("low");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Auto review");
  await followUpPrompt.fill("Draft for thread B");
  await scroller.evaluate((element) => {
    element.scrollTop = 140;
    element.dispatchEvent(new Event("scroll"));
  });

  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await expect
    .poll(() =>
      page.evaluate((threadId) =>
        window.__isolatedTaskDetailSources.some((source) =>
          source.url.includes(`/api/tasks/${threadId}/stream`),
        ), taskA.threadId),
    )
    .toBe(true);
  await taskNavigator.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskB));
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__isolatedTaskDetailSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "stream-bootstrap",
    });
  }, { threadId: taskA.threadId, detail: detailFor(taskA) });
  await expect(page).toHaveURL(`/tasks/${taskB.threadId}`);
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect(tasksPage).not.toContainText("Thread A response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(140);

  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskA));
  await expect(tasksPage).toContainText("Thread A response 20.");
  await expect(
    tasksPage.locator('caffold-task-markdown[data-render-state="markdown"]'),
  ).toHaveCount(20);
  await expect(followUpPrompt).toHaveValue("");
  await expect(
    followUp.getByRole("button", { name: /Choose model/ }),
  ).toContainText("xhigh");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Ask approval");
  await followUpPrompt.fill("Draft for thread A");
  await pasteImage(followUpPrompt, "thread-a.png");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(1);
  const taskAAnchor = await scroller.evaluate(async (element) => {
    element.scrollTop = Math.min(250, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scrollerRect = element.getBoundingClientRect();
    const messages = [...element.querySelectorAll(".task-message[data-event-id]")];
    const index = messages.findIndex(
      (message) => message.getBoundingClientRect().bottom > scrollerRect.top + 1,
    );
    const message = messages[index];
    return {
      eventId: message?.dataset.eventId ?? "",
      offset: Math.round(message.getBoundingClientRect().top - scrollerRect.top),
    };
  });
  expect(taskAAnchor.eventId).not.toBe("");
  await taskNavigator.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskB));
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect(followUpPrompt).toHaveValue("Draft for thread B");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(
    followUp.getByRole("button", { name: /Choose model/ }),
  ).toContainText("low");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Auto review");
  await expect
    .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(140);
  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskA));
  await expect(tasksPage).toContainText("Thread A response 20.");
  await expect(followUpPrompt).toHaveValue("Draft for thread A");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(
    followUp.getByRole("button", { name: /Choose model/ }),
  ).toContainText("xhigh");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Ask approval");
  await expect(
    tasksPage.locator('caffold-task-markdown[data-render-state="markdown"]'),
  ).toHaveCount(20);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element, anchor) => {
          const scrollerRect = element.getBoundingClientRect();
          const message = [...element.querySelectorAll(".task-message[data-event-id]")].find(
            (candidate) => candidate.dataset.eventId === anchor.eventId,
          );
          return message
            ? Math.abs(
                Math.round(message.getBoundingClientRect().top - scrollerRect.top) -
                  anchor.offset,
              ) <= 2
            : false;
        },
        taskAAnchor,
      ),
    )
    .toBe(true);

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "review",
  );
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await taskNavigator.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await emitTaskDetailBootstrap(page, detailFor(taskB));
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const reviewTree = tasksPage.locator(
    "caffold-task-review caffold-git-diff-changes-tree",
  );
  await expect(
    reviewTree.locator('button[data-file-tree-relative-path="thread-b.rs"]'),
  ).toBeVisible();
  releaseThreadAGitStatus();
  await expect(
    reviewTree.locator('button[data-file-tree-relative-path="thread-a.rs"]'),
  ).toHaveCount(0);
  await expect(
    reviewTree.locator('button[data-file-tree-relative-path="thread-b.rs"]'),
  ).toBeVisible();
});
