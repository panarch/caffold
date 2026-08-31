import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const detailLayout = registry.element("caffold-detail-layout").prototype;
after(() => registry.restore());

test("exposes only the active Task or Section direct-child scope", () => {
  const taskTarget = { id: "task-composer" };
  const sectionTarget = { id: "section-composer" };
  const taskRoot = {};
  const sectionRoot = {};
  let activeSurface = "conversation";
  let taskScopeCalls = 0;
  let sectionScopeCalls = 0;
  const task = {
    hidden: false,
    loading: false,
    actionHintScope() {
      taskScopeCalls += 1;
      return {
        targets: [taskTarget],
        mutationRoots: [taskRoot],
        scrollRoots: [],
      };
    },
  };
  const section = {
    hidden: false,
    actionHintScope() {
      sectionScopeCalls += 1;
      return {
        targets: [sectionTarget],
        mutationRoots: [sectionRoot],
        scrollRoots: [],
      };
    },
  };
  const owner = {
    subjectKind: "task",
    ensureRendered() {},
    activeSurface() {
      return activeSurface;
    },
    taskDetail() {
      return task;
    },
    sectionDetail() {
      return section;
    },
  };

  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [taskTarget],
    mutationRoots: [taskRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 1);
  assert.equal(sectionScopeCalls, 0);

  task.loading = true;
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: true,
    targets: [taskTarget],
    mutationRoots: [taskRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);

  activeSurface = "review";
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [],
    mutationRoots: [],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);

  owner.subjectKind = "section";
  activeSurface = "new";
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [sectionTarget],
    mutationRoots: [sectionRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);
  assert.equal(sectionScopeCalls, 1);

  section.hidden = true;
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [],
    mutationRoots: [],
    scrollRoots: [],
  });
  assert.equal(sectionScopeCalls, 1);
});
