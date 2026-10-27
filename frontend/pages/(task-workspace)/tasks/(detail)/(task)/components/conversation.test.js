import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./conversation.js");
const conversation = registry.element("caffold-task-conversation").prototype;
after(() => registry.restore());

// A Conversation showing `entries`, whose parts answer from `parts` by their
// `kind:identity` and whose approval cards answer from `approvals` by id.
function conversationOwner({ entries, parts = {}, approvals = {}, ...rest }) {
  return Object.create(conversation, Object.getOwnPropertyDescriptors({
    active: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    shownEntries: entries,
    scrollerElement: { value: {} },
    list: { value: {} },
    olderHistoryElement: { value: undefined },
    parts: { get: (key) => parts[key] },
    approvals: { get: (id) => approvals[id] },
    ...rest,
  }));
}

test("offers its own Scroll surface and each part's while it shows a Task", () => {
  const pulls = [];
  const part = (id) => ({
    scrollSurfaceScope(pull) {
      pulls.push(pull);
      return { surfaces: [{ id }] };
    },
  });
  let ownPull;
  const owner = conversationOwner({
    entries: [
      { kind: "command", identity: "command-a" },
      { kind: "status", identity: "status-a" },
      { kind: "assistant-message", identity: "message-a" },
      {
        kind: "approvals",
        identity: "flow-a",
        requests: [{ approvalId: "approval:a" }, { approvalId: "gone" }],
      },
    ],
    parts: {
      "command:command-a": part("command-output"),
      "message:message-a": part("table"),
    },
    approvals: {
      "approval:a": { approvalId: "approval:a", ...part("approval-command") },
    },
    surfaces: {
      scope(pull) {
        ownPull = pull;
        return { surfaces: [{ id: "conversation" }] };
      },
    },
  });
  const clip = {};
  const ids = (pull) =>
    conversation.scrollSurfaceScope
      .call(owner, pull)
      .surfaces.map(({ id }) => id);

  assert.deepEqual(ids({ clipRoots: [clip] }), [
    "conversation",
    "command-output",
    "table",
    "approval-command",
  ]);
  assert.deepEqual(ownPull, {
    scopeId: "task:thread-a:conversation",
    label: "Conversation",
    clipRoots: [clip],
  });
  assert.deepEqual(pulls.map(({ scopeId }) => scopeId), [
    "task:thread-a:conversation:command:command-a",
    "task:thread-a:conversation:message:message-a",
    "task:thread-a:conversation:approval:approval%3Aa:flow-a",
  ]);
  assert.deepEqual(pulls[0].clipRoots, [
    owner,
    owner.scrollerElement.value,
    owner.list.value,
    clip,
  ]);

  owner.active = false;
  assert.deepEqual(ids(), []);
  owner.active = true;
  owner.snapshot = { threadId: "thread-a", task: null };
  assert.deepEqual(ids(), []);
});

test("merges its own actions with older history's and each part's while it shows a Task", () => {
  const pulls = [];
  const part = (id) => ({
    actionHintScope(pull) {
      pulls.push(pull);
      return { targets: [{ id }] };
    },
  });
  const owner = conversationOwner({
    entries: [
      { kind: "user-message", identity: "prompt-a" },
      { kind: "generated-image", identity: "picture-a" },
      { kind: "thinking", identity: "thinking-a" },
      { kind: "command", identity: "command-a" },
      { kind: "command-group", identity: "group-a" },
      { kind: "turn-work", identity: "work-a" },
      {
        kind: "approvals",
        identity: "flow-a",
        requests: [{ approvalId: "approval-a" }],
      },
    ],
    parts: {
      "message:prompt-a": part("prompt-preview"),
      "attachments:picture-a": part("generated-preview"),
      "thinking:thinking-a": part("thinking-copy"),
      "command:command-a": part("command-output"),
      "command-group:group-a": part("group-toggle"),
      "work-details:work-a": part("work-toggle"),
    },
    approvals: {
      "approval-a": { approvalId: "approval-a", ...part("approval-choice") },
    },
    olderHistoryElement: { value: part("older-page") },
    hints: { scope: () => ({ targets: [{ id: "retry" }] }) },
  });
  const clip = {};
  const pull = { scopeId: "conversation", clipRoots: [clip] };

  assert.deepEqual(
    conversation.actionHintScope.call(owner, pull).targets.map(({ id }) => id),
    [
      "retry",
      "older-page",
      "prompt-preview",
      "generated-preview",
      "thinking-copy",
      "command-output",
      "group-toggle",
      "work-toggle",
      "approval-choice",
    ],
  );
  assert.deepEqual(pulls.map(({ scopeId }) => scopeId), [
    "conversation:older-history",
    "conversation:message:prompt-a",
    "conversation:attachments:picture-a",
    "conversation:thinking:thinking-a",
    "conversation:command:command-a",
    "conversation:command-group:group-a",
    "conversation:work-details:work-a",
    "conversation:approval:approval-a:flow-a",
  ]);
  const scroller = owner.scrollerElement.value;
  assert.deepEqual(pulls[0].clipRoots, [owner, scroller, clip]);
  assert.deepEqual(pulls[1].clipRoots, [owner, scroller, owner.list.value, clip]);

  owner.active = false;
  assert.deepEqual(conversation.actionHintScope.call(owner, pull).targets, []);
});

