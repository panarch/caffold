import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const taskDetail = registry.element("caffold-task-detail").prototype;
after(() => registry.restore());

test("only the server's actions decide whether an unavailable worktree offers Delete or Retry", () => {
  const action = (error) => taskDetail.renderLoadErrorAction.call({ detailLoadError: error });
  assert.match(action({ allowedActions: ["deleteTask"] }), /delete-broken-task/);
  assert.doesNotMatch(action({ allowedActions: ["deleteTask"] }), /Retry/);
  assert.equal(action({ allowedActions: [] }), "");
  assert.match(action({ allowedActions: ["retry"] }), /Retry/);
  assert.match(action(new Error("provider unavailable")), /Retry/);
});

test("merges Conversation, follow-up composer, and Current Plan direct-owner scopes", () => {
  const composerTarget = { id: "prompt" };
  const conversationTarget = { id: "conversation-action" };
  const planTarget = { id: "plan" };
  const slot = {};
  const conversation = {};
  const planRoot = {};
  const conversationRoot = {};
  const planScrollRoot = {};
  const composer = {
    parentElement: slot,
    actionHintTargets(options) {
      assert.equal(options.scopeId, "task:thread-a");
      assert.deepEqual(options.clipRoots, [owner, conversation]);
      return [composerTarget];
    },
  };
  const currentPlan = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:current-plan");
      assert.deepEqual(options.clipRoots, [owner, conversation]);
      return {
        blocked: false,
        targets: [planTarget],
        mutationRoots: [planRoot],
        scrollRoots: [planScrollRoot],
      };
    },
  };
  const conversationOwner = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:conversation");
      assert.deepEqual(options.clipRoots, [owner, conversation]);
      return {
        targets: [conversationTarget],
        mutationRoots: [conversationRoot],
      };
    },
  };
  const owner = {
    hidden: false,
    view: "detail",
    reviewView: "conversation",
    selectedThreadId: "thread-a",
    ensureRendered() {},
    brokenDeleteDialog: () => null,
    followUpComposer: () => composer,
    followUpComposerSlot: () => slot,
    conversationComponent: () => conversationOwner,
    currentPlanComponent: () => currentPlan,
    querySelector: (selector) => selector === ":scope .task-conversation-pane" ? conversation : null,
  };

  assert.deepEqual(taskDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [composerTarget, conversationTarget, planTarget],
    mutationRoots: [slot, conversationRoot, planRoot],
    scrollRoots: [planScrollRoot],
  });

  owner.followUpComposer = () => null;
  assert.deepEqual(taskDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [conversationTarget, planTarget],
    mutationRoots: [conversationRoot, planRoot],
    scrollRoots: [planScrollRoot],
  });
});

test("merges composer popovers, Current Plan, Command, Markdown preview, and permission instruction modals independently", () => {
  const composerContext = { id: "composer-popover" };
  const planContext = { id: "current-plan" };
  const commandContext = { id: "command-output" };
  const markdownPreviewContext = { id: "markdown-preview" };
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
    view: "detail",
    reviewView: "conversation",
    selectedThreadId: "thread-a",
    ensureRendered() {},
    brokenDeleteDialog: () => null,
    followUpComposer: () => composer,
    followUpComposerSlot: () => slot,
    currentPlanComponent: () => ({
      keyboardNavigationContexts: () => [planContext],
    }),
    commandDialog: () => ({
      keyboardNavigationContexts: () => [commandContext],
    }),
    markdownPreviewDialog: () => ({
      keyboardNavigationContexts: () => [markdownPreviewContext],
    }),
    permissionInstructionsDialog: () => ({
      keyboardNavigationContexts: () => [permissionInstructionsContext],
    }),
  };

  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [
      composerContext,
      planContext,
      commandContext,
      markdownPreviewContext,
      permissionInstructionsContext,
    ],
  );
  owner.currentPlanComponent = () => null;
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [
      composerContext,
      commandContext,
      markdownPreviewContext,
      permissionInstructionsContext,
    ],
  );
  owner.markdownPreviewDialog = () => null;
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [composerContext, commandContext, permissionInstructionsContext],
  );
  owner.permissionInstructionsDialog = () => null;
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [composerContext, commandContext],
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
  const waiting = (state) => taskDetail.waitsForConversation.call({
    view: "detail",
    reviewView: "conversation",
    selectedThreadId: "thread-a",
    loading: false,
    taskDetail: null,
    detailLoadError: null,
    hasSelectedTaskDetail() {
      return taskDetail.hasSelectedTaskDetail.call(this);
    },
    ...state,
  });
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
});

test("a Git or GitHub surface waiting for its Task names the wait with the shared phrase", () => {
  const owner = { reviewView: "github", renderLoadErrorAction: () => "" };
  const pending = taskDetail.renderPendingDomain.call(owner, "Loading Task context...");
  assert.match(pending, /<caffold-loading-text>Loading Task context\.\.\.<\/caffold-loading-text>/);
  assert.doesNotMatch(pending, /role="status"/, "the phrase announces itself");

  const failed = taskDetail.renderPendingDomain.call(owner, "Unavailable", { error: true });
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /caffold-loading-text/);
});
