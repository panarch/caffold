import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./github-issue.js");
const issueSource = registry.element("caffold-github-issue-task-source").prototype;
after(() => registry.restore());

test("provides the native Base branch select and conditional Retry button", () => {
  const calls = [];
  const select = {
    disabled: false,
    focus: () => calls.push("focus"),
    showPicker: () => calls.push("picker"),
  };
  const retry = {
    disabled: false,
    textContent: "Retry",
    focus() {},
    click() {},
  };
  const owner = {
    isConnected: true,
    hidden: false,
    repository: { rootPath: "repo" },
    baseRef: "main",
    refsLoading: false,
    refsError: null,
    locked: false,
    source: () => ({ number: 42 }),
    querySelector(selector) {
      return selector.startsWith("select") ? select : retry;
    },
  };
  const scope = issueSource.actionHintScope.call(owner, {
    scopeId: "github-task-start:issue:42",
    clipRoots: [{}],
  });

  assert.deepEqual(scope.targets.map(({ id, controlKind }) => [id, controlKind]), [
    ["github-task-start:issue:42:base-ref", "select"],
    ["github-task-start:issue:42:retry-refs", "button"],
  ]);
  assert.equal(scope.targets[0].isActionable(), true);
  scope.targets[0].activate();
  assert.deepEqual(calls, ["focus", "picker"]);
  owner.refsLoading = true;
  assert.equal(scope.targets[0].isActionable(), false);
  assert.equal(scope.targets[1].isActionable(), false);
});
