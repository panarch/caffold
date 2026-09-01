import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const detailLayout = registry.element("caffold-detail-layout").prototype;
after(() => registry.restore());

test("merges the view switch with only the active direct-child surface", () => {
  const viewTarget = { id: "view-switch" };
  const taskTarget = { id: "task-composer" };
  const sectionTarget = { id: "section-composer" };
  const reviewTarget = { id: "review" };
  const gitTarget = { id: "git" };
  const githubTarget = { id: "github" };
  const viewRoot = {};
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
    hidden: false,
    ensureRendered() {},
    subjectIdentity() {
      return { kind: this.subjectKind, id: "subject-a" };
    },
    activeSurface() {
      return activeSurface;
    },
    summaryHeader() {
      return {};
    },
    viewSwitch() {
      return {
        actionHintScope(options) {
          assert.equal(options.actionId, "navigation.detail.view");
          return {
            targets: [viewTarget],
            mutationRoots: [viewRoot],
            scrollRoots: [],
          };
        },
      };
    },
    taskDetail() {
      return task;
    },
    sectionDetail() {
      return section;
    },
    review() {
      return { actionHintScope: () => ({ targets: [reviewTarget] }) };
    },
    gitLayout() {
      return { actionHintScope: () => ({ targets: [gitTarget] }) };
    },
    githubLayout() {
      return { actionHintScope: () => ({ targets: [githubTarget] }) };
    },
  };

  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [viewTarget, taskTarget],
    mutationRoots: [viewRoot, taskRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 1);
  assert.equal(sectionScopeCalls, 0);

  task.loading = true;
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: true,
    targets: [viewTarget, taskTarget],
    mutationRoots: [viewRoot, taskRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);

  activeSurface = "review";
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [viewTarget, reviewTarget],
    mutationRoots: [viewRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);

  owner.subjectKind = "section";
  activeSurface = "new";
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [viewTarget, sectionTarget],
    mutationRoots: [viewRoot, sectionRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);
  assert.equal(sectionScopeCalls, 1);

  section.hidden = true;
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [viewTarget],
    mutationRoots: [viewRoot],
    scrollRoots: [],
  });
  assert.equal(sectionScopeCalls, 1);

  activeSurface = "git";
  assert.deepEqual(
    detailLayout.actionHintScope.call(owner).targets,
    [viewTarget, gitTarget],
  );
  activeSurface = "github";
  assert.deepEqual(
    detailLayout.actionHintScope.call(owner).targets,
    [viewTarget, githubTarget],
  );
});

test("delegates Scroll contracts only to the active Task conversation owner", () => {
  const surfaceScope = { surfaces: [{ id: "conversation" }] };
  const modalContext = { id: "current-plan" };
  const task = {
    hidden: false,
    loading: false,
    scrollSurfaceScope: () => surfaceScope,
    scrollContextScopes: () => [modalContext],
  };
  let activeSurface = "conversation";
  const owner = {
    subjectKind: "task",
    hidden: false,
    ensureRendered() {},
    subjectIdentity: () => ({ kind: "task", id: "thread-a" }),
    activeSurface: () => activeSurface,
    taskDetail: () => task,
  };

  assert.equal(detailLayout.scrollSurfaceScope.call(owner), surfaceScope);
  assert.deepEqual(detailLayout.scrollContextScopes.call(owner), [modalContext]);
  activeSurface = "review";
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
  assert.deepEqual(detailLayout.scrollContextScopes.call(owner), []);
  activeSurface = "conversation";
  task.loading = true;
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
  assert.deepEqual(detailLayout.scrollContextScopes.call(owner), []);
});
