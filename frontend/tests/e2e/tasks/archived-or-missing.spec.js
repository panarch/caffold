import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeListTask,
  activeLiveUpdateChannels,
  activeTaskProjection,
  canonicalTaskState,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
  refuseTaskDetail,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

function taskRecord(threadId, title) {
  const now = 1_767_500_000_000;
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: `${title} summary`,
    unseen: false,
  };
}

function taskDetail(task, text) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events: [
      {
        id: `${task.threadId}-answer`,
        threadId: task.threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text },
        position: { anchorMs: task.createdMs, index: 0 },
      },
    ],
    eventsPage: { nextCursor: null },
    eventsRange: { from: null, to: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
  };
}

const REFUSALS = {
  archived: { status: 409, code: "task_archived" },
  deleted: { status: 404, code: "task_not_found" },
  active: { status: 400, code: "task_not_archived" },
};

function refusal(state) {
  const { status, code } = REFUSALS[state];
  return { status, json: { error: { code, message: code } } };
}

// The server's side of one Task: where it is now, and what the page asked of
// it. Requests about a Task that is not active get the refusal the server
// sends for where it is.
async function routeTask(page, task, detail, { state = "active" } = {}) {
  const server = { state, restores: 0, prompts: 0 };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: activeTaskProjection(server.state === "active" ? [task] : []),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`), (route) =>
    route.fulfill(server.state === "active" ? { json: detail } : refusal(server.state)),
  );
  await page.route(`/api/tasks/${task.threadId}/prompts`, (route) => {
    server.prompts += 1;
    return route.fulfill(refusal(server.state === "active" ? "archived" : server.state));
  });
  await page.route(`/api/tasks/${task.threadId}/restore`, (route) => {
    server.restores += 1;
    if (server.state !== "archived") {
      return route.fulfill(refusal(server.state));
    }
    server.state = "active";
    return route.fulfill({
      json: {
        task: activeListTask(task),
        activeTopPlacement: {
          section: { id: "fixture-section-1", name: "src", repository: false },
        },
      },
    });
  });
  return server;
}

test("a Task archived elsewhere while open shows the archived notice, and Restore opens it again", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_archived_while_open", "Archived while open");
  const detail = taskDetail(task, "Conversation before the archive.");
  const server = await routeTask(page, task, detail);
  const tasksPage = page.locator("caffold-tasks-page");
  const notice = tasksPage.locator("caffold-task-absence");

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, detail);
  await expect(tasksPage).toContainText("Conversation before the archive.");

  server.state = "archived";
  await refuseTaskDetail(page, task.threadId, "task_archived");

  await expect(notice).toContainText("Task archived");
  await expect(notice.getByRole("heading", { level: 2 })).toHaveText(task.title);
  await expect(page.locator(".detail-layout-summary")).toBeHidden();
  await expect(tasksPage.getByText("Conversation before the archive.")).toBeHidden();
  await expect(tasksPage.locator("caffold-task-composer")).toBeHidden();
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();

  await notice.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => server.restores).toBe(1);
  await emitTaskDetailBootstrap(page, detail);
  await expect(tasksPage).toContainText("Conversation before the archive.");
  await expect(notice).toHaveCount(0);
  await expect(
    page.locator(`caffold-task-navigator .task-row[data-thread-id="${task.threadId}"]`),
  ).toBeVisible();
});

test("Restore from the notice is offered to the keyboard and reports a refusal in place", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_restore_refused", "Restore refused");
  const detail = taskDetail(task, "Conversation that cannot come back.");
  const server = await routeTask(page, task, detail, { state: "archived" });
  await page.route(`/api/tasks/${task.threadId}/restore`, (route) => {
    server.restores += 1;
    return route.fulfill({
      status: 502,
      json: {
        error: {
          code: "agent_error",
          message: `the agent no longer has conversation ${task.threadId}`,
        },
      },
    });
  });
  const notice = page.locator("caffold-tasks-page caffold-task-absence");

  await page.goto(`/tasks/${task.threadId}`);
  await refuseTaskDetail(page, task.threadId, "task_archived");
  await expect(notice).toContainText("Task archived");

  await activateActionHint(page, /Restore$/);
  await expect.poll(() => server.restores).toBe(1);
  await expect(notice.getByRole("alert")).toHaveText(
    `the agent no longer has conversation ${task.threadId}`,
  );
  await expect(notice.getByRole("button", { name: "Restore" })).toBeEnabled();
});

test("a Task archived while the page was hidden shows the notice on return, not a connection problem", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__caffoldVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__caffoldVisibilityState,
    });
  });
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_archived_while_hidden", "Archived while hidden");
  const detail = taskDetail(task, "Conversation before hiding.");
  const server = await routeTask(page, task, detail);
  const tasksPage = page.locator("caffold-tasks-page");

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, detail);
  await expect(tasksPage).toContainText("Conversation before hiding.");

  await page.evaluate(() => {
    window.__caffoldVisibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  server.state = "archived";
  await page.evaluate(() => {
    window.__caffoldVisibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await refuseTaskDetail(page, task.threadId, "task_archived");

  await expect(tasksPage.locator("caffold-task-absence")).toContainText(
    "Task archived",
  );
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
  await expect(tasksPage.locator(".task-detail-load-error")).toHaveCount(0);
});

test("a link to an archived Task opens on the archived notice", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_archived_link", "Archived link");
  await routeTask(page, task, taskDetail(task, "Unreachable."), {
    state: "archived",
  });
  const notice = page.locator("caffold-tasks-page caffold-task-absence");

  await page.goto(`/tasks/${task.threadId}`);
  await refuseTaskDetail(page, task.threadId, "task_archived");

  await expect(notice).toContainText("Task archived");
  await expect(notice.getByRole("heading", { level: 2 })).toHaveText("Unavailable Task");
  await expect(notice.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
});

test("a link to a Task Caffold cannot find says so and offers nothing to do", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_unknown_link", "Unknown link");
  await routeTask(page, task, taskDetail(task, "Unreachable."), {
    state: "deleted",
  });
  const notice = page.locator("caffold-tasks-page caffold-task-absence");

  await page.goto(`/tasks/${task.threadId}`);
  await refuseTaskDetail(page, task.threadId, "task_not_found");

  await expect(notice).toContainText("Task not found");
  await expect(notice.getByRole("button")).toBeHidden();
  await expect(page.locator(".app-foreground-recovery")).toBeHidden();
});

test("a Task deleted elsewhere while its Review was open closes the Review for the not-found notice", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_deleted_while_reviewing", "Deleted while reviewing");
  const detail = taskDetail(task, "Conversation before the delete.");
  const server = await routeTask(page, task, detail);
  const tasksPage = page.locator("caffold-tasks-page");

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, detail);
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(tasksPage.locator("caffold-task-review")).toBeVisible();
  await expect.poll(() => activeLiveUpdateChannels(page)).toContain("watch");

  server.state = "deleted";
  await refuseTaskDetail(page, task.threadId, "task_not_found");

  await expect(tasksPage.locator("caffold-task-absence")).toContainText(
    "Task not found",
  );
  await expect(tasksPage.locator("caffold-task-review")).toBeHidden();
  await expect.poll(() => activeLiveUpdateChannels(page)).not.toContain("watch");
});

test("a prompt refused because its Task was archived elsewhere turns the conversation into the notice", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord("thread_prompt_after_archive", "Prompt after archive");
  const detail = taskDetail(task, "Conversation before the prompt.");
  const server = await routeTask(page, task, detail);
  const tasksPage = page.locator("caffold-tasks-page");

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, detail);
  await expect(tasksPage).toContainText("Conversation before the prompt.");

  server.state = "archived";
  await tasksPage
    .getByRole("textbox", { name: "Follow-up prompt" })
    .fill("Is anyone there?");
  await tasksPage.getByRole("button", { name: "Send prompt" }).click();

  await expect.poll(() => server.prompts).toBe(1);
  await expect(tasksPage.locator("caffold-task-absence")).toContainText(
    "Task archived",
  );
  await expect(tasksPage.locator("caffold-task-composer")).toBeHidden();
});

test("the notice is laid out like Task Recovery and keeps a long title inside its header", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { autoOpen: true });
  const task = taskRecord(
    "thread_layout_archived",
    "Refactor the Task Detail session into an explicit graph that ends at absent for archived and missing Tasks",
  );
  const detail = taskDetail(task, "Conversation before the archive.");
  const recovery = {
    ...taskRecord("thread_layout_recovery", "Recovery reference"),
    recovery: {
      reason: "codexArchived",
      actions: ["restoreToActive", "moveToArchived", "recheck"],
    },
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task], [recovery]) }),
  );
  await page.route(new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: detail }),
  );
  // Measured from the Task content pane both screens fill.
  // Task Recovery's action row also holds Recheck, whose taller touch target
  // centers its buttons lower on touch layouts; the rows start at the same place.
  const layout = (owner, prefix, actions) =>
    owner.evaluate((element, [classPrefix, actionRow]) => {
      const pane = element.closest(".tasks-detail-pane").getBoundingClientRect();
      const box = (selector) => {
        const rect = element.querySelector(selector).getBoundingClientRect();
        return {
          left: rect.left - pane.left,
          top: rect.top - pane.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const font = (selector) => {
        const style = getComputedStyle(element.querySelector(selector));
        return `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`;
      };
      const button = box(".task-secondary-button");
      const row = box(actionRow);
      return {
        header: box(`.${classPrefix}-header`),
        title: { left: box(`.${classPrefix}-header h2`).left, font: font(`.${classPrefix}-header h2`) },
        heading: { ...box(`.${classPrefix}-heading`), width: null, font: font(`.${classPrefix}-heading h3`) },
        icon: box(`.${classPrefix}-icon-slot`),
        description: { ...box(`.${classPrefix}-description`), width: null, font: font(`.${classPrefix}-description p`) },
        actions: { left: row.left, top: row.top },
        button: { left: button.left, height: button.height },
      };
    }, [prefix, actions]);

  await page.goto(`/tasks/${recovery.threadId}/recovery`);
  const recoveryPage = page.locator("caffold-task-recovery");
  await expect(recoveryPage.getByRole("heading", { name: "Archived in Codex" })).toBeVisible();
  const reference = await layout(
    recoveryPage,
    "task-recovery",
    ".task-recovery-action-row",
  );

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, detail);
  await expect(page.getByText("Conversation before the archive.")).toBeVisible();
  await refuseTaskDetail(page, task.threadId, "task_archived");
  const notice = page.locator("caffold-tasks-page caffold-task-absence");
  await expect(notice.getByRole("heading", { level: 2 })).toHaveText(task.title);
  expect(
    await layout(notice, "task-absence", ".task-absence-actions"),
  ).toEqual(reference);

  // A long title ends inside the header, and nothing of the notice reaches
  // past its pane or under the corner controls a narrow workspace shows.
  const fit = await notice.evaluate((element) => {
    const pane = element.closest(".tasks-detail-pane").getBoundingClientRect();
    const title = element.querySelector(".task-absence-header h2");
    const header = element.querySelector(".task-absence-header").getBoundingClientRect();
    const parts = [
      title,
      element.querySelector(".task-absence-heading"),
      element.querySelector(".task-absence-description"),
      element.querySelector(".task-absence-actions"),
    ].map((part) => part.getBoundingClientRect());
    const overlaps = [...document.querySelectorAll(".task-workspace-route-control")]
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => control.getBoundingClientRect())
      .filter((control) => parts.some((part) =>
        part.left < control.right && control.left < part.right &&
        part.top < control.bottom && control.top < part.bottom))
      .length;
    return {
      titleEnds: getComputedStyle(title).textOverflow,
      titleInsideHeader: title.getBoundingClientRect().right <= header.right + 0.5,
      insidePane: parts.every((part) => part.right <= pane.right + 0.5),
      overlaps,
    };
  });
  expect(fit).toEqual({
    titleEnds: "ellipsis",
    titleInsideHeader: true,
    insidePane: true,
    overlaps: 0,
  });
});
