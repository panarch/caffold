import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.ts");
const githubLayout = registry.element("caffold-task-github-layout").prototype;
after(() => registry.restore());

test("merges GitHub chrome with only the active Issues or Pulls child", () => {
  const calls = { issues: 0, pulls: 0 };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    mode: "issues",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    scopeId: githubLayout.scopeId,
    hints: { scope: () => ({ targets: [] }) },
    body: { value: {} },
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

test("merges Task Start contexts independently from the active GitHub child", () => {
  const pullContext = { id: "pull-popover" };
  const startContext = { id: "task-start" };
  const owner = {
    active: true,
    hidden: false,
    mode: "pulls",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    scopeId: githubLayout.scopeId,
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

test("delegates Scroll only to the active GitHub domain child", () => {
  const issuesSurface = { id: "issues" };
  const pullsSurface = { id: "pulls" };
  const owner = {
    active: true,
    hidden: false,
    mode: "issues",
    repository: { rootPath: "/repo" },
    currentPath: "/repo",
    scopeId: githubLayout.scopeId,
    performUpdate() {},
    body: { value: {} },
    issuesLayout: {
      scrollSurfaceScope: () => ({ surfaces: [issuesSurface] }),
    },
    pullsLayout: {
      scrollSurfaceScope: () => ({ surfaces: [pullsSurface] }),
    },
  };
  assert.deepEqual(githubLayout.scrollSurfaceScope.call(owner).surfaces, [issuesSurface]);
  owner.mode = "pulls";
  assert.deepEqual(githubLayout.scrollSurfaceScope.call(owner).surfaces, [pullsSurface]);
  owner.hidden = true;
  assert.deepEqual(githubLayout.scrollSurfaceScope.call(owner).surfaces, []);
});
