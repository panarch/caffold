import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./command-dialog.ts");
const CommandDialog = registry.element("caffold-task-command-dialog");
after(() => registry.restore());

test("binds Close and parent plus output Scroll to the controls it drew", () => {
  const close = {
    disabled: false,
    getAttribute: () => "Close command output",
    focus() {},
    click() {},
  };
  const output = layoutElement();
  const body = layoutElement({ clientHeight: 100, scrollHeight: 260 });
  const dialog = layoutElement({ open: true });
  let currentOutput = output;
  const commandDialog = dialogHost({
    threadId: "thread/1",
    dialog,
    closeButton: close,
    body,
    get outputScrollport() {
      return currentOutput;
    },
  });
  const action = commandDialog.actionHintScope().targets[0];
  const surfaces = commandDialog.scrollSurfaceScope().surfaces;

  assert.equal(action.id, "task-command:thread%2F1:close");
  assert.equal(action.isActionable(), true);
  assert.deepEqual(
    surfaces.map(({ id, axes, scrollport }) => ({ id, axes, scrollport })),
    [
      {
        id: "task-command:thread%2F1:body",
        axes: undefined,
        scrollport: body,
      },
      {
        id: "task-command:thread%2F1:output",
        axes: ["horizontal"],
        scrollport: output,
      },
    ],
  );
  assert.equal(surfaces[0].isEligible(), true);
  assert.equal(surfaces[1].isEligible(), true);
  currentOutput = layoutElement();
  assert.equal(surfaces[1].isEligible(), false);
  currentOutput = output;
  commandDialog.threadId = "thread/2";
  assert.equal(action.isActionable(), false);
  assert.equal(surfaces[0].isEligible(), false);
  assert.equal(surfaces[1].isEligible(), false);
});

test("draws a failed command's details and output, and only the details it has", () => {
  const commandDialog = dialogHost({
    command: {
      command: "npm test",
      cwd: "",
      failed: true,
      output: "",
      exitCode: 1,
      durationMs: null,
      createdMs: null,
    },
  });

  const drawn = html(commandDialog);
  assert.match(drawn, /<dialog aria-labelledby="task-command-dialog-title" data-command-status="failed"/);
  assert.match(drawn, /<p data-command-dialog-status>Failed<\/p>/);
  assert.match(drawn, /<dt>Command<\/dt><dd><code>npm test<\/code><\/dd>/);
  assert.match(drawn, /<dt>Exit code<\/dt><dd><code>1<\/code><\/dd>/);
  assert.doesNotMatch(drawn, /Working directory|Duration|Timeline time/);
  assert.match(drawn, /<pre>\(No output\)<\/pre>/);

  const empty = html(dialogHost({}));
  assert.doesNotMatch(empty, /data-command-status="\w/);
  assert.match(empty, /<div class="task-command-dialog-body" data-command-dialog-body><\/div>/);
});

function dialogHost(properties) {
  return Object.create(CommandDialog.prototype, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      threadId: "thread-1",
      command: null,
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

function html(commandDialog) {
  return templateHtml(commandDialog.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
