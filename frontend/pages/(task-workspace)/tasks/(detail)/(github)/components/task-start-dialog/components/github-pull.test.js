import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./github-pull.js");
const pullSource = registry.element("caffold-github-pull-task-source").prototype;
after(() => registry.restore());

test("provides Refresh PR only from the exact current error control", () => {
  const control = {
    disabled: false,
    textContent: "Refresh PR",
    focus() {},
    click() {},
  };
  const owner = {
    isConnected: true,
    hidden: false,
    repository: { rootPath: "repo" },
    pending: false,
    locked: false,
    source: () => ({ number: 7 }),
    querySelector: () => control,
  };
  const target = pullSource.actionHintScope.call(owner, {
    scopeId: "github-task-start:pull:7",
  }).targets[0];

  assert.equal(target.id, "github-task-start:pull:7:refresh");
  assert.equal(target.isActionable(), true);
  owner.pending = true;
  assert.equal(target.isActionable(), false);
});
