import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const TaskDetail = registry.element("caffold-task-detail");
const taskDetail = TaskDetail.prototype;
const { ActionHints } = await import("#app/action-hints.js");
after(() => registry.restore());

// A Task screen with only the state its drawing reads, and no conversation.
function screen(state = {}) {
  const owner = Object.create(TaskDetail.prototype, Object.getOwnPropertyDescriptors({
    reviewView: "conversation",
    selectedThreadId: "thread-a",
    taskDetail: null,
    detailLoadError: null,
    loading: false,
    events: [],
    detailSession: { absence: null, state: "ready" },
    pane: null,
    notice: null,
    ...state,
  }));
  owner.hints = new ActionHints(owner);
  return owner;
}

function drawn(owner) {
  owner.willUpdate();
  return templateHtml(owner.render()).replace(/\s+/g, " ");
}

test("only the server's actions decide whether an unavailable worktree offers Delete or Retry", () => {
  const action = (error) =>
    templateHtml(taskDetail.loadErrorAction.call(screen({ detailLoadError: error })));
  assert.match(action({ allowedActions: ["deleteTask"] }), /delete-broken-task/);
  assert.doesNotMatch(action({ allowedActions: ["deleteTask"] }), /Retry/);
  assert.equal(action({ allowedActions: [] }), "");
  assert.match(action({ allowedActions: ["retry"] }), /Retry/);
  assert.match(action(new Error("provider unavailable")), /Retry/);
});

