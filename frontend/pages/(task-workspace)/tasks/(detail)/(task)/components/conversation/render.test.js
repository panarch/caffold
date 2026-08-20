import assert from "node:assert/strict";
import test from "node:test";

import {
  renderConversation,
  renderConversationEvent,
} from "./render.js";

test("delegates active-turn presentation to its component snapshot", () => {
  const task = activeTask();
  const turnStarted = turnEvent("turn-started", "turn_started", 1, {
    status: "inProgress",
  });
  const compactionStarted = turnEvent(
    "turn-1:context-compaction-1",
    "tool_call",
    2,
    {
      itemId: "context-compaction-1",
      name: "Compacting context",
      status: "inProgress",
    },
  );
  const compactionCompleted = {
    ...compactionStarted,
    summary: "Compacting context: completed",
    payload: {
      ...compactionStarted.payload,
      status: "completed",
    },
    updatedMs: 3,
  };

  const active = renderConversation(
    [turnStarted, compactionStarted],
    task,
  );
  const completed = renderConversation(
    [turnStarted, compactionCompleted],
    task,
  );
  const identity = "active-turn:thread-1:turn-1";

  assert.match(
    active.html,
    /<li[\s\S]*class="task-event task-turn-active"[\s\S]*<caffold-task-active-turn><\/caffold-task-active-turn>/,
  );
  assert.deepEqual(active.activeTurns.get(identity), {
    startedMs: 1,
    state: "Compacting context…",
  });
  assert.deepEqual(completed.activeTurns.get(identity), {
    startedMs: 1,
    state: "Thinking",
  });
});

test("opts only stable user and final assistant messages into code controls", () => {
  const stableUser = renderConversationEvent(messageEvent("user_message"), {});
  const pendingUser = renderConversationEvent(
    messageEvent("user_message", { optimistic: true }),
    {},
  );
  const finalAssistant = renderConversationEvent(
    messageEvent("assistant_message", { phase: "final" }),
    {},
    { messagePhase: "final" },
  );
  const progressAssistant = renderConversationEvent(
    messageEvent("assistant_message", { phase: "progress" }),
    {},
    { messagePhase: "progress" },
  );

  assert.equal(hasCodeBlockControls(stableUser), true);
  assert.equal(hasCodeBlockControls(pendingUser), false);
  assert.equal(hasCodeBlockControls(finalAssistant), true);
  assert.equal(hasCodeBlockControls(progressAssistant), false);
});

test("a pending approval stays visible beside the command it is asking about", () => {
  // Codex names the item its approval is about, and announces that item in the
  // same breath. Both belong on screen: the command is what will run, and the
  // approval is the only thing a person can press.
  const identity = { itemId: "exec-1" };
  const command = turnEvent("thread-1:turn-1:exec-1", "command_execution", 2, {
    ...identity,
    command: "/bin/zsh -lc 'open -a TextEdit'",
    cwd: "src",
    status: "inProgress",
  });
  const approval = turnEvent("approval_requested:401", "approval_requested", 1, {
    ...identity,
    threadId: "thread-1",
    approvalId: "401",
    title: "Command approval requested",
    command: "/bin/zsh -lc 'open -a TextEdit'",
    cwd: "src",
    decisions: ["allow", "denyAndStop"],
  });

  for (const events of [[approval, command], [command, approval]]) {
    const { html } = renderConversation(events, activeTask(), [approval]);

    assert.match(
      html,
      /data-decision="allow"/,
      "a pending approval must offer its answers however its item was ordered",
    );
    assert.match(
      html,
      /task-approval-card/,
      "the approval card must survive beside its own command item",
    );
  }
});

test("a running tool call is a card, not a status chip", () => {
  // While the turn runs, its work is drawn one entry at a time; only after the
  // turn ends does it collapse into work details. A tool call has to be the
  // same thing on both, or the conversation changes shape underneath a reader
  // at the moment the turn finishes.
  const running = turnEvent("thread-1:turn-1:tool-1", "tool_call", 2, {
    itemId: "tool-1",
    name: "Web search",
    status: "inProgress",
  });

  const { html } = renderConversation([running], activeTask());

  assert.match(html, /class="task-event task-tool-card"/);
  assert.doesNotMatch(
    html,
    /task-status-chip/,
    "a tool call names itself rather than restating its own summary",
  );
  assert.match(html, /<strong>Web search<\/strong>/);
  assert.match(html, /Status: inProgress/);
});

test("a failed tool call reads as failed while the turn is still running", () => {
  const failed = turnEvent("thread-1:turn-1:tool-1", "tool_call", 2, {
    itemId: "tool-1",
    name: "inspector.probe",
    status: "failed",
  });

  const { html } = renderConversation([failed], activeTask());

  assert.match(html, /data-tool-tone="danger"/);
});

test("a tool call the agent did not name is still an entry", () => {
  const unnamed = turnEvent("thread-1:turn-1:tool-1", "tool_call", 2, {
    itemId: "tool-1",
    status: "completed",
  });

  const { html } = renderConversation([unnamed], activeTask());

  assert.match(html, /<strong>Tool call<\/strong>/);
});

function activeTask() {
  return {
    id: "thread-1",
    threadId: "thread-1",
    threadStatus: { type: "active", activeFlags: [] },
    activeTurn: { id: "turn-1", startedAtMs: 1 },
  };
}

function turnEvent(id, type, createdMs, payload) {
  return {
    id,
    threadId: "thread-1",
    type,
    summary: type,
    payload: { turnId: "turn-1", ...payload },
    createdMs,
  };
}

function messageEvent(type, payload = {}) {
  return {
    id: `${type}-1`,
    type,
    summary: type,
    payload: {
      text: "```example\nvalue\n```",
      ...payload,
    },
    createdMs: 1,
  };
}

function hasCodeBlockControls(html) {
  return /<caffold-task-markdown[^>]* code-block-controls>/.test(html);
}
