import assert from "node:assert/strict";
import test from "node:test";

import {
  activeTurnDuration,
  activeTurnPresentation,
} from "./model.js";

test("presents context compaction only while its lifecycle is active", () => {
  const task = activeTask();
  const started = workEvent("contextCompaction", "started");
  const completed = workEvent("contextCompaction", "completed");

  assert.equal(
    activeTurnPresentation([started], task).state,
    "Compacting context…",
  );
  assert.equal(
    activeTurnPresentation([completed], task).state,
    "Thinking",
  );
});

test("preserves active-turn label precedence and work labels", () => {
  const cases = [
    [workEvent("plan", "started"), "Updating plan"],
    [workEvent("commandExecution", "started"), "Running command"],
    [workEvent("mcpToolCall", "started"), "Running command"],
    [workEvent("fileChange", "started"), "Editing files"],
    [event("reasoning", "started"), "Thinking"],
    [event("command_execution", "started"), "Running command"],
    [event("file_change", "started"), "Editing files"],
  ];

  for (const [activeEvent, expected] of cases) {
    assert.equal(
      activeTurnPresentation([activeEvent], activeTask()).state,
      expected,
    );
  }

  assert.equal(
    activeTurnPresentation(
      [workEvent("commandExecution", "started")],
      activeTask(["waitingOnApproval"]),
    ).state,
    "Waiting for approval",
  );
});

test("uses the canonical turn start for duration presentation", () => {
  assert.deepEqual(activeTurnPresentation([], activeTask()), {
    startedMs: 1_000,
    state: "Thinking",
  });
  assert.equal(activeTurnDuration(1_000, 3_000), "Working for 2s");
  assert.equal(activeTurnDuration(null, 3_500), "Working");
});

function activeTask(activeFlags = []) {
  return {
    threadStatus: { type: "active", activeFlags },
    activeTurn: { id: "turn-1", startedAtMs: 1_000 },
  };
}

function workEvent(itemType, lifecycle) {
  return event("work_status", lifecycle, { itemType });
}

function event(type, lifecycle, payload = {}) {
  return {
    type,
    payload: { ...payload, lifecycle },
  };
}
