import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { datasetAttribute } from "../../../../../../../../tests/support/dataset-attribute.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./command-group.ts");
const CommandGroup = registry.element("caffold-task-command-group");
const commandGroup = CommandGroup.prototype;
after(() => registry.restore());

test("offers its disclosure, and its commands' actions only while open", () => {
  const commandTarget = { id: "view-output" };
  let commandOptions;
  const command = {
    actionHintScope(options) {
      commandOptions = options;
      return { targets: [commandTarget] };
    },
  };
  const list = {
    children: [
      // A thinking row has no control to offer.
      {
        dataset: { itemKey: "item:thread-1:turn-1:thinking" },
        getAttribute: datasetAttribute,
        querySelector: () => null,
      },
      {
        dataset: { itemKey: "item:thread-1:turn-1:a" },
        getAttribute: datasetAttribute,
        querySelector: () => command,
      },
    ],
  };
  let clicks = 0;
  const anchor = { id: "group-chevron" };
  const summary = {
    querySelector: () => anchor,
    focus() {},
    click() {
      clicks += 1;
    },
  };
  const disclosure = {
    open: false,
    querySelector: (selector) => selector.includes("summary") ? summary : list,
  };
  const owner = {
    isConnected: true,
    hidden: false,
    identity: "command-group:item:thread-1:turn-1:a",
    events: ["a", "b", "c"].map((id) => ({ id, type: "command_execution" })),
    disclosure,
  };

  const collapsed = commandGroup.actionHintScope.call(owner, {
    scopeId: "task:a:conversation:command-group:g",
  });
  assert.deepEqual(
    collapsed.targets.map(({ id, actionId, label, controlKind, anchor }) => ({
      id,
      actionId,
      label,
      controlKind,
      anchor,
    })),
    [{
      id:
        "task:a:conversation:command-group:g:disclosure:command-group%3Aitem%3Athread-1%3Aturn-1%3Aa",
      actionId: "disclosure.toggle",
      label: "Expand Ran 3 commands",
      controlKind: "disclosure",
      anchor,
    }],
  );
  assert.equal(commandOptions, undefined);
  collapsed.targets[0].activate();
  assert.equal(clicks, 1);

  disclosure.open = true;
  const expanded = commandGroup.actionHintScope.call(owner, {
    scopeId: "task:a:conversation:command-group:g",
  });
  assert.deepEqual(expanded.targets.map(({ id }) => id), [
    collapsed.targets[0].id,
    "view-output",
  ]);
  assert.equal(expanded.targets[0].label, "Collapse Ran 3 commands");
  assert.equal(
    commandOptions.scopeId,
    "task:a:conversation:command-group:g:command:item:thread-1:turn-1:a",
  );
  assert.deepEqual(commandOptions.clipRoots, [owner, list]);

  owner.identity = "command-group:other";
  assert.equal(expanded.targets[0].isActionable(), false);
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

  const html = templateHtml(owner.render());
  assert.match(
    html,
    /<li\s+class="task-command-group-item"\s+data-item-key="a"\s*>\s*<caffold-task-command\s+data-command-grouped\s/,
  );
  assert.match(html, /class="task-command-group-item task-command-group-thinking"/);
});
