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
  const owner = {
    view: "new",
    ensureRendered() {},
    taskNavigator() {
      return {
        actionHintScope: () => ({
          targets: [navigatorTarget],
          mutationRoots: [navigatorRoot],
          scrollRoots: [],
        }),
      };
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
});
