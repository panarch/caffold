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

test("does not present a history placement anchor as an item timestamp", () => {
  const historyOnly = {
    ...messageEvent("assistant_message", { phase: "final" }),
    observedMs: null,
  };
  const directlyObserved = {
    ...historyOnly,
    observedMs: 2,
  };

  assert.doesNotMatch(renderConversationEvent(historyOnly, {}), /<time>/);
  assert.match(renderConversationEvent(directlyObserved, {}), /<time>/);
});

test("conversation position alone does not replace an entry's content", () => {
  const message = messageEvent("assistant_message", { phase: "final" });

  assert.equal(
    renderConversationEvent(
      { ...message, position: { anchorMs: 20, index: 0 } },
      {},
    ),
    renderConversationEvent(
      { ...message, position: { anchorMs: 30, index: 1 } },
      {},
    ),
  );
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

test("an agent failure is an error card, not the agent talking", () => {
  // The harness wrote this where an answer would have been. Drawn as a
  // message bubble, "API Error: ..." reads as the agent's answer to what was
  // asked; drawn as an error card, it reads as the turn failing to run.
  const failure = turnEvent("thread-1:turn-1:item-1", "agent_failure", 2, {
    text: "API Error: Connection refused",
  });

  const { html } = renderConversation([failure], activeTask());

  assert.match(html, /data-tool-tone="danger"/);
  assert.match(html, /<strong>Error<\/strong>/);
  assert.match(html, /API Error: Connection refused/);
  assert.doesNotMatch(
    html,
    /task-message-assistant/,
    "a failure must not wear the agent's own bubble",
  );
});

test("a completed turn shows its failure beside the messages, not folded away", () => {
  // The two ways this was lost while being built: classified as work, the
  // failure folded into the collapsed work details; classified as nothing,
  // the completed-turn assembly dropped it entirely.
  const idleTask = {
    id: "thread-1",
    threadId: "thread-1",
    threadStatus: { type: "idle" },
  };
  const prompt = turnEvent("thread-1:turn-1:prompt", "user_message", 1, {
    itemId: "prompt",
    text: "Reply with the single word: ok.",
  });
  const failure = turnEvent("thread-1:turn-1:item-1", "agent_failure", 2, {
    itemId: "item-1",
    text: "API Error: Connection refused",
  });
  const ended = turnEvent("thread-1:turn-1:end", "turn_completed", 3, {
    status: "failed",
  });

  const { html } = renderConversation([prompt, failure, ended], idleTask);

  assert.match(html, /data-tool-tone="danger"/);
  assert.match(html, /API Error: Connection refused/);
  assert.doesNotMatch(
    html,
    /task-work-details[\s\S]*API Error/,
    "the failure must not need work details expanded to be seen",
  );
});

test("a tool call the agent did not name is still an entry", () => {
  const unnamed = turnEvent("thread-1:turn-1:tool-1", "tool_call", 2, {
    itemId: "tool-1",
    status: "completed",
  });

  const { html } = renderConversation([unnamed], activeTask());

  assert.match(html, /<strong>Tool call<\/strong>/);
});

test("a completed background turn renders its answer without a user message", () => {
  const idleTask = {
    id: "thread-1",
    threadId: "thread-1",
    threadStatus: { type: "idle" },
  };
  const answer = turnEvent(
    "thread-1:background-turn:answer",
    "assistant_message",
    2,
    {
      turnId: "background-turn",
      itemId: "answer",
      text: "The background build is done.",
      phase: "final",
    },
  );
  const ended = turnEvent(
    "thread-1:background-turn:end",
    "turn_completed",
    3,
    {
      turnId: "background-turn",
      status: "completed",
      origin: { type: "backgroundTask", taskId: "task-1" },
    },
  );

  const { html } = renderConversation([answer, ended], idleTask);

  assert.match(html, /The background build is done\./);
  assert.match(html, /data-message-role="assistant"/);
  assert.doesNotMatch(html, /data-message-role="user"/);
});

function activeTask() {
  return {
    id: "thread-1",
    threadId: "thread-1",
    threadStatus: { type: "active", activeFlags: [] },
    activeTurn: { id: "turn-1", startedAtMs: 1 },
  };
}

function turnEvent(id, type, anchorMs, payload) {
  return {
    id,
    threadId: "thread-1",
    type,
    summary: type,
    payload: { turnId: "turn-1", ...payload },
    position: { anchorMs, index: 0 },
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
    position: { anchorMs: 1, index: 0 },
  };
}

function hasCodeBlockControls(html) {
  return /<caffold-task-markdown[^>]* code-block-controls>/.test(html);
}