test("forwards only the current direct history child's intent", () => {
  const child = {};
  const intents = [];
  const owner = {
    active: true,
    snapshot: { threadId: "a" },
    olderHistory: () => child,
    dispatchIntent: (...intent) => intents.push(intent),
  };
  const emit = (target, threadId, retry = false) =>
    conversation.requestOlderHistory.call(owner, {
      target, detail: { threadId, retry }, stopPropagation() {},
    });
  emit({}, "a");
  emit(child, "old-task");
  assert.deepEqual(intents, []);
  emit(child, "a");
  emit(child, "a", true);
  assert.deepEqual(intents, [
    [{ type: "older-history", retry: false }],
    [{ type: "older-history", retry: true }],
  ]);
  owner.active = false;
  emit(child, "a");
  assert.equal(intents.length, 2);
});

test("forwards a suggested prompt only from a message it shows, while it can be sent", () => {
  const chips = new HTMLElement();
  const stray = new HTMLElement();
  const intents = [];
  const owner = {
    active: true,
    snapshot: { threadId: "thread-a", transportState: "live" },
    conversationList: () => ({ contains: (node) => node === chips }),
    dispatchIntent: (...intent) => intents.push(intent),
  };
  let stopped = 0;
  const emit = (target, threadId, prompt = "Do the next thing.") =>
    conversation.sendSuggestedPrompt.call(owner, {
      target,
      detail: { threadId, prompt },
      stopPropagation() {
        stopped += 1;
      },
    });

  emit(stray, "thread-a");
  emit({}, "thread-a");
  assert.equal(stopped, 0, "an intent from elsewhere passes through untouched");
  emit(chips, "old-thread");
  emit(chips, "thread-a", " ");
  assert.deepEqual(intents, []);
  emit(chips, "thread-a");
  assert.deepEqual(intents, [
    [{ type: "suggested-prompt", prompt: "Do the next thing." }],
  ]);
  owner.snapshot.transportState = "reconnecting";
  emit(chips, "thread-a");
  owner.snapshot.transportState = "live";
  owner.active = false;
  emit(chips, "thread-a");
  assert.equal(intents.length, 1);
});

test("forwards approval intent only from the current Task's mounted card", () => {
  const card = { approvalId: 'mcp:"42"' };
  const intents = [];
  const owner = {
    active: true,
    snapshot: { threadId: "thread-a", transportState: "live" },
    approvalComponents: () => [card],
    dispatchIntent: (...intent) => intents.push(intent),
  };
  const emit = (target, threadId) => conversation.sendApproval.call(owner, {
    target, detail: { threadId, approvalId: card.approvalId, decision: "cancel" },
    stopPropagation() {},
  });
  emit({}, "thread-a");
  emit(card, "old-thread");
  assert.deepEqual(intents, []);
  emit(card, "thread-a");
  assert.deepEqual(intents, [
    [{ type: "approval", approvalId: 'mcp:"42"', decision: "cancel" }],
  ]);
  owner.snapshot.transportState = "reconnecting";
  emit(card, "thread-a");
  owner.snapshot.transportState = "live";
  owner.active = false;
  emit(card, "thread-a");
  assert.equal(intents.length, 1);
});
