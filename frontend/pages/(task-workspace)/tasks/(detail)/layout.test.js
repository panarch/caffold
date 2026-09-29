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
  const terminalTarget = { id: "terminal" };
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
    terminalButton() {
      return null;
    },
    terminalPage() {
      return {
        actionHintScope(options) {
          assert.equal(options.scopeId, `detail:${owner.subjectKind}:subject-a`);
          return { targets: [terminalTarget] };
        },
      };
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
  activeSurface = "terminal";
  assert.deepEqual(
    detailLayout.actionHintScope.call(owner).targets,
    [viewTarget, terminalTarget],
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
    terminalPage: () => ({ deactivate: () => calls.push("terminal") }),
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
    "terminal",
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
    cwdPath: "canonical-worktree",
    worktree: { rootPath: "canonical-worktree" },
  };
  const summaries = [];
  const terminalButtons = [];
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
    terminalButton: () => ({
      setSnapshot: (snapshot) => terminalButtons.push(snapshot),
    }),
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
  // The terminal starts where the loaded Task works, so it waits for that.
  assert.deepEqual(terminalButtons, [
    { available: false, pressed: false },
    { available: true, pressed: false },
  ]);
});

test("the terminal toggle enters from any screen and returns to where it was", () => {
  const requested = [];
  const activations = [];
  let surface = "review";
  const reviewRoute = {
    kind: "tasks",
    threadId: "thread-a",
    review: true,
    reviewScope: "branch",
  };
  const owner = terminalOwner({
    subjectKind: "task",
    taskRoute: reviewRoute,
    taskSnapshot: { task: { threadId: "thread-a", cwdPath: "projects/app" } },
    activeSurface: () => surface,
    terminalPage: () => ({ activate: (options) => activations.push(options) }),
    requestSubjectRoute: (route) => requested.push(route),
  });

  assert.equal(detailLayout.toggleTerminal.call(owner), true);
  assert.deepEqual(requested.at(-1), {
    kind: "tasks",
    threadId: "thread-a",
    terminal: true,
  });
  assert.equal(owner.pendingTerminalTake, "task:thread-a");

  // The terminal screen returns without asking for the terminal, whatever its
  // connection shows.
  surface = "terminal";
  assert.equal(detailLayout.toggleTerminal.call(owner), true);
  assert.deepEqual(requested.at(-1), reviewRoute);
  assert.deepEqual(activations, []);

  // Entered directly by a link, it returns to the Task's conversation.
  assert.equal(detailLayout.toggleTerminal.call(owner), true);
  assert.deepEqual(requested.at(-1), { kind: "tasks", threadId: "thread-a" });

  owner.taskSnapshot = { task: { threadId: "thread-a", cwdPath: "" } };
  assert.equal(detailLayout.toggleTerminal.call(owner), false);
});

test("a terminal that ended takes Detail back to where it was, only from its screen", () => {
  const requested = [];
  let surface = "terminal";
  const owner = terminalOwner({
    subjectKind: "task",
    taskSnapshot: { task: { threadId: "thread-a", cwdPath: "projects/app" } },
    activeSurface: () => surface,
    requestSubjectRoute: (route) => requested.push(route),
  });
  const reviewRoute = { kind: "tasks", threadId: "thread-a", review: true };
  owner.terminalReturnRoutes.set("task:thread-a", reviewRoute);

  detailLayout.leaveTerminal.call(owner);
  detailLayout.leaveTerminal.call(owner);
  surface = "review";
  detailLayout.leaveTerminal.call(owner);

  assert.deepEqual(requested, [
    reviewRoute,
    { kind: "tasks", threadId: "thread-a" },
  ]);
});

test("a Section's terminal toggle returns to its New Task screen", () => {
  const requested = [];
  let surface = "new";
  const owner = terminalOwner({
    subjectKind: "section",
    section: { id: "section-1", name: "notes" },
    sectionRoute: { sectionId: "section-1", sectionSurface: "new" },
    activeSurface: () => surface,
    requestSubjectRoute: (route) => requested.push(route),
  });

  detailLayout.toggleTerminal.call(owner);
  surface = "terminal";
  owner.terminalReturnRoutes.clear();
  detailLayout.toggleTerminal.call(owner);

  assert.deepEqual(requested, [
    { sectionId: "section-1", sectionSurface: "terminal" },
    { sectionId: "section-1" },
  ]);
});

test("the terminal opens with take only right after the toggle asked for it", () => {
  const activations = [];
  const owner = terminalOwner({
    subjectKind: "task",
    taskSnapshot: { task: { threadId: "thread-a", cwdPath: "projects/app" } },
    terminalPage: () => ({ activate: (options) => activations.push(options.mode) }),
  });

  owner.pendingTerminalTake = "task:thread-a";
  detailLayout.activateTerminal.call(owner);
  detailLayout.activateTerminal.call(owner);
  owner.pendingTerminalTake = "task:thread-a";
  detailLayout.keepTerminalTakeFor.call(owner, "task:thread-a");
  detailLayout.activateTerminal.call(owner);
  owner.pendingTerminalTake = "task:thread-a";
  detailLayout.keepTerminalTakeFor.call(owner, "");
  detailLayout.activateTerminal.call(owner);

  assert.deepEqual(activations, ["take", "resume", "take", "resume"]);
});

test("a lost terminal socket reports the Detail transport as unavailable", () => {
  let surface = "terminal";
  let terminal = "ready";
  const owner = {
    subjectKind: "task",
    activeSurface: () => surface,
    terminalPage: () => ({ transportState: terminal }),
    taskDetail: () => ({ streamState: "reconnecting" }),
  };
  const streamState = () =>
    Object.getOwnPropertyDescriptor(detailLayout, "streamState").get.call(owner);

  assert.equal(streamState(), "reconnecting");
  terminal = "unavailable";
  assert.equal(streamState(), "unavailable");
  owner.subjectKind = "section";
  terminal = "ready";
  assert.equal(streamState(), "ready");
  surface = "new";
  assert.equal(streamState(), "inactive");
});

function terminalOwner(fields) {
  const owner = {
    hidden: false,
    terminalReturnRoutes: new Map(),
    pendingTerminalTake: "",
    ensureRendered() {},
    subjectIdentity: detailLayout.subjectIdentity,
    terminalDirectory: detailLayout.terminalDirectory,
    subjectHomeRoute: detailLayout.subjectHomeRoute,
    leaveTerminal: detailLayout.leaveTerminal,
    ...fields,
  };
  return owner;
}
