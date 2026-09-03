import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./archived-task-list.js");
const archived = registry.element("caffold-archived-task-list").prototype;
after(() => registry.restore());

function ownedButton(action, threadId = "") {
  return {
    dataset: { taskAction: action, threadId },
    disabled: false,
    textContent: action,
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides every visible archived-list button through retained controls", () => {
  const retry = ownedButton("retry-archived-task-list");
  const loadMore = ownedButton("load-more-archived-tasks");
  const restore = ownedButton("restore-archived-task", "thread-a");
  const remove = ownedButton("delete-archived-task", "thread-a");
  let controls = [retry, loadMore, restore, remove];
  const matching = (selector) => controls.filter((control) =>
    selector.includes(`\"${control.dataset.taskAction}\"`) &&
    (!selector.includes("[data-thread-id]") || control.dataset.threadId)
  );
  const owner = {
    revealed: true,
    hidden: false,
    isConnected: true,
    taskOperationsBlocked: false,
    ensureState() {},
    querySelector: (selector) => matching(selector)[0] ?? null,
    querySelectorAll: matching,
  };

  const scope = archived.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "task-list:archived:retry",
    "task-list:archived:load-more",
    "task-list:archived:restore-archived-task:thread-a",
    "task-list:archived:delete-archived-task:thread-a",
  ]);
  assert.ok(scope.targets.every(({ actionId }) => actionId === "button.activate"));
  scope.targets[2].activate();
  assert.equal(restore.clicks, 1);

  controls = controls.filter((control) => control !== restore);
  assert.equal(scope.targets[2].isActionable(), false);
  owner.taskOperationsBlocked = true;
  assert.equal(scope.targets[0].isActionable(), false);
});
