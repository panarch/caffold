import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const sectionDetail = registry.element("caffold-section-detail").prototype;
after(() => registry.restore());

test("combines New Task actions with the direct Section GitHub shortcuts", () => {
  const taskTarget = { id: "task-create" };
  const githubTarget = { id: "github-issues" };
  const taskCreate = {
    actionHintTargets(options) {
      assert.equal(options.scopeId, "section:section-a");
      return [taskTarget];
    },
  };
  const github = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "section:section-a");
      return { targets: [githubTarget], mutationRoots: [github] };
    },
  };
  const owner = {
    section: { id: "section-a" },
    ensureRendered() {},
    taskCreate: () => taskCreate,
    githubShortcuts: () => github,
  };

  assert.deepEqual(sectionDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [taskTarget, githubTarget],
    mutationRoots: [taskCreate, github],
    scrollRoots: [owner],
  });
});

test("merges Task Create popovers and the Fork modal independently", () => {
  const createContext = { id: "task-create-popover" };
  const forkContext = { id: "fork-dialog" };
  const owner = {
    hidden: false,
    section: { id: "section-a" },
    ensureRendered() {},
    taskCreate: () => ({
      keyboardNavigationContexts(options) {
        assert.equal(options.scopeId, "section:section-a");
        return [createContext];
      },
    }),
    conversationShortcuts: () => ({
      keyboardNavigationContexts: () => [forkContext],
    }),
  };

  assert.deepEqual(
    sectionDetail.keyboardNavigationContexts.call(owner),
    [createContext, forkContext],
  );
  owner.taskCreate = () => null;
  assert.deepEqual(
    sectionDetail.keyboardNavigationContexts.call(owner),
    [forkContext],
  );
});
