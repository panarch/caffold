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
    gitMenu() {
      return null;
    },
    githubMenu() {
      return null;
    },
    taskSummary() {
      return null;
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

test("delegates Scroll and keyboard contexts only to the active direct owner", () => {
  const surfaceScope = { surfaces: [{ id: "conversation" }] };
  const modalContext = { id: "current-plan" };
  const task = {
    hidden: false,
    loading: false,
    scrollSurfaceScope: () => surfaceScope,
    keyboardNavigationContexts: () => [modalContext],
  };
  let activeSurface = "conversation";
  const owner = {
    subjectKind: "task",
    hidden: false,
    ensureRendered() {},
    subjectIdentity: () => ({ kind: "task", id: "thread-a" }),
    activeSurface: () => activeSurface,
    taskDetail: () => task,
    gitMenu: () => null,
    githubMenu: () => null,
    taskSummary: () => null,
    review: () => null,
    gitLayout: () => null,
    githubLayout: () => null,
  };

  assert.equal(detailLayout.scrollSurfaceScope.call(owner), surfaceScope);
  assert.deepEqual(detailLayout.keyboardNavigationContexts.call(owner), [modalContext]);
  activeSurface = "review";
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
  assert.deepEqual(detailLayout.keyboardNavigationContexts.call(owner), []);
  activeSurface = "conversation";
  task.loading = true;
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
  assert.deepEqual(detailLayout.keyboardNavigationContexts.call(owner), []);
});

test("deactivation closes the persistent Task summary interaction owner", () => {
  const calls = [];
  const owner = {
    taskSummary: () => ({ deactivate: () => calls.push("summary") }),
    deactivateReview: () => calls.push("review"),
    gitLayout: () => ({ deactivate: () => calls.push("git") }),
    githubLayout: () => ({ deactivate: () => calls.push("github") }),
    gitMenu: () => ({ deactivate: () => calls.push("git-menu") }),
    githubMenu: () => ({ deactivate: () => calls.push("github-menu") }),
    sectionActivationKey: "section",
    domainActivationPromise: Promise.resolve(),
  };

  detailLayout.deactivateSharedChildren.call(owner);

  assert.deepEqual(calls, [
    "summary",
    "review",
    "git",
    "github",
    "git-menu",
    "github-menu",
  ]);
  assert.equal(owner.sectionActivationKey, "");
  assert.equal(owner.domainActivationPromise, null);
});

test("delegates Scroll to each exact active Detail domain", () => {
  const surfaces = Object.fromEntries(
    ["review", "git", "github"].map((name) => [name, { id: name }]),
  );
  let activeSurface = "review";
  const owner = {
    subjectKind: "task",
    hidden: false,
    subjectIdentity: () => ({ kind: "task", id: "thread-a" }),
    activeSurface: () => activeSurface,
    ensureRendered() {},
    taskDetail: () => null,
    review: () => ({ scrollSurfaceScope: () => ({ surfaces: [surfaces.review] }) }),
    gitLayout: () => ({ scrollSurfaceScope: () => ({ surfaces: [surfaces.git] }) }),
    githubLayout: () => ({ scrollSurfaceScope: () => ({ surfaces: [surfaces.github] }) }),
  };
  for (const domain of ["review", "git", "github"]) {
    activeSurface = domain;
    assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, [surfaces[domain]]);
  }
  owner.hidden = true;
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
});

test("uses managed identity only as a header fallback and prefers canonical Detail", () => {
  const managed = {
    threadId: "thread-a",
    title: "Cached title",
    threadStatus: { type: "active", activeFlags: [] },
    worktree: { rootPath: "cached-worktree" },
  };
  const canonical = {
    ...managed,
    title: "Canonical title",
    worktree: { rootPath: "canonical-worktree" },
  };
  const summaries = [];
  const headers = [];
  const choices = [];
  const viewHidden = [];
  const visibleSurfaces = [];
  const owner = {
    subjectKind: "task",
    taskRoute: { threadId: "thread-a", review: true },
    taskSnapshot: {
      task: null,
      transportState: "unavailable",
      archiveState: { loading: false, error: null },
      forkState: { loading: false, error: null },
    },
    managedTask: managed,
    streamState: "unavailable",
    summaryHeader: () => ({
      toggleAttribute(name, hidden) {
        headers.push({ name, hidden });
      },
    }),
    rebindSharedDomainContext() {},
    activeSurface: () => "review",
    taskSummary: () => ({ setSnapshot: (snapshot) => summaries.push(snapshot) }),
    viewSwitch: () => ({
      setSnapshot(snapshot) {
        choices.push(snapshot.choices.map(({ value }) => value));
      },
      toggleAttribute(name, hidden) {
        assert.equal(name, "hidden");
        viewHidden.push(hidden);
      },
    }),
    gitMenu: () => ({ setSnapshot() {} }),
    githubMenu: () => ({ setSnapshot() {} }),
    applySurfaceVisibility(surface) {
      visibleSurfaces.push(surface);
    },
    selectedTaskContextPath: () => "",
    taskDetail: () => ({ reconcileVisibleSurface() {} }),
  };

  detailLayout.syncTaskPresentation.call(owner);
  owner.taskSnapshot = { ...owner.taskSnapshot, task: canonical };
  detailLayout.syncTaskPresentation.call(owner);

  assert.equal(headers[0].hidden, false);
  assert.equal(summaries[0].task, managed);
  assert.equal(summaries[0].canonicalTaskAvailable, false);
  assert.equal(summaries[0].archiveBlockedByActive, false);
  assert.deepEqual(choices[0], ["conversation", "review"]);
  assert.equal(viewHidden[0], true);
  assert.equal(visibleSurfaces[0], "conversation");
  assert.equal(summaries[1].task, canonical);
  assert.equal(summaries[1].canonicalTaskAvailable, true);
  assert.equal(summaries[1].archiveBlockedByActive, true);
  assert.deepEqual(choices[1], ["conversation", "working", "branch"]);
  assert.equal(viewHidden[1], false);
  assert.equal(visibleSurfaces[1], "review");
});
