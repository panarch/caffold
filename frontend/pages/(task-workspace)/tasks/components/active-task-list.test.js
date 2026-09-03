import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./active-task-list.js");
const list = registry.element("caffold-active-task-list").prototype;
after(() => registry.restore());

test("aggregates direct Section Action Hint targets in retained list order", () => {
  const calls = [];
  const sections = ["alpha", "beta"].map((id) => ({
    actionHintTargets(options) {
      calls.push([id, options]);
      return [{ id: `section:${id}:reorder` }];
    },
  }));
  const owner = {
    querySelectorAll: () => sections,
  };
  const options = { clipRoots: [{ id: "task-list" }] };

  assert.deepEqual(list.actionHintTargets.call(owner, options), [
    { id: "section:alpha:reorder" },
    { id: "section:beta:reorder" },
  ]);
  assert.deepEqual(calls, [
    ["alpha", options],
    ["beta", options],
  ]);
});
