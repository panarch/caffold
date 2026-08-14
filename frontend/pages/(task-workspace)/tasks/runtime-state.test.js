import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_SUBMISSION_STATE,
  TASK_TRANSPORT_STATE,
  classifyPromptFailure,
  formatTaskStatus,
  isTaskActivelyWorking,
  taskActiveFlagLabel,
  taskActiveFlags,
  taskStatusView,
  taskThreadStatusType,
} from "./runtime-state.js";

function task(type, activeFlags = []) {
  return {
    threadStatus: {
      type,
      activeFlags,
    },
  };
}

test("projects only canonical thread status into task lifecycle UI", () => {
  const active = task("active", [
    "waitingOnUserInput",
    "waitingOnApproval",
  ]);

  assert.equal(taskThreadStatusType(active), "active");
  assert.deepEqual(taskActiveFlags(active), [
    "waitingOnUserInput",
    "waitingOnApproval",
  ]);
  assert.equal(isTaskActivelyWorking(active), true);
  assert.deepEqual(taskStatusView(active), {
    status: "waiting_for_approval",
    label: "approval",
    icon: "CircleAlert",
  });
  assert.equal(taskActiveFlagLabel(active), "Waiting for approval");
  assert.equal(formatTaskStatus(active), "waiting for approval");

  assert.equal(isTaskActivelyWorking(task("idle")), false);
  assert.equal(taskActiveFlagLabel(task("idle")), null);
  assert.equal(taskStatusView(task("idle")), null);
  assert.equal(formatTaskStatus(task("idle")), "idle");
});

test("transport state never masks canonical Task status", () => {
  const active = task("active");

  assert.deepEqual(
    taskStatusView(active, TASK_TRANSPORT_STATE.RECONNECTING),
    {
      status: "running",
      label: "running",
      icon: "",
    },
  );
  assert.deepEqual(
    taskStatusView(active, TASK_TRANSPORT_STATE.UNAVAILABLE),
    {
      status: "running",
      label: "running",
      icon: "",
    },
  );
  assert.equal(
    formatTaskStatus(active, TASK_TRANSPORT_STATE.UNAVAILABLE),
    "active",
  );
  assert.equal(taskThreadStatusType(active), "active");
});

test("classifies only explicit client rejection as safe to roll back", () => {
  assert.equal(
    classifyPromptFailure({ status: 422 }),
    PROMPT_SUBMISSION_STATE.REJECTED,
  );
  assert.equal(
    classifyPromptFailure({ status: 504 }),
    PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN,
  );
  assert.equal(
    classifyPromptFailure({ code: "request_timeout", status: 0 }),
    PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN,
  );
  assert.equal(
    classifyPromptFailure(new TypeError("Failed to fetch")),
    PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN,
  );
});
