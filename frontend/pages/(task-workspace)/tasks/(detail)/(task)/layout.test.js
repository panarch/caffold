import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const taskDetail = registry.element("caffold-task-detail").prototype;
after(() => registry.restore());

test("merges the follow-up composer and Current Plan direct-owner scopes", () => {
  const composerTarget = { id: "prompt" };
  const planTarget = { id: "plan" };
  const slot = {};
  const conversation = {};
  const planRoot = {};
  const planScrollRoot = {};
  const composer = {
    parentElement: slot,
    actionHintTargets(options) {
      assert.equal(options.scopeId, "task:thread-a");
      assert.deepEqual(options.clipRoots, [owner, conversation]);
      return [composerTarget];
    },
  };
  const currentPlan = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:current-plan");
      assert.deepEqual(options.clipRoots, [owner, conversation]);
      return {
        blocked: false,
        targets: [planTarget],
        mutationRoots: [planRoot],
        scrollRoots: [planScrollRoot],
      };
    },
  };
  const owner = {
    hidden: false,
    view: "detail",
    reviewView: "conversation",
    selectedThreadId: "thread-a",
    ensureRendered() {},
    followUpComposer: () => composer,
    followUpComposerSlot: () => slot,
    currentPlanComponent: () => currentPlan,
    querySelector: () => conversation,
  };

  assert.deepEqual(taskDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [composerTarget, planTarget],
    mutationRoots: [slot, planRoot],
    scrollRoots: [planScrollRoot],
  });

  owner.followUpComposer = () => null;
  assert.deepEqual(taskDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [planTarget],
    mutationRoots: [planRoot],
    scrollRoots: [planScrollRoot],
  });
});
