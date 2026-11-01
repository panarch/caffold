import assert from "node:assert/strict";
import test from "node:test";
import { toolCallPresentation } from "./model.js";

const event = (payload = {}) => ({
  id: "event_tool",
  threadId: "thread_tool",
  type: "tool_call",
  payload: { itemId: "tool_item", name: "create_note", ...payload },
});

test("reads how far along the call is in the words a command row uses", () => {
  assert.deepEqual(
    ["completed", "failed", "declined", "inProgress"].map((status) => {
      const { statusLabel, tone } = toolCallPresentation(event({ status }));
      return [statusLabel, tone];
    }),
    [
      ["Completed", "neutral"],
      ["Failed", "danger"],
      ["Declined", "neutral"],
      ["In progress", "neutral"],
    ],
  );
});

test("names the server and duration only when the agent reported them", () => {
  assert.equal(
    toolCallPresentation(
      event({ status: "completed", server: "caffold", durationMs: 300 }),
    ).metadata,
    "caffold · 1s",
  );
  assert.equal(
    toolCallPresentation(event({ status: "completed", server: "caffold" }))
      .metadata,
    "caffold",
  );
  assert.equal(
    toolCallPresentation(event({ status: "completed", server: null })).metadata,
    "",
  );
});

test("keeps the agent's name for the tool and a key for the call", () => {
  const presentation = toolCallPresentation(
    event({ status: "completed", name: "mcp__caffold__create_note" }),
  );

  assert.equal(presentation.name, "mcp__caffold__create_note");
  assert.ok(presentation.key, "a call can be found again by its identity");
  assert.equal(toolCallPresentation(event({ name: " " })).name, "Tool call");
});
