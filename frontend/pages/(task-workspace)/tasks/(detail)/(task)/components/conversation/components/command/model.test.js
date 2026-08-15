import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPresentation,
  sameCommandPresentation,
} from "./model.js";

const event = (status, payload = {}) => ({
  id: "event_command",
  threadId: "thread_command",
  type: "command_execution",
  createdMs: 1_767_450_000_000,
  payload: {
    itemId: "command_item",
    command: "cargo test",
    cwd: "src",
    status,
    ...payload,
  },
});

test("presents an active command as an open disclosure", () => {
  const presentation = commandPresentation(
    event("inProgress", { aggregatedOutput: "Compiling caffold" }),
  );

  assert.equal(presentation.commandKey, "item:thread_command::command_item");
  assert.equal(presentation.mode, "active");
  assert.equal(presentation.defaultOpen, true);
  assert.equal(presentation.status, "inProgress");
  assert.equal(presentation.statusLabel, "inProgress");
  assert.equal(presentation.tone, "active");
  assert.equal(presentation.output, "Compiling caffold");
});

test("presents successful and failed terminal command metadata", () => {
  const completed = commandPresentation(
    event("completed", { durationMs: 1_250, exitCode: 0 }),
  );
  const failed = commandPresentation(
    event("completed", { durationMs: 2_400, exitCode: 101 }),
  );

  assert.deepEqual(
    {
      defaultOpen: completed.defaultOpen,
      metadata: completed.metadata,
      mode: completed.mode,
      result: completed.result,
      statusLabel: completed.statusLabel,
      tone: completed.tone,
    },
    {
      defaultOpen: false,
      metadata: "1s",
      mode: "terminal",
      result: "completed",
      statusLabel: "Completed",
      tone: "neutral",
    },
  );
  assert.equal(failed.metadata, "2s · Exit 101");
  assert.equal(failed.result, "failed");
  assert.equal(failed.statusLabel, "Failed");
  assert.equal(failed.tone, "danger");
});

test("compares only the derived Command snapshot", () => {
  const first = commandPresentation(event("inProgress"));
  const equivalent = commandPresentation({
    ...event("inProgress"),
    summary: "a transport-only summary changed",
  });
  const updated = commandPresentation(
    event("inProgress", { aggregatedOutput: "new output" }),
  );

  assert.equal(sameCommandPresentation(first, equivalent), true);
  assert.equal(sameCommandPresentation(first, updated), false);
});
