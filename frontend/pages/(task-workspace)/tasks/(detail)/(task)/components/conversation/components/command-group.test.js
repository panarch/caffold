import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./command-group.js");
const commandGroup = registry.element("caffold-task-command-group").prototype;
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
        querySelector: () => null,
      },
      {
        dataset: { itemKey: "item:thread-1:turn-1:a" },
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
    presentation: { label: "Ran 3 commands" },
    ensureState() {},
    disclosure: () => disclosure,
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
    ensureState() {},
    snapshot: { events: [{ id: "thinking-a" }, { id: "event-a" }, { id: "event-b" }] },
  };

  assert.equal(commandGroup.holdsEvent.call(owner, "event-b"), true);
  assert.equal(commandGroup.holdsEvent.call(owner, "thinking-a"), true);
  assert.equal(commandGroup.holdsEvent.call(owner, "event-c"), false);
  assert.equal(commandGroup.holdsEvent.call(owner, ""), false);
});

test("an equal snapshot changes nothing", () => {
  const first = { id: "a", type: "command_execution" };
  const second = { id: "b", type: "command_execution" };
  const third = { id: "c", type: "command_execution" };
  let updates = 0;
  const owner = {
    ensureState() {},
    initialized: true,
    snapshot: { identity: "command-group:a", events: [first, second] },
    update() {
      updates += 1;
    },
  };

  assert.equal(
    commandGroup.setSnapshot.call(owner, {
      identity: "command-group:a",
      events: [first, second],
    }),
    false,
  );
  assert.equal(updates, 0);
  assert.equal(
    commandGroup.setSnapshot.call(owner, {
      identity: "command-group:a",
      events: [first, second, third],
    }),
    true,
  );
  assert.equal(updates, 1);
  assert.equal(owner.presentation.label, "Ran 3 commands");
});