test("the conversation pane stays once drawn, hidden under what shows in its place", () => {
  const owner = screen({ loading: true });
  assert.doesNotMatch(drawn(owner), /class="task-detail"/, "no pane before a Task is read");
  assert.equal(owner.pane, null);

  owner.loading = false;
  owner.taskDetail = { task: { threadId: "thread-a" } };
  const shown = drawn(owner);
  assert.match(shown, /class="task-detail" data-thread-id="thread-a" data-task-detail-view="conversation" \?hidden="false"/);
  assert.doesNotMatch(shown, /task-detail-placeholder/);
  assert.match(shown, /<caffold-task-conversation /);
  assert.match(shown, /class="task-follow-up-composer-slot"/);

  owner.selectedThreadId = "thread-b";
  owner.taskDetail = null;
  owner.loading = true;
  const waiting = drawn(owner);
  assert.match(waiting, /data-thread-id="thread-a" data-task-detail-view="conversation" \?hidden="true"/,
    "the pane keeps the Task it last showed");
  assert.match(waiting, /<div class="task-detail-placeholder"><\/div>/);

  owner.loading = false;
  owner.detailLoadError = Object.assign(new Error("Worktree is gone"), {
    allowedActions: ["deleteTask"],
  });
  const failed = drawn(owner);
  assert.match(failed, /task-detail-placeholder"><section class="task-detail-load-error" role="alert">/);
  assert.match(failed, /The task worktree is unavailable\./);
  assert.match(failed, /Worktree is gone/);
  assert.match(failed, /data-task-action="delete-broken-task"/);

  owner.detailLoadError = null;
  owner.detailSession = { absence: "archived", state: "ready" };
  assert.match(drawn(owner), /task-detail-placeholder"><caffold-task-absence /);
});

test("Git and GitHub name a Task they are waiting for in their own panel", () => {
  const owner = screen({ reviewView: "github", loading: true });
  const pending = drawn(owner);
  assert.match(pending, /<section class="task-domain-pending" data-task-domain="github" aria-label="GitHub"/);
  assert.match(pending, /<caffold-loading-text>Loading Task context\.\.\.<\/caffold-loading-text>/);
  assert.doesNotMatch(pending, /role="status"/, "the phrase announces itself");
  assert.match(pending, /task-domain-pending-body" role=""/);

  owner.loading = false;
  owner.detailLoadError = new Error("Unavailable");
  const failed = drawn(owner);
  assert.match(failed, /task-domain-pending-body" role="alert"/);
  assert.match(failed, /<p>Unavailable<\/p>/);
  assert.match(failed, /data-task-action="retry-task-detail"/);
  assert.doesNotMatch(failed, /<caffold-loading-text>Loading Task/);
});

test("offers the conversation, follow-up Composer, and Current Plan while the conversation shows", () => {
  const pulls = [];
  const part = (id, root) => ({
    actionHintScope(pull) {
      pulls.push(pull);
      return { targets: [{ id }], mutationRoots: [root] };
    },
  });
  const slot = {};
  const pane = {};
  let composer = { parentElement: slot, ...part("prompt", {}) };
  const owner = Object.assign(screen(), {
    hints: { scope: () => ({ targets: [{ id: "load-error" }] }) },
    absenceNotice: { value: undefined },
    handoffDialog: { value: undefined },
    conversationPane: { value: pane },
    followUpComposerSlot: { value: slot },
    conversationComponent: { value: part("conversation-action", {}) },
    currentPlanComponent: { value: part("plan", {}) },
    followUpComposer: () => composer,
  });
  const scope = () => taskDetail.actionHintScope.call(owner);
  const ids = () => scope().targets.map(({ id }) => id);

  assert.deepEqual(ids(), ["load-error", "prompt", "conversation-action", "plan"]);
  assert.deepEqual(pulls.map(({ scopeId }) => scopeId), [
    "task:thread-a",
    "task:thread-a:conversation",
    "task:thread-a:current-plan",
  ]);
  assert.deepEqual(pulls[0].clipRoots, [owner, pane]);
  assert.ok(scope().mutationRoots.includes(slot));

  composer = null;
  assert.deepEqual(ids(), ["load-error", "conversation-action", "plan"]);

  owner.notice = {};
  assert.deepEqual(ids(), ["load-error"], "a read that failed offers its action");

  owner.absenceNotice = {
    value: { actionHintScope: ({ scopeId }) => ({ targets: [{ id: scopeId }] }) },
  };
  assert.deepEqual(ids(), ["task:thread-a:absence"]);
});

test("merges composer popovers, Current Plan, Command, Tool call, Markdown preview, Mermaid preview, and permission instruction modals independently", () => {
  const composerContext = { id: "composer-popover" };
  const planContext = { id: "current-plan" };
  const commandContext = { id: "command-output" };
  const toolCallContext = { id: "tool-call-details" };
  const markdownPreviewContext = { id: "markdown-preview" };
  const mermaidPreviewContext = { id: "mermaid-preview" };
  const permissionInstructionsContext = { id: "permission-instructions" };
  const slot = {};
  const composer = {
    parentElement: slot,
    keyboardNavigationContexts(options) {
      assert.equal(options.scopeId, "task:thread-a");
      return [composerContext];
    },
  };
  const owner = {
    hidden: false,
    reviewView: "conversation",
    selectedThreadId: "thread-a",
    performUpdate() {},
    brokenDeleteDialog: { value: undefined },
    forceArchiveDialog: { value: { keyboardNavigationContexts: () => [{ id: "force-archive" }] } },
    handoffDialog: { value: { keyboardNavigationContexts: () => [{ id: "handoff" }] } },
    followUpComposer: () => composer,
    followUpComposerSlot: { value: slot },
    currentPlanComponent: {
      value: { keyboardNavigationContexts: () => [planContext] },
    },
    commandDialog: {
      value: { keyboardNavigationContexts: () => [commandContext] },
    },
    toolCallDialog: {
      value: { keyboardNavigationContexts: () => [toolCallContext] },
    },
    markdownPreviewDialog: {
      value: { keyboardNavigationContexts: () => [markdownPreviewContext] },
    },
    mermaidPreviewDialog: {
      value: { keyboardNavigationContexts: () => [mermaidPreviewContext] },
    },
    permissionInstructionsDialog: {
      value: {
        keyboardNavigationContexts: () => [permissionInstructionsContext],
      },
    },
  };

  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [
      { id: "force-archive" },
      { id: "handoff" },
      composerContext,
      planContext,
      commandContext,
      toolCallContext,
      markdownPreviewContext,
      mermaidPreviewContext,
      permissionInstructionsContext,
    ],
  );
  owner.currentPlanComponent = { value: undefined };
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [
      { id: "force-archive" },
      { id: "handoff" },
      composerContext,
      commandContext,
      toolCallContext,
      markdownPreviewContext,
      mermaidPreviewContext,
      permissionInstructionsContext,
    ],
  );
  owner.markdownPreviewDialog = { value: undefined };
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [
      { id: "force-archive" },
      { id: "handoff" },
      composerContext,
      commandContext,
      toolCallContext,
      mermaidPreviewContext,
      permissionInstructionsContext,
    ],
  );
  owner.mermaidPreviewDialog = { value: undefined };
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [
      { id: "force-archive" },
      { id: "handoff" },
      composerContext,
      commandContext,
      toolCallContext,
      permissionInstructionsContext,
    ],
  );
  owner.permissionInstructionsDialog = { value: undefined };
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [{ id: "force-archive" }, { id: "handoff" }, composerContext, commandContext, toolCallContext],
  );
});

test("publishes the approval mode the follow-up Composer would send", () => {
  const owner = {
    selectedThreadId: "thread-a",
    taskDetail: { provider: "codex", task: { threadId: "thread-a" } },
    detailSession: { state: "ready" },
    activeCwdPath: () => "src",
    archiveStateValue: { loading: false, error: null },
    forkStateValue: { loading: false, error: null },
    followUpComposer: () => ({
      selectedPermissionMode: () => "caffold:ask-jev-first",
    }),
  };

  assert.equal(
    taskDetail.detailSnapshot.call(owner).permissionMode,
    "caffold:ask-jev-first",
  );

  owner.followUpComposer = () => null;
  assert.equal(taskDetail.detailSnapshot.call(owner).permissionMode, "");
});

