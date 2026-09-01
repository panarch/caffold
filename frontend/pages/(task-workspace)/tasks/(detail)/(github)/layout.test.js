import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const githubLayout = registry.element("caffold-task-github-layout").prototype;
after(() => registry.restore());

test("merges GitHub chrome with only the active Issues or Pulls child", () => {
  const back = { hidden: true, disabled: false };
  const calls = { issues: 0, pulls: 0 };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    mode: "issues",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    backButton: back,
    ensureRendered() {},
    querySelector(selector) {
      return selector.includes("task-domain-body") ? {} : back;
    },
    issuesLayout: {
      actionHintScope() {
        calls.issues += 1;
        return { targets: [{ id: "issues" }] };
      },
    },
    pullsLayout: {
      actionHintScope() {
        calls.pulls += 1;
        return { targets: [{ id: "pulls" }] };
      },
    },
  };

  assert.deepEqual(
    githubLayout.actionHintScope.call(owner).targets,
    [{ id: "issues" }],
  );
  assert.deepEqual(calls, { issues: 1, pulls: 0 });
  owner.mode = "pulls";
  assert.deepEqual(
    githubLayout.actionHintScope.call(owner).targets,
    [{ id: "pulls" }],
  );
  assert.deepEqual(calls, { issues: 1, pulls: 1 });
});

test("binds domain Back to its canonical GitHub parent", () => {
  const focusOptions = [];
  let clicks = 0;
  let parentRoute = { kind: "pulls", page: 1, number: 7 };
  const back = {
    hidden: false,
    disabled: false,
    getAttribute: () => "Back to PR",
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    mode: "pulls",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    backButton: back,
    ensureRendered() {},
    routeForWorkspaceBack: () => parentRoute,
    querySelector(selector) {
      return selector.includes("task-domain-body") ? {} : back;
    },
    issuesLayout: { actionHintScope: () => ({ targets: [] }) },
    pullsLayout: { actionHintScope: () => ({ targets: [] }) },
  };

  const target = githubLayout.actionHintScope.call(owner).targets[0];
  assert.equal(target.id, "github:%2Frepo:parent:pull:7");
  assert.equal(target.label, "Back to PR");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  parentRoute = { kind: "pulls", page: 1 };
  assert.equal(target.isActionable(), false);
});

test("merges Task Start contexts independently from the active GitHub child", () => {
  const pullContext = { id: "pull-popover" };
  const startContext = { id: "task-start" };
  const owner = {
    active: true,
    hidden: false,
    mode: "pulls",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    ensureRendered() {},
    pullsLayout: {
      keyboardNavigationContexts(options) {
        assert.equal(options.scopeId, "github:%2Frepo:pulls");
        return [pullContext];
      },
    },
    taskStartDialog: {
      keyboardNavigationContexts: () => [startContext],
    },
  };

  assert.deepEqual(
    githubLayout.keyboardNavigationContexts.call(owner),
    [pullContext, startContext],
  );
  owner.mode = "issues";
  assert.deepEqual(
    githubLayout.keyboardNavigationContexts.call(owner),
    [startContext],
  );
});
