import assert from "node:assert/strict";
import test from "node:test";

import {
  commandGroupIdentity,
  commandResult,
  groupFinishedCommands,
  isFinishedCommand,
} from "./command-runs.js";

test("folds two or more finished commands in a row and leaves one alone", () => {
  const first = command("a", "completed");
  const second = command("b", "failed");
  const third = command("c", "declined");
  const lone = command("d", "completed");
  const message = event("message", "assistant_message");

  assert.deepEqual(
    groupFinishedCommands([first, second, third, message, lone]),
    [{ group: [first, second, third] }, { event: message }, { event: lone }],
  );
});

test("a running command stays on its own and separates the finished ones", () => {
  const before = command("a", "completed");
  const running = command("b", "inProgress");
  const after = command("c", "completed");
  const unknown = command("d", "");

  assert.deepEqual(
    groupFinishedCommands([before, running, after, unknown]),
    [{ event: before }, { event: running }, { event: after }, { event: unknown }],
  );
  // Once it ends, the commands on either side join it in one group.
  const ended = command("b", "completed");
  assert.deepEqual(
    groupFinishedCommands([before, ended, after]),
    [{ group: [before, ended, after] }],
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
    groupFinishedCommands([first, hidden, second, shown, third], isShown),
    [
      { event: hidden },
      { group: [first, second] },
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
    groupFinishedCommands([opening, first, between, second, closing, answer]),
    [{ group: [opening, first, between, second, closing] }, { event: answer }],
  );
});

test("empty thinking beside a single command stays as it is", () => {
  const opening = thinking("t1");
  const only = command("a", "completed");
  const closing = thinking("t2");
  const running = command("b", "inProgress");

  assert.deepEqual(
    groupFinishedCommands([opening, only, closing, running]),
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
    groupFinishedCommands([first, summary, second, content, third]),
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
    commandGroupIdentity([first, second]),
    "command-group:item:thread-1:turn-1:a",
  );
  assert.equal(
    commandGroupIdentity([first, second, third]),
    commandGroupIdentity([first, second]),
  );
  assert.equal(
    commandGroupIdentity([opening, first, second]),
    commandGroupIdentity([first, second]),
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

function thinking(itemId, { summary = [], content = [""] } = {}) {
  return {
    ...event(itemId, "reasoning"),
    payload: { turnId: "turn-1", itemId, summary, content },
  };
}

function event(id, type) {
  return { id, threadId: "thread-1", type, payload: { turnId: "turn-1" } };
}
