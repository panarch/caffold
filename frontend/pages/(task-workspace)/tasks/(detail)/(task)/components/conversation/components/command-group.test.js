import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./command-group.js");
const CommandGroup = registry.element("caffold-task-command-group");
const { ActionHints } = await import("#app/action-hints.js");
const { DrawnRefs } = await import("#components/drawn-refs.js");
const commandGroup = CommandGroup.prototype;
after(() => registry.restore());

test("offers its commands' actions only while it is open", () => {
  const pulls = [];
  const list = {};
  const details = { open: false };
  const owner = Object.assign(Object.create(commandGroup), {
    identity: "command-group:a",
    events: [
      { id: "a", type: "command_execution", payload: {} },
      { id: "b", type: "reasoning", payload: { summary: [] } },
    ],
    hints: { scope: () => ({ targets: [{ id: "disclosure" }] }) },
    details: { value: details },
    list: { value: list },
    commands: {
      get: (key) =>
        key === "a"
          ? {
              actionHintScope(pull) {
                pulls.push(pull);
                return { targets: [{ id: "view-output" }] };
              },
            }
          : undefined,
    },
  });
  const pull = { scopeId: "task:a:command-group:a", clipRoots: [{}] };
  const ids = () =>
    commandGroup.actionHintScope.call(owner, pull).targets.map(({ id }) => id);

  assert.deepEqual(ids(), ["disclosure"]);
  assert.deepEqual(pulls, []);

  details.open = true;
  assert.deepEqual(ids(), ["disclosure", "view-output"]);
  assert.deepEqual(pulls, [
    {
      scopeId: "task:a:command-group:a:command:a",
      clipRoots: [owner, list, ...pull.clipRoots],
    },
  ]);
});

test("knows which entries it folded in by their event ids", () => {
  const owner = {
    events: [{ id: "thinking-a" }, { id: "event-a" }, { id: "event-b" }],
  };

  assert.equal(commandGroup.holdsEvent.call(owner, "event-b"), true);
  assert.equal(commandGroup.holdsEvent.call(owner, "thinking-a"), true);
  assert.equal(commandGroup.holdsEvent.call(owner, "event-c"), false);
  assert.equal(commandGroup.holdsEvent.call(owner, ""), false);
});

test("the same events again change nothing", () => {
  const first = { id: "a", type: "command_execution" };
  const second = { id: "b", type: "command_execution" };
  const third = { id: "c", type: "command_execution" };
  const { hasChanged } = CommandGroup.properties.events;

  assert.equal(hasChanged([first, second], [first, second]), false);
  assert.equal(hasChanged([first, second, third], [first, second]), true);
  assert.equal(hasChanged([first, { ...second }], [first, second]), true);
});

test("draws each command as a row of the group, so the group draws the frame", () => {
  const owner = Object.create(commandGroup, Object.getOwnPropertyDescriptors({
    identity: "command-group:a",
    events: [
      { id: "a", type: "command_execution", payload: { status: "completed" } },
      { id: "b", type: "reasoning", payload: { summary: [] } },
    ],
  }));
  owner.hints = new ActionHints(owner);
  owner.commands = new DrawnRefs(owner);

  const html = templateHtml(owner.render());
  assert.match(
    html,
    /<li\s+class="task-command-group-item"\s+data-item-key="a"\s*>\s*<caffold-task-command\s+data-command-grouped\s/,
  );
  assert.match(html, /class="task-command-group-item task-command-group-thinking"/);
});
