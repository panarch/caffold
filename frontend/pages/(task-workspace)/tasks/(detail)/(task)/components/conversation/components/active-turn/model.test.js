import assert from "node:assert/strict";
import test from "node:test";

import { activeTurnDuration, activeTurnPresentation } from "./model.js";

test("work Caffold has no surface for says what it is while it runs", () => {
  const task = activeTask();
  const running = toolCall("Compacting context", "inProgress");
  const finished = toolCall("Compacting context", "completed");

  assert.equal(
    activeTurnPresentation([running], task).state,
    "Compacting context…",
  );
  assert.equal(activeTurnPresentation([finished], task).state, "Thinking");
});

test("preserves active-turn label precedence and work labels", () => {
  const cases = [
    [event("plan", "inProgress"), "Updating plan"],
    [event("command_execution", "inProgress"), "Running command"],
    [event("file_change", "inProgress"), "Editing files"],
    [event("reasoning", "inProgress"), "Thinking"],
    [toolCall("Web search", "inProgress"), "Web search…"],
  ];

  for (const [activeEvent, expected] of cases) {
    assert.equal(
      activeTurnPresentation([activeEvent], activeTask()).state,
      expected,
    );
  }

  // What the agent is waiting for outranks what it was last doing.
  assert.equal(
    activeTurnPresentation(
      [event("command_execution", "inProgress")],
      activeTask(["waitingOnApproval"]),
    ).state,
    "Waiting for approval",
  );
});

test("the newest running item is what the turn reports", () => {
  const events = [
    event("command_execution", "completed"),
    event("file_change", "inProgress"),
  ];

  assert.equal(
    activeTurnPresentation(events, activeTask()).state,
    "Editing files",
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

function toolCall(name, status) {
  return event("tool_call", status, { name });
}

function event(type, status, payload = {}) {
  return {
    type,
    payload: { ...payload, status },
  };
}
