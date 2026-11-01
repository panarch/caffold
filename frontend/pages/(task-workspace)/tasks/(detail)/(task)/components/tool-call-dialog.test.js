import assert from "node:assert/strict";
import test, { after } from "node:test";

import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./tool-call-dialog.js");
const ToolCallDialog = registry.element("caffold-task-tool-call-dialog");
const { ActionHints } = await import("#app/action-hints.js");
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");
const { ScrollSurfaces } = await import("#app/scroll-scope.js");
const { DrawnRefs } = await import("#components/drawn-refs.js");
after(() => registry.restore());

const toolCall = (payload) => ({
  id: "event_tool",
  threadId: "thread-1",
  type: "tool_call",
  payload: { itemId: "tool_item", name: "read_note", ...payload },
});

test("draws a finished call's details, its input, and each piece of its result", () => {
  const drawn = html(
    dialogHost({
      toolCall: toolCall({
        server: "caffold",
        status: "completed",
        durationMs: 40,
        input: { noteId: "n-1" },
        result: [
          { type: "text", text: "# Note" },
          { type: "json", value: { name: "Note" } },
          { type: "binary", mediaType: "image/png" },
          { type: "binary", mediaType: null },
        ],
      }),
    }),
  );

  assert.match(drawn, /<h2 id="task-tool-call-dialog-title">Tool call details<\/h2>/);
  assert.match(drawn, /<p data-tool-call-dialog-status>Completed<\/p>/);
  assert.match(drawn, /<dt>Tool<\/dt><dd><code>read_note<\/code><\/dd>/);
  assert.match(drawn, /<dt>Server<\/dt><dd><code>caffold<\/code><\/dd>/);
  assert.match(drawn, /<dt>Duration<\/dt><dd>1s<\/dd>/);
  // The input and each piece with text in it are code blocks, named after
  // what they hold; a tag's whitespace, the JSON's included, reads as spaces.
  assert.match(
    drawn,
    /<caffold-task-code-block \.label="JSON" \.text="\{ "noteId": "n-1" \}"><\/caffold-task-code-block>/,
  );
  assert.match(
    drawn,
    /<caffold-task-code-block data-tool-call-result-part="text" \.label="Plain text" \.text="# Note">/,
  );
  assert.match(
    drawn,
    /<caffold-task-code-block data-tool-call-result-part="json" \.label="JSON" \.text="\{ "name": "Note" \}">/,
  );
  assert.match(
    drawn,
    /<pre data-tool-call-result-part="binary">\(image\/png not shown\)<\/pre>/,
  );
  assert.match(
    drawn,
    /<pre data-tool-call-result-part="binary">\(Binary content not shown\)<\/pre>/,
  );
});

test("says what a call does not have yet, or did not have", () => {
  const running = html(
    dialogHost({ toolCall: toolCall({ status: "inProgress", server: null }) }),
  );
  const finished = html(
    dialogHost({ toolCall: toolCall({ status: "completed", result: [] }) }),
  );

  assert.match(running, /<p data-tool-call-dialog-status>In progress<\/p>/);
  assert.doesNotMatch(running, /<dt>Server<\/dt>|<dt>Duration<\/dt>/);
  assert.match(running, /<pre>\(No input\)<\/pre>/);
  assert.doesNotMatch(running, /caffold-task-code-block/, "a note has no code block");
  assert.match(running, /<pre data-tool-call-result-part="none">\(No result yet\)<\/pre>/);
  assert.match(finished, /<pre data-tool-call-result-part="none">\(No result\)<\/pre>/);
});

test("follows the open call to its newest report, and only that call", () => {
  const running = toolCall({ status: "inProgress" });
  const finished = toolCall({
    status: "completed",
    result: [{ type: "text", text: "done" }],
  });
  const other = { ...finished, id: "event_other", payload: { ...finished.payload, itemId: "other" } };
  const host = dialogHost({ toolCall: running, dialog: { value: { open: true } } });

  host.follow([other]);
  assert.equal(host.toolCall, running, "another call does not replace the open one");

  host.follow([finished]);
  assert.equal(host.toolCall, finished);

  host.follow([]);
  assert.equal(host.toolCall, finished, "a call no longer listed keeps what was shown");

  const closed = dialogHost({ toolCall: running, dialog: { value: { open: false } } });
  closed.follow([finished]);
  assert.equal(closed.toolCall, running, "a closed dialog follows nothing");
});

test("offers the code blocks the open call shows, under the names its boxes had", () => {
  const blocks = new Map([
    ["input", { isConnected: true }],
    ["result:0", { isConnected: true }],
    // A block a call opened earlier drew, now gone.
    ["result:2", { isConnected: false }],
  ]);
  const host = dialogHost({
    toolCall: toolCall({
      status: "completed",
      input: { noteId: "n-1" },
      result: [
        { type: "text", text: "# Note" },
        { type: "binary", mediaType: "image/png" },
        { type: "json", value: { name: "Note" } },
      ],
    }),
    codeBlocks: { get: (key) => blocks.get(key) },
  });

  assert.deepEqual(
    host.shownCodeBlocks().map(({ key, label, block }) => [key, label, block]),
    [
      ["input", "Tool call input", blocks.get("input")],
      ["result:0", "Tool call result 1", blocks.get("result:0")],
    ],
  );
});

function dialogHost(properties) {
  const host = Object.create(ToolCallDialog.prototype, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      threadId: "thread-1",
      toolCall: null,
      openings: 1,
      dialog: { value: undefined },
      body: { value: undefined },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  host.hints = new ActionHints(host);
  host.surfaces = new ScrollSurfaces(host);
  host.keyboard = new KeyboardContexts(host);
  host.codeBlocks ??= new DrawnRefs(host);
  return host;
}

// Whitespace inside tags and between them goes; what a pre holds stays.
function html(dialog) {
  return templateHtml(dialog.render())
    .replace(/<[^>]*>/g, (tag) => tag.replace(/\s+/g, " ").replace(" >", ">"))
    .replace(/>\s+</g, "><")
    .replaceAll("&quot;", '"')
    .trim();
}
