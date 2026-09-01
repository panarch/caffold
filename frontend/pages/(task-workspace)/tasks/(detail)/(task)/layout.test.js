import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const taskDetail = registry.element("caffold-task-detail").prototype;
after(() => registry.restore());

test("merges Conversation, follow-up composer, and Current Plan direct-owner scopes", () => {
  const composerTarget = { id: "prompt" };
  const conversationTarget = { id: "conversation-action" };
  const planTarget = { id: "plan" };
  const slot = {};
  const conversation = {};
  const planRoot = {};
  const conversationRoot = {};
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
  const conversationOwner = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:conversation");
      assert.deepEqual(options.clipRoots, [owner, conversation]);
      return {
        targets: [conversationTarget],
        mutationRoots: [conversationRoot],
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
    conversationComponent: () => conversationOwner,
    currentPlanComponent: () => currentPlan,
    querySelector: () => conversation,
  };

  assert.deepEqual(taskDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [composerTarget, conversationTarget, planTarget],
    mutationRoots: [slot, conversationRoot, planRoot],
    scrollRoots: [planScrollRoot],
  });

  owner.followUpComposer = () => null;
  assert.deepEqual(taskDetail.actionHintScope.call(owner), {
    blocked: false,
    targets: [conversationTarget, planTarget],
    mutationRoots: [conversationRoot, planRoot],
    scrollRoots: [planScrollRoot],
  });
});

test("merges composer popovers, Current Plan, and Command modal independently", () => {
  const composerContext = { id: "composer-popover" };
  const planContext = { id: "current-plan" };
  const commandContext = { id: "command-output" };
  const slot = {};
  const composer = {
    parentElement: slot,
    keyboardNavigationContexts(options) {
      assert.equal(options.scopeId, "task:thread-a");
      return [composerContext];
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
    currentPlanComponent: () => ({
      keyboardNavigationContexts: () => [planContext],
    }),
    commandDialog: () => ({
      keyboardNavigationContexts: () => [commandContext],
    }),
  };

  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [composerContext, planContext, commandContext],
  );
  owner.currentPlanComponent = () => null;
  assert.deepEqual(
    taskDetail.keyboardNavigationContexts.call(owner),
    [composerContext, commandContext],
  );
});
