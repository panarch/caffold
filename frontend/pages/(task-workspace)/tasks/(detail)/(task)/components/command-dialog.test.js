import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./command-dialog.js");
const CommandDialog = registry.element("caffold-task-command-dialog");
const { ActionHints } = await import("#app/action-hints.js");
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");
const { ScrollSurfaces } = await import("#app/scroll-scope.js");
after(() => registry.restore());

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
  const host = Object.create(CommandDialog.prototype, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      threadId: "thread-1",
      command: null,
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  host.hints = new ActionHints(host);
  host.surfaces = new ScrollSurfaces(host);
  host.keyboard = new KeyboardContexts(host);
  return host;
}

function html(commandDialog) {
  return templateHtml(commandDialog.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
