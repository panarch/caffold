import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./task-absence.js");
const { ActionHints } = await import("#app/action-hints.js");
const Absence = registry.element("caffold-task-absence");
after(() => registry.restore());

test("offers Restore for an archived Task and says how the request is going", () => {
  const drawn = draw({
    absence: "archived",
    title: " Release notes ",
    restoring: true,
    error: { message: "Restore failed." },
  });

  assert.match(drawn, /<h2>Release notes<\/h2>/);
  assert.match(drawn, /<h3>Task archived<\/h3>/);
  assert.match(drawn, /<p>This Task was archived.<\/p><p>Restore it to open its conversation again.<\/p>/);
  assert.match(drawn, /class="task-absence-actions" \?hidden="false"/);
  assert.match(drawn, /data-task-absence-action="restore" \?disabled="true"/);
  assert.match(drawn, /class="task-absence-progress" role="status" \?hidden="false"/);
  assert.match(drawn, /role="alert" \?hidden="false">Restore failed.<\/p>/);
});

test("a Task Caffold cannot find has no Restore and no title of its own", () => {
  const drawn = draw({ absence: "not-found" });

  assert.match(drawn, /<h2>Unavailable Task<\/h2>/);
  assert.match(drawn, /<h3>Task not found<\/h3>/);
  assert.match(drawn, /class="task-absence-actions" \?hidden="true"/);
  assert.match(drawn, /class="task-absence-progress" role="status" \?hidden="true"/);
});

function draw(snapshot) {
  const absence = Object.create(Absence.prototype, {
    snapshot: { value: snapshot },
  });
  absence.hints = new ActionHints(absence);
  return templateHtml(absence.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><");
}
