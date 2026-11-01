import assert from "node:assert/strict";
import test from "node:test";

import { runGroupPresentation } from "./model.js";

test("says how many commands ran and how many did not succeed", () => {
  assert.deepEqual(
    runGroupPresentation("command", [
      command("completed"),
      command("failed"),
      command("completed", 2),
      command("declined"),
    ]),
    { label: "Ran 4 commands", failed: "2 failed", declined: "1 declined" },
  );
});

test("leaves out results nothing had", () => {
  assert.deepEqual(
    runGroupPresentation("command", [command("completed"), command("completed", 0)]),
    { label: "Ran 2 commands", failed: "", declined: "" },
  );
});

test("counts only the commands, not the thinking folded in with them", () => {
  assert.deepEqual(
    runGroupPresentation("command", [
      thinking(),
      command("completed"),
      thinking(),
      command("failed"),
      thinking(),
    ]),
    { label: "Ran 2 commands", failed: "1 failed", declined: "" },
  );
});

test("says how many tools were called and how many did not succeed", () => {
  assert.deepEqual(
    runGroupPresentation("tool-call", [
      toolCall("completed"),
      thinking(),
      toolCall("failed"),
      toolCall("declined"),
      toolCall("completed"),
    ]),
    { label: "Called 4 tools", failed: "1 failed", declined: "1 declined" },
  );
});

function command(status, exitCode) {
  return { type: "command_execution", payload: { status, exitCode } };
}

function toolCall(status) {
  return { type: "tool_call", payload: { status, name: "read_note" } };
}

function thinking() {
  return { type: "reasoning", payload: { summary: [], content: [""] } };
}
