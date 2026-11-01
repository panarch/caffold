import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./tool-call.js");
const ToolCall = registry.element("caffold-task-tool-call");
const { ActionHints } = await import("#app/action-hints.js");
const { toolCallPresentation } = await import("./tool-call/model.js");
const toolCall = ToolCall.prototype;
after(() => registry.restore());

const event = {
  id: "event_tool",
  threadId: "thread_tool",
  type: "tool_call",
  payload: {
    itemId: "tool_item",
    name: "create_note",
    server: "caffold",
    status: "failed",
    durationMs: 1200,
  },
};

test("draws one line: status, name, server and duration, and View details", () => {
  const owner = elementStandIn(toolCall, {
    presentation: toolCallPresentation(event),
  });
  owner.hints = new ActionHints(owner);

  const drawn = templateHtml(toolCall.render.call(owner))
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();

  assert.match(
    drawn,
    /<span class="task-tool-call-summary-status" data-tool-call-status="failed">Failed<\/span>/,
  );
  assert.match(drawn, /<code class="task-tool-call-summary-label">create_note<\/code>/);
  assert.match(drawn, /caffold · 1s<\/span>/);
  assert.match(drawn, /aria-haspopup="dialog" @click="">View details<\/button>/);
});

test("asks for the details of the call it draws", () => {
  const sent = [];
  const owner = elementStandIn(toolCall, {
    presentation: toolCallPresentation(event),
    dispatchEvent: (intent) => sent.push(intent),
  });

  toolCall.requestDetails.call(owner, { stopPropagation() {} });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "caffold:task-tool-call-intent");
  assert.equal(sent[0].bubbles, true);
  assert.equal(sent[0].composed, true);
  assert.deepEqual(sent[0].detail, {
    type: "tool-call-details",
    toolCallKey: toolCallPresentation(event).key,
  });
});
