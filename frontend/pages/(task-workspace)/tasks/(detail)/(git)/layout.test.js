import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const gitLayout = registry.element("caffold-task-git-layout").prototype;
after(() => registry.restore());

test("merges Git chrome with only the active Compare or Log child", () => {
  const back = { hidden: true, disabled: false };
  const calls = { compare: 0, log: 0 };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    mode: "compare",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    backButton: back,
    ensureRendered() {},
    querySelector(selector) {
      return selector.includes("task-domain-body") ? {} : back;
    },
    comparePage: {
      actionHintScope() {
        calls.compare += 1;
        return { targets: [{ id: "compare" }] };
      },
    },
    logLayout: {
      actionHintScope() {
        calls.log += 1;
        return { targets: [{ id: "log" }] };
      },
    },
  };

  assert.deepEqual(gitLayout.actionHintScope.call(owner).targets, [{ id: "compare" }]);
  assert.deepEqual(calls, { compare: 1, log: 0 });
  owner.mode = "log";
  assert.deepEqual(gitLayout.actionHintScope.call(owner).targets, [{ id: "log" }]);
  assert.deepEqual(calls, { compare: 1, log: 1 });
});
