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

test("flattens a multi-line script into one summary line and keeps the script", () => {
  // Why the one-line form is the model's to make is commandPresentation's to
  // say; this pins that it is made, and that the script itself survives.
  const script = "sed -n '1,3p' a.md\nprintf 'x'\n\tgit  status";
  const presentation = commandPresentation(
    event("completed", { command: script, exitCode: 0 }),
  );

  assert.equal(presentation.commandLine, "sed -n '1,3p' a.md printf 'x' git status");
  assert.equal(
    presentation.command,
    script,
    "the true shape stays for the surfaces that show it",
  );

  const blank = commandPresentation(event("completed", { command: "  \n  " }));
  assert.equal(blank.command, "(command unavailable)");
  assert.equal(
    blank.commandLine,
    "(command unavailable)",
    "a command that is only whitespace falls back on both forms together",
  );
});

test("presents an active command as an open disclosure", () => {
  const presentation = commandPresentation(
    event("inProgress", { output: "Compiling caffold" }),
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
    event("inProgress", { output: "new output" }),
  );

  assert.equal(sameCommandPresentation(first, equivalent), true);
  assert.equal(sameCommandPresentation(first, updated), false);
});
