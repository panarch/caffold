import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.ts");
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
  let surface = "conversation";
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
    performUpdate() {},
    subjectIdentity() {
      return { kind: this.subjectKind, id: "subject-a" };
    },
    presentedSurface() {
      return surface;
    },
    summaryHeader: { value: {} },
    gitMenu: { value: null },
    githubMenu: { value: null },
    taskSummary: { value: null },
    viewSwitch: { value: {
        actionHintScope(options) {
          assert.equal(options.actionId, "navigation.detail.view");
          return {
            targets: [viewTarget],
            mutationRoots: [viewRoot],
            scrollRoots: [],
          };
        },
      } },
    taskDetail: { value: task },
    sectionDetail: { value: section },
    review() {
      return { actionHintScope: () => ({ targets: [reviewTarget] }) };
    },
    gitLayout() {
      return { actionHintScope: () => ({ targets: [gitTarget] }) };
    },
    githubLayout() {
      return { actionHintScope: () => ({ targets: [githubTarget] }) };
    },
    terminalButton: { value: null },
    terminalPage: { value: {
        actionHintScope(options) {
          assert.equal(options.scopeId, `detail:${owner.subjectKind}:subject-a`);
          return { targets: [terminalTarget] };
        },
      } },
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

  surface = "review";
  assert.deepEqual(detailLayout.actionHintScope.call(owner), {
    blocked: false,
    targets: [viewTarget, reviewTarget],
    mutationRoots: [viewRoot],
    scrollRoots: [],
  });
  assert.equal(taskScopeCalls, 2);

  owner.subjectKind = "section";
  surface = "new";
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

  surface = "git";
  assert.deepEqual(
    detailLayout.actionHintScope.call(owner).targets,
    [viewTarget, gitTarget],
  );
  surface = "github";
  assert.deepEqual(
    detailLayout.actionHintScope.call(owner).targets,
    [viewTarget, githubTarget],
  );
  surface = "terminal";
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
  let surface = "conversation";
  const owner = {
    subjectKind: "task",
    hidden: false,
    performUpdate() {},
    subjectIdentity: () => ({ kind: "task", id: "thread-a" }),
    presentedSurface: () => surface,
    taskDetail: { value: task },
    gitMenu: { value: null },
    githubMenu: { value: null },
    taskSummary: { value: null },
    review: () => null,
    gitLayout: () => null,
    githubLayout: () => null,
  };

  assert.equal(detailLayout.scrollSurfaceScope.call(owner), surfaceScope);
  assert.deepEqual(detailLayout.keyboardNavigationContexts.call(owner), [modalContext]);
  surface = "review";
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
  assert.deepEqual(detailLayout.keyboardNavigationContexts.call(owner), []);
  surface = "conversation";
  task.loading = true;
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
  assert.deepEqual(detailLayout.keyboardNavigationContexts.call(owner), []);
});

test("deactivation closes the persistent Task summary interaction owner", () => {
  const calls = [];
  const owner = {
    taskSummary: { value: { deactivate: () => calls.push("summary") } },
    terminalPage: { value: { deactivate: () => calls.push("terminal") } },
    deactivateReview: () => calls.push("review"),
    gitLayout: () => ({ deactivate: () => calls.push("git") }),
    githubLayout: () => ({ deactivate: () => calls.push("github") }),
    gitMenu: { value: { deactivate: () => calls.push("git-menu") } },
    githubMenu: { value: { deactivate: () => calls.push("github-menu") } },
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
  let surface = "review";
  const owner = {
    subjectKind: "task",
    hidden: false,
    subjectIdentity: () => ({ kind: "task", id: "thread-a" }),
    presentedSurface: () => surface,
    performUpdate() {},
    taskDetail: { value: null },
    review: () => ({ scrollSurfaceScope: () => ({ surfaces: [surfaces.review] }) }),
    gitLayout: () => ({ scrollSurfaceScope: () => ({ surfaces: [surfaces.git] }) }),
    githubLayout: () => ({ scrollSurfaceScope: () => ({ surfaces: [surfaces.github] }) }),
  };
  for (const domain of ["review", "git", "github"]) {
    surface = domain;
    assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, [surfaces[domain]]);
  }
  owner.hidden = true;
  assert.deepEqual(detailLayout.scrollSurfaceScope.call(owner).surfaces, []);
});