test("one phrase covers an opening conversation until its Task details and history are read", () => {
  const waiting = (state) => taskDetail.waitsForConversation.call(screen(state));
  const readTask = (historyLoading) => ({
    task: { threadId: "thread-a" },
    historyLoading,
  });

  assert.equal(waiting({ loading: true }), true, "Task details are still being read");
  assert.equal(waiting({ taskDetail: readTask(true) }), true, "history is still being read");
  assert.equal(waiting({ taskDetail: readTask(false) }), false);
  assert.equal(waiting({}), false, "nothing is being read");
  assert.equal(
    waiting({ loading: true, taskDetail: { task: { threadId: "thread-b" } } }),
    true,
    "another Task's details do not end the wait for this one",
  );
  assert.equal(
    waiting({ detailLoadError: new Error("unavailable") }),
    false,
    "a failure shows its error instead",
  );
  assert.equal(
    waiting({
      loading: true,
      taskDetail: readTask(false),
      detailLoadError: { allowedActions: ["deleteTask"] },
    }),
    true,
    "while a read is under way the phrase follows the body, which hides a Task whose worktree is unavailable",
  );
  assert.equal(waiting({ loading: true, reviewView: "git" }), false, "Git shows its own pending panel");
  const kept = [{ id: "thread-a:turn-1:assistant" }];
  assert.equal(
    waiting({ taskDetail: readTask(true), events: kept }),
    false,
    "a conversation on screen stays readable while its history is read",
  );
  assert.equal(
    waiting({ loading: true, events: kept }),
    true,
    "kept entries are not on screen until their Task is read",
  );
});


test("force archive rejects a confirmation captured for another Task or worktree", async () => {
  const owner = screen({
    archiveStateValue: { loading: false, error: { allowedActions: ["forceArchive"], worktreeId: "current" } },
    forkStateValue: { loading: false },
    emitSubjectSnapshot() { assert.fail("a stale confirmation must not start a request"); },
  });
  await owner.archiveSelectedTask({ threadId: "thread-b", worktreeId: "current" });
  await owner.archiveSelectedTask({ threadId: "thread-a", worktreeId: "previous" });
  assert.equal(owner.archiveStateValue.loading, false);
});

test("open preserves a loaded task and marks an unseen completion as seen", async () => {
  let seenThreadId = null;
  const owner = screen({
    selectedThreadId: "thread-a",
    taskDetail: { task: { threadId: "thread-a", unseen: true, lastCompletedMs: 100 } },
    performUpdate() {},
    draw() {},
    activateThreadEvents() {},
    markDisplayedTaskSeen(threadId, task) {
      if (task?.unseen) {
        seenThreadId = threadId;
      }
    },
    detailSession: {
      attach() {},
    },
  });
  const detail = await owner.open("thread-a", { preserveLoadedTask: true });
  assert.equal(detail, owner.taskDetail);
  assert.equal(seenThreadId, "thread-a");
});

test("recoverForeground checks the open task and marks unseen completion as seen", async () => {
  let seenThreadId = null;
  const owner = screen({
    selectedThreadId: "thread-a",
    taskDetail: { task: { threadId: "thread-a", unseen: true, lastCompletedMs: 100 } },
    performUpdate() {},
    draw() {},
    markDisplayedTaskSeen(threadId, task) {
      if (task?.unseen) {
        seenThreadId = threadId;
      }
    },
    detailSession: {
      recover() {
        return Promise.resolve({ ok: true, skipped: true });
      },
    },
  });
  const outcome = await owner.recoverForeground();
  assert.equal(outcome.ok, true);
  assert.equal(seenThreadId, "thread-a");
});

test("markDisplayedTaskSeen delays marking seen when the document is hidden", () => {
  const seenRequestKeys = new Set();
  const owner = screen({
    selectedThreadId: "thread-a",
    seenRequestKeys,
  });
  const previousState = document.visibilityState;
  try {
    document.visibilityState = "hidden";
    taskDetail.markDisplayedTaskSeen.call(owner, "thread-a", {
      threadId: "thread-a",
      unseen: true,
      lastCompletedMs: 100,
    });
    assert.equal(seenRequestKeys.size, 0, "hidden document must not mark seen or capture request keys");

    document.visibilityState = "visible";
    taskDetail.markDisplayedTaskSeen.call(owner, "thread-a", {
      threadId: "thread-a",
      unseen: true,
      lastCompletedMs: 100,
    });
    assert.equal(seenRequestKeys.has("thread-a:100"), true, "visible document marks seen and records request key");
  } finally {
    document.visibilityState = previousState;
  }
});
