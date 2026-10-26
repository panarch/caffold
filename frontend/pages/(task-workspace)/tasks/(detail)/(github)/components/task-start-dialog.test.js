import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./task-start-dialog.ts");
const taskStart = registry.element("caffold-github-task-start-dialog").prototype;
after(() => registry.restore());

test("merges its buttons with the turn options' and the source's, held while starting", () => {
  const body = {};
  const pulls = [];
  const scope = (name) => (pull) => {
    pulls.push([name, pull]);
    return { targets: [{ id: name }] };
  };
  const owner = {
    pending: false,
    body: { value: body },
    hints: { scope: scope("own") },
    turnOptions: { actionHintScope: scope("turn-options") },
    sourceComponent: { actionHintScope: scope("source") },
  };
  const root = {};
  const pull = { scopeId: "github-task-start:issue:12", clipRoots: [root] };

  const merged = taskStart.actionHintScope.call(owner, pull);
  assert.deepEqual(merged.targets.map(({ id }) => id), [
    "own",
    "turn-options",
    "source",
  ]);
  assert.equal(merged.blocked, false);
  assert.deepEqual(pulls, [
    ["own", pull],
    [
      "turn-options",
      { scopeId: "github-task-start:issue:12", clipRoots: [root, body] },
    ],
    [
      "source",
      { scopeId: "github-task-start:issue:12", clipRoots: [root, body] },
    ],
  ]);

  owner.pending = true;
  assert.equal(taskStart.actionHintScope.call(owner, pull).blocked, true);
});

test("sends Escape in the branch list to Cancel", () => {
  const cancel = {};
  const select = {};
  let capabilities;
  const owner = {
    keyboard: {
      contexts(given) {
        capabilities = given;
        return [];
      },
    },
    issueSource: { isBaseRefSelect: (element) => element === select },
    cancelButton: { value: cancel },
    turnOptions: { keyboardNavigationContexts: () => [] },
  };

  taskStart.keyboardNavigationContexts.call(owner);
  assert.equal(capabilities.editing.escapeTarget(select), cancel);
  assert.equal(capabilities.editing.escapeTarget({}), null);
});