// A Task Detail owner whose header draws into `menus` and `flags`: the
// hidden flags each draw sets, and the snapshots its children get.
function headerOwner(state, { menus = [], flags = [], summaries = [], choices = [], terminalButtons = [], selected = [] } = {}) {
  const owner = Object.create(detailLayout, Object.getOwnPropertyDescriptors({
    subjectKind: "task",
    section: null,
    managedTask: null,
    managedTaskRepository: false,
    sectionRoute: null,
    streamState: "ready",
    rebindSharedDomainContext() {},
    activeSurface: () => "conversation",
    draw() {
      const markup = templateHtml(this.render()).replace(/\s+/g, " ");
      const hidden = (pattern) => markup.match(pattern)?.[1] === "true";
      flags.push({
        header: hidden(/task-detail-summary" \?hidden="(\w+)"/),
        viewSwitch: hidden(/data-detail-view-switch \?hidden="(\w+)"/),
      });
      menus.push(["git", "hidden", hidden(/<caffold-task-detail-git \?hidden="(\w+)"/)]);
      menus.push(["github", "hidden", hidden(/<caffold-task-detail-github \?hidden="(\w+)"/)]);
    },
    taskSummary: { value: { setSnapshot: (snapshot) => summaries.push(snapshot) } },
    viewSwitch: { value: ({
      setSnapshot(snapshot) {
        choices.push(snapshot.choices.map(({ value }) => value));
        selected.push(snapshot.selected);
        assert.ok(snapshot.choices.some(({ value }) => value === snapshot.selected));
      },
    }) },
    gitMenu: { value: repositoryMenu("git", menus) },
    githubMenu: { value: repositoryMenu("github", menus) },
    terminalButton: { value: ({
      setSnapshot: (snapshot) => terminalButtons.push(snapshot),
    }) },
    applySurfaceVisibility() {},
    selectedTaskContextPath: () => "",
    taskDetail: { value: { reconcileVisibleSurface() {} } },
    ...state,
  }));
  return owner;
}

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
  const flags = [];
  const choices = [];
  const menus = [];
  const visibleSurfaces = [];
  const owner = headerOwner({
    taskRoute: { threadId: "thread-a", review: true },
    taskSnapshot: {
      task: null,
      transportState: "unavailable",
      archiveState: { loading: false, error: null },
      forkState: { loading: false, error: null },
    },
    managedTask: managed,
    managedTaskRepository: true,
    streamState: "unavailable",
    activeSurface: () => "review",
    applySurfaceVisibility(surface) {
      visibleSurfaces.push(surface);
    },
  }, { menus, flags, summaries, choices, terminalButtons });

  detailLayout.syncTaskPresentation.call(owner);
  owner.taskSnapshot = { ...owner.taskSnapshot, task: canonical };
  detailLayout.syncTaskPresentation.call(owner);

  // The listed Section shows Git and GitHub before the details make them
  // usable.
  assert.deepEqual(menus, [
    ["git", "hidden", false],
    ["github", "hidden", false],
    ["git", "available", false],
    ["github", "available", false],
    ["git", "hidden", false],
    ["github", "hidden", false],
    ["git", "available", true],
    ["github", "available", true],
  ]);

  assert.equal(flags[0].header, false);
  assert.equal(summaries[0].task, managed);
  assert.equal(summaries[0].canonicalTaskAvailable, false);
  assert.equal(summaries[0].archiveBlockedByActive, false);
  assert.deepEqual(choices[0], ["conversation", "review"]);
  assert.equal(flags[0].viewSwitch, true);
  assert.equal(visibleSurfaces[0], "conversation");
  assert.equal(summaries[1].task, canonical);
  assert.equal(summaries[1].canonicalTaskAvailable, true);
  assert.equal(summaries[1].archiveBlockedByActive, true);
  assert.deepEqual(choices[1], ["conversation", "working", "branch"]);
  assert.equal(flags[1].viewSwitch, false);
  assert.equal(visibleSurfaces[1], "review");
  // The terminal starts where the loaded Task works, so it waits for that.
  assert.deepEqual(terminalButtons, [
    { available: false, pressed: false },
    { available: true, pressed: false },
  ]);
});

test("keeps Git and GitHub out of a Task header outside Git from the start", () => {
  const managed = { threadId: "thread-a", title: "Notes" };
  const menus = [];
  const owner = headerOwner({
    taskRoute: { threadId: "thread-a" },
    taskSnapshot: { task: null },
    managedTask: managed,
    managedTaskRepository: false,
  }, { menus });

  detailLayout.syncTaskPresentation.call(owner);
  owner.taskSnapshot = { task: { ...managed, cwdPath: "Documents/notes", worktree: null } };
  detailLayout.syncTaskPresentation.call(owner);
  // Another Task's listed Section says nothing about the Task now opening.
  owner.taskRoute = { threadId: "thread-b" };
  owner.managedTaskRepository = true;
  detailLayout.syncTaskPresentation.call(owner);

  assert.deepEqual(
    menus.filter(([name]) => name === "git"),
    [
      ["git", "hidden", true],
      ["git", "available", false],
      ["git", "hidden", true],
      ["git", "available", false],
      ["git", "hidden", true],
      ["git", "available", false],
    ],
  );
});

test("selects the view switch choice that names the Review a Task shows", () => {
  const selected = [];
  const owner = headerOwner({
    taskRoute: { threadId: "thread-a", review: true },
    taskSnapshot: {
      task: { threadId: "thread-a", cwdPath: "Documents/notes", worktree: null },
    },
    activeSurface: () => "review",
  }, { selected });

  detailLayout.syncTaskPresentation.call(owner);
  owner.taskSnapshot = {
    task: { threadId: "thread-a", cwdPath: "app", worktree: { rootPath: "app" } },
  };
  detailLayout.syncTaskPresentation.call(owner);
  owner.taskRoute = { ...owner.taskRoute, reviewScope: "branch" };
  detailLayout.syncTaskPresentation.call(owner);

  assert.deepEqual(selected, ["review", "working", "branch"]);
});

function repositoryMenu(name, calls) {
  return {
    setSnapshot({ available }) {
      calls.push([name, "available", available]);
    },
  };
}

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
    terminalPage: { value: { activate: (options) => activations.push(options) } },
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
    terminalPage: { value: { activate: (options) => activations.push(options.mode) } },
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
    presentedSurface: () => surface,
    terminalPage: {
      get value() {
        return { transportState: terminal };
      },
    },
    taskDetail: { value: { streamState: "reconnecting" } },
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
    performUpdate() {},
    subjectIdentity: detailLayout.subjectIdentity,
    terminalDirectory: detailLayout.terminalDirectory,
    subjectHomeRoute: detailLayout.subjectHomeRoute,
    leaveTerminal: detailLayout.leaveTerminal,
    ...fields,
  };
  return owner;
}
