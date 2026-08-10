import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
  pasteImage,
  scrollTop,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("background Task tabs release list and detail streams", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Browser connection lifecycle regression");
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
  let detailReads = 0;
  let listReads = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    listReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) => {
    detailReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId,
        syncState: "ready",
        revision: detailReads,
        task,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await expect(page.locator("caffold-task-detail")).toContainText(
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
  await expect.poll(() => detailReads).toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__taskLifecycleEventSources.filter(
          (source) => source.readyState !== 2,
        ).length,
      ),
    )
    .toBe(2);
});

test("reattaches Tasks component lifecycles without rebuilding stable children", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Tasks lifecycle ownership regression");
  await installEventSourceMock(page, { autoOpen: true });
  await mockCodexModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
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
    composer.modelLoading = true;
    composer.permissionLoading = true;

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
      composerRequestsReleased:
        !composer.modelLoading && !composer.permissionLoading,
    };
  });

  expect(lifecycle).toEqual({
    attached: true,
    detached: true,
    sameNavigator: true,
    navigatorStillConnected: true,
    sameTaskNew: true,
    sameDetail: true,
    composerRequestsReleased: true,
  });
});
test("keeps task list and detail revisions independent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Wide task stream regression");
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
      body: JSON.stringify({ tasks: [task] }),
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
test("isolates task detail responses and conversation scroll by thread", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Wide master-detail regression");
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
      }

      addEventListener() {}

      close() {}
    };
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
  let delayThreadA = false;
  let releaseThreadA;
  let threadAResponseGate = Promise.resolve();
  let releaseThreadAGitStatus;
  const threadAGitStatusGate = new Promise((resolve) => {
    releaseThreadAGitStatus = resolve;
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_scroll_[ab](?:\?|$)/, async (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
    if (threadId === taskA.threadId && delayThreadA) {
      await threadAResponseGate;
    }
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
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
  ).toContainText("low");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Auto review");
  await followUpPrompt.fill("Draft for thread B");
  await scroller.evaluate((element) => {
    element.scrollTop = 140;
    element.dispatchEvent(new Event("scroll"));
  });

  delayThreadA = true;
  threadAResponseGate = new Promise((resolve) => {
    releaseThreadA = resolve;
  });
  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await taskNavigator.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  releaseThreadA();
  await expect(page).toHaveURL(`/tasks/${taskB.threadId}`);
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect(tasksPage).not.toContainText("Thread A response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(140);

  delayThreadA = false;
  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await expect(tasksPage).toContainText("Thread A response 20.");
  await expect(
    tasksPage.locator('caffold-task-markdown[data-render-state="markdown"]'),
  ).toHaveCount(20);
  await expect(followUpPrompt).toHaveValue("");
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
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
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect(followUpPrompt).toHaveValue("Draft for thread B");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
  ).toContainText("low");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Auto review");
  await expect
    .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(140);
  await taskNavigator.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await expect(tasksPage).toContainText("Thread A response 20.");
  await expect(followUpPrompt).toHaveValue("Draft for thread A");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
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
