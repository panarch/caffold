import assert from "node:assert/strict";
import test from "node:test";

import { renderConversation } from "./render.js";

test("delegates active-turn presentation to its component snapshot", () => {
  const task = activeTask();
  const turnStarted = turnEvent("turn-started", "turn_started", 1, {
    status: "inProgress",
  });
  const compactionStarted = turnEvent(
    "turn-1:context-compaction-1",
    "work_status",
    2,
    {
      itemId: "context-compaction-1",
      itemType: "contextCompaction",
      lifecycle: "started",
    },
  );
  const compactionCompleted = {
    ...compactionStarted,
    summary: "Context compacted",
    payload: {
      ...compactionStarted.payload,
      lifecycle: "completed",
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
