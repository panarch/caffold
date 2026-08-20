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
