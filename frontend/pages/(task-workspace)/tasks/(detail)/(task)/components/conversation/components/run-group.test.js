import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./run-group.js");
const RunGroup = registry.element("caffold-task-run-group");
const { ActionHints } = await import("#app/action-hints.js");
const { DrawnRefs } = await import("#components/drawn-refs.js");
const runGroup = RunGroup.prototype;
after(() => registry.restore());

test("offers its commands' actions only while it is open", () => {
  const pulls = [];
  const list = {};
  const details = { open: false };
  const owner = elementStandIn(runGroup, {
    identity: "command-group:a",
    runKind: "command",
    events: [
      { id: "a", type: "command_execution", payload: {} },
      { id: "b", type: "reasoning", payload: { summary: [] } },
    ],
    hints: { scope: () => ({ targets: [{ id: "disclosure" }] }) },
    details: { value: details },
    list: { value: list },
    rows: {
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
    runGroup.actionHintScope.call(owner, pull).targets.map(({ id }) => id);

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

  assert.equal(runGroup.holdsEvent.call(owner, "event-b"), true);
  assert.equal(runGroup.holdsEvent.call(owner, "thinking-a"), true);
  assert.equal(runGroup.holdsEvent.call(owner, "event-c"), false);
  assert.equal(runGroup.holdsEvent.call(owner, ""), false);
});

test("the same events again change nothing", () => {
  const first = { id: "a", type: "command_execution" };
  const second = { id: "b", type: "command_execution" };
  const third = { id: "c", type: "command_execution" };
  const { hasChanged } = RunGroup.getPropertyOptions("events");

  assert.equal(hasChanged([first, second], [first, second]), false);
  assert.equal(hasChanged([first, second, third], [first, second]), true);
  assert.equal(hasChanged([first, { ...second }], [first, second]), true);
});

test("draws each command as a row of the group, so the group draws the frame", () => {
  const owner = elementStandIn(runGroup, {
    identity: "command-group:a",
    events: [
      { id: "a", type: "command_execution", payload: { status: "completed" } },
      { id: "b", type: "reasoning", payload: { summary: [] } },
    ],
  });
  owner.hints = new ActionHints(owner);
  owner.rows = new DrawnRefs(owner);

  const html = templateHtml(owner.render());
  assert.match(
    html,
    /<li\s+class="task-run-group-item"\s+data-item-key="a"\s*>\s*<caffold-task-command\s+data-command-grouped\s/,
  );
  assert.match(html, /class="task-run-group-item task-run-group-thinking"/);
});

test("draws each tool call as a row of the group and offers its View details while open", () => {
  const pulls = [];
  const list = {};
  const owner = elementStandIn(runGroup, {
    identity: "tool-call-group:a",
    runKind: "tool-call",
    events: [
      { id: "a", type: "tool_call", payload: { status: "completed" } },
      { id: "b", type: "tool_call", payload: { status: "failed" } },
    ],
  });
  owner.hints = new ActionHints(owner);
  owner.rows = new DrawnRefs(owner);

  const html = templateHtml(owner.render());
  assert.match(
    html,
    /<li\s+class="task-run-group-item"\s+data-item-key="b"\s*>\s*<caffold-task-tool-call\s+data-tool-call-grouped\s/,
  );
  assert.match(html, />Called 2 tools</);
  assert.match(html, />1 failed</);

  owner.hints = { scope: () => ({ targets: [{ id: "disclosure" }] }) };
  owner.details = { value: { open: true } };
  owner.list = { value: list };
  owner.rows = {
    get: (key) => ({
      actionHintScope(pull) {
        pulls.push(pull.scopeId);
        return { targets: [{ id: `view-details:${key}` }] };
      },
    }),
  };
  const ids = runGroup.actionHintScope
    .call(owner, { scopeId: "task:a:tool-call-group:a" })
    .targets.map(({ id }) => id);

  assert.deepEqual(ids, ["disclosure", "view-details:a", "view-details:b"]);
  assert.deepEqual(pulls, [
    "task:a:tool-call-group:a:tool-call:a",
    "task:a:tool-call-group:a:tool-call:b",
  ]);
});
