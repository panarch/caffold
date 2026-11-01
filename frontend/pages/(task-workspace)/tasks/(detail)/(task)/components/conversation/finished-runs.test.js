import assert from "node:assert/strict";
import test from "node:test";

import {
  commandResult,
  groupFinishedRuns,
  isFinishedCommand,
  runGroupIdentity,
} from "./finished-runs.js";

test("folds two or more finished commands in a row and leaves one alone", () => {
  const first = command("a", "completed");
  const second = command("b", "failed");
  const third = command("c", "declined");
  const lone = command("d", "completed");
  const message = event("message", "assistant_message");

  assert.deepEqual(
    groupFinishedRuns([first, second, third, message, lone]),
    [{ kind: "command", group: [first, second, third] }, { event: message }, { event: lone }],
  );
});

test("a running command stays on its own and separates the finished ones", () => {
  const before = command("a", "completed");
  const running = command("b", "inProgress");
  const after = command("c", "completed");
  const unknown = command("d", "");

  assert.deepEqual(
    groupFinishedRuns([before, running, after, unknown]),
    [{ event: before }, { event: running }, { event: after }, { event: unknown }],
  );
  // Once it ends, the commands on either side join it in one group.
  const ended = command("b", "completed");
  assert.deepEqual(
    groupFinishedRuns([before, ended, after]),
    [{ kind: "command", group: [before, ended, after] }],
  );
});

test("only what the reader can see keeps two commands apart", () => {
  const first = command("a", "completed");
  const hidden = event("turn-started", "turn_started");
  const second = command("b", "completed");
  const shown = event("message", "assistant_message");
  const third = command("c", "completed");
  const isShown = (candidate) => candidate.type !== "turn_started";

  assert.deepEqual(
    groupFinishedRuns([first, hidden, second, shown, third], isShown),
    [
      { event: hidden },
      { kind: "command", group: [first, second] },
      { event: shown },
      { event: third },
    ],
  );
});

test("empty thinking around and between commands folds in with them", () => {
  // The way a Claude turn arrives: an empty thinking block where the agent
  // thought, before each command and after the last.
  const opening = thinking("t1");
  const first = command("a", "completed");
  const between = thinking("t2");
  const second = command("b", "failed");
  const closing = thinking("t3");
  const answer = event("answer", "assistant_message");

  assert.deepEqual(
    groupFinishedRuns([opening, first, between, second, closing, answer]),
    [{ kind: "command", group: [opening, first, between, second, closing] }, { event: answer }],
  );
});

test("empty thinking beside a single command stays as it is", () => {
  const opening = thinking("t1");
  const only = command("a", "completed");
  const closing = thinking("t2");
  const running = command("b", "inProgress");

  assert.deepEqual(
    groupFinishedRuns([opening, only, closing, running]),
    [{ event: opening }, { event: only }, { event: closing }, { event: running }],
  );
});

test("thinking with something to read keeps commands apart", () => {
  const first = command("a", "completed");
  const summary = thinking("t1", { summary: ["Checking the callers next."] });
  const second = command("b", "completed");
  const content = thinking("t2", { content: ["The test needs a fixture."] });
  const third = command("c", "completed");

  assert.deepEqual(
    groupFinishedRuns([first, summary, second, content, third]),
    [
      { event: first },
      { event: summary },
      { event: second },
      { event: content },
      { event: third },
    ],
  );
});

test("a group is known by its first command", () => {
  const opening = thinking("t1");
  const first = command("a", "completed");
  const second = command("b", "completed");
  const third = command("c", "completed");

  assert.equal(
    runGroupIdentity("command", [first, second]),
    "command-group:item:thread-1:turn-1:a",
  );
  assert.equal(
    runGroupIdentity("command", [first, second, third]),
    runGroupIdentity("command", [first, second]),
  );
  assert.equal(
    runGroupIdentity("command", [opening, first, second]),
    runGroupIdentity("command", [first, second]),
  );
});

test("folds finished tool calls in a row the way it folds commands", () => {
  const first = toolCall("a", "completed");
  const second = toolCall("b", "failed");
  const running = toolCall("c", "inProgress");
  const lone = toolCall("d", "declined");

  assert.deepEqual(
    groupFinishedRuns([first, second, running, lone]),
    [
      { kind: "tool-call", group: [first, second] },
      { event: running },
      { event: lone },
    ],
  );
});

test("a command and a tool call never share a group", () => {
  const firstCommand = command("a", "completed");
  const secondCommand = command("b", "completed");
  const firstCall = toolCall("c", "completed");
  const secondCall = toolCall("d", "completed");
  const lastCommand = command("e", "completed");

  assert.deepEqual(
    groupFinishedRuns([
      firstCommand,
      secondCommand,
      firstCall,
      secondCall,
      lastCommand,
    ]),
    [
      { kind: "command", group: [firstCommand, secondCommand] },
      { kind: "tool-call", group: [firstCall, secondCall] },
      { event: lastCommand },
    ],
  );
});

test("empty thinking stays with the run it closes", () => {
  const firstCommand = command("a", "completed");
  const secondCommand = command("b", "completed");
  const between = thinking("t1");
  const firstCall = toolCall("c", "completed");
  const secondCall = toolCall("d", "completed");

  assert.deepEqual(
    groupFinishedRuns([
      firstCommand,
      secondCommand,
      between,
      firstCall,
      secondCall,
    ]),
    [
      { kind: "command", group: [firstCommand, secondCommand, between] },
      { kind: "tool-call", group: [firstCall, secondCall] },
    ],
  );
});

test("other work between tool calls keeps them apart", () => {
  const first = toolCall("a", "completed");
  const compaction = event("compaction", "other_work");
  const second = toolCall("b", "completed");

  assert.deepEqual(
    groupFinishedRuns([first, compaction, second]),
    [{ event: first }, { event: compaction }, { event: second }],
  );
});

test("a group of tool calls is known by its first call", () => {
  const opening = thinking("t1");
  const first = toolCall("a", "completed");
  const second = toolCall("b", "completed");

  assert.equal(
    runGroupIdentity("tool-call", [opening, first, second]),
    "tool-call-group:item:thread-1:turn-1:a",
  );
});

test("reads how a command ended from its status and exit code", () => {
  assert.equal(isFinishedCommand(command("a", "completed")), true);
  assert.equal(isFinishedCommand(command("a", "failed")), true);
  assert.equal(isFinishedCommand(command("a", "declined")), true);
  assert.equal(isFinishedCommand(command("a", "inProgress")), false);
  assert.equal(isFinishedCommand(command("a", "")), false);

  assert.equal(commandResult(command("a", "completed")), "completed");
  assert.equal(commandResult(command("a", "failed")), "failed");
  assert.equal(commandResult(command("a", "completed", 1)), "failed");
  assert.equal(commandResult(command("a", "completed", 0)), "completed");
  assert.equal(commandResult(command("a", "declined", 1)), "declined");
});

function command(itemId, status, exitCode) {
  return {
    ...event(itemId, "command_execution"),
    payload: { turnId: "turn-1", itemId, status, exitCode },
  };
}

function toolCall(itemId, status) {
  return {
    ...event(itemId, "tool_call"),
    payload: { turnId: "turn-1", itemId, status, name: "read_note" },
  };
}

function thinking(itemId, { summary = [], content = [""] } = {}) {
  return {
    ...event(itemId, "reasoning"),
    payload: { turnId: "turn-1", itemId, summary, content },
  };
}

function event(id, type) {
  return { id, threadId: "thread-1", type, payload: { turnId: "turn-1" } };
}
