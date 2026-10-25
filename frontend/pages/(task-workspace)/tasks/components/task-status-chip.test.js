import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./task-status-chip.ts");
const Chip = registry.element("caffold-task-status-chip");
after(() => registry.restore());

function activeTask(activeFlags = []) {
  return { threadStatus: { type: "active", activeFlags } };
}

test("names a waiting Task's status on the chip and draws its icon", () => {
  const chip = chipHost({ task: activeTask(["waitingOnApproval"]) });

  const html = draw(chip);

  assert.deepEqual(chip.attributes, {
    "data-status": "waiting_for_approval",
    title: "approval",
    "aria-label": "approval",
  });
  // The icon set is not loaded here, so the icon draws as its spoken name.
  assert.equal(html, '<span class="sr-only">approval</span>');
});

test("turns a spinner for a running Task, in step unless the chip is staggered", () => {
  const steady = chipHost({ task: activeTask() });
  const spinner = draw(steady);
  assert.match(spinner, /^<span class="task-status-spinner"/);
  assert.doesNotMatch(spinner, /animation-delay/);
  assert.match(spinner, /<span class="sr-only">running<\/span>$/);
  assert.equal(steady.attributes["data-status"], "running");

  const staggered = chipHost({ task: activeTask(), staggered: true });
  const start = /style="animation-delay: (-\d+(?:\.\d+)?)ms"/.exec(draw(staggered));
  assert.ok(start);
  assert.ok(Number(start[1]) < 0 && Number(start[1]) > -800);

  staggered.task = activeTask();
  assert.match(draw(staggered), new RegExp(`animation-delay: ${start[1]}ms`));

  staggered.task = { threadStatus: { type: "idle" } };
  draw(staggered);
  staggered.task = activeTask();
  assert.doesNotMatch(
    draw(staggered),
    new RegExp(`animation-delay: ${start[1]}ms`),
    "a Task that runs again starts somewhere new",
  );
});

test("a Task with no status to show draws nothing and leaves the host unnamed", () => {
  const chip = chipHost({ task: activeTask(["waitingOnUserInput"]) });
  draw(chip);

  chip.task = { threadStatus: { type: "idle" } };
  assert.equal(draw(chip), "");
  assert.deepEqual(chip.attributes, {});
});

// A chip whose attributes are a plain record, drawn by its own lifecycle
// methods in order.
function chipHost(properties) {
  const attributes = {};
  return Object.create(Chip.prototype, {
    ...Object.getOwnPropertyDescriptors({
      task: null,
      staggered: false,
      spinnerDelayMs: null,
      attributes,
      getAttribute: (name) => attributes[name] ?? null,
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      removeAttribute: (name) => {
        delete attributes[name];
      },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

function draw(chip) {
  chip.willUpdate();
  const html = templateHtml(chip.render()).replace(/\s+/g, " ").replaceAll(" >", ">");
  chip.updated();
  return html.trim();
}
