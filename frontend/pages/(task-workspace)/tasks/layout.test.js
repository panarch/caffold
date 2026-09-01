import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const tasksPage = registry.element("caffold-tasks-page").prototype;
after(() => registry.restore());

test("combines Navigator with only the active direct-child surface", () => {
  const navigatorTarget = { id: "navigator" };
  const newTarget = { id: "new" };
  const detailTarget = { id: "detail" };
  const navigatorRoot = {};
  const newRoot = {};
  const detailRoot = {};
  let newCalls = 0;
  let detailCalls = 0;
  const navigatorOwner = {
    visible: true,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    actionHintScope: () => ({
      targets: [navigatorTarget],
      mutationRoots: [navigatorRoot],
      scrollRoots: [],
    }),
  };
  const owner = {
    visible: true,
    view: "new",
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    ensureRendered() {},
    taskNavigator() {
      return navigatorOwner;
    },
    taskNew() {
      return {
        actionHintScope() {
          newCalls += 1;
          return {
            targets: [newTarget],
            mutationRoots: [newRoot],
            scrollRoots: [],
          };
        },
      };
    },
    taskDetail() {
      return {
        actionHintScope() {
          detailCalls += 1;
          return {
            blocked: true,
            targets: [detailTarget],
            mutationRoots: [detailRoot],
            scrollRoots: [],
          };
        },
      };
    },
  };

  assert.deepEqual(tasksPage.actionHintScope.call(owner), {
    blocked: false,
    targets: [navigatorTarget, newTarget],
    mutationRoots: [navigatorRoot, newRoot],
    scrollRoots: [],
  });
  assert.equal(newCalls, 1);
  assert.equal(detailCalls, 0);

  owner.view = "detail";
  assert.deepEqual(tasksPage.actionHintScope.call(owner), {
    blocked: true,
    targets: [navigatorTarget, detailTarget],
    mutationRoots: [navigatorRoot, detailRoot],
    scrollRoots: [],
  });
  assert.equal(newCalls, 1);
  assert.equal(detailCalls, 1);

  owner.view = "recovery";
  assert.deepEqual(tasksPage.actionHintScope.call(owner), {
    blocked: false,
    targets: [navigatorTarget],
    mutationRoots: [navigatorRoot],
    scrollRoots: [],
  });
  assert.equal(newCalls, 1);
  assert.equal(detailCalls, 1);

  owner.view = "new";
  owner.visible = false;
  assert.deepEqual(
    tasksPage.actionHintScope.call(owner).targets,
    [navigatorTarget],
  );
  assert.equal(newCalls, 1);

  owner.visible = true;
  navigatorOwner.visible = false;
  assert.deepEqual(
    tasksPage.actionHintScope.call(owner).targets,
    [newTarget],
  );
  assert.equal(newCalls, 2);
});

test("composes Scroll surfaces and keyboard contexts only from active owners", () => {
  const navigatorSurface = { id: "task-list" };
  const detailSurface = { id: "conversation" };
  const navigatorContext = { id: "reorder" };
  const modalContext = { id: "current-plan" };
  const newContext = { id: "new-model" };
  const navigator = {
    getClientRects: () => [{}],
    scrollSurfaceScope: () => ({ surfaces: [navigatorSurface] }),
    keyboardNavigationContexts: () => [navigatorContext],
  };
  const detail = {
    getClientRects: () => [{}],
    scrollSurfaceScope: () => ({ surfaces: [detailSurface] }),
    keyboardNavigationContexts: () => [modalContext],
  };
  const owner = {
    view: "detail",
    ensureRendered() {},
    getClientRects: () => [{}],
    taskNavigator: () => navigator,
    taskDetail: () => detail,
    taskNew: () => ({
      keyboardNavigationContexts: () => [newContext],
    }),
  };

  assert.deepEqual(
    tasksPage.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface, detailSurface],
  );
  assert.deepEqual(
    tasksPage.keyboardNavigationContexts.call(owner),
    [navigatorContext, modalContext],
  );
  owner.view = "new";
  assert.deepEqual(
    tasksPage.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface],
  );
  assert.deepEqual(
    tasksPage.keyboardNavigationContexts.call(owner),
    [navigatorContext, newContext],
  );

  owner.getClientRects = () => [];
  assert.deepEqual(
    tasksPage.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface],
  );
  assert.deepEqual(
    tasksPage.keyboardNavigationContexts.call(owner),
    [navigatorContext],
  );
});
