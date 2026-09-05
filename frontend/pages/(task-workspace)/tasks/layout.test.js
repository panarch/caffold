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
  const recoveryTarget = { id: "recovery" };
  const navigatorRoot = {};
  const newRoot = {};
  const detailRoot = {};
  const recoveryRoot = {};
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
        hidden: false,
        getClientRects: () => [{}],
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
        hidden: false,
        getClientRects: () => [{}],
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
    taskRecovery: () => ({
      hidden: false,
      getClientRects: () => [{}],
      actionHintScope: () => ({
        targets: [recoveryTarget],
        mutationRoots: [recoveryRoot],
        scrollRoots: [],
      }),
    }),
    codexReadinessRecovery: () => null,
    taskStoreRecoveryVisible: () => false,
    activeDirectSurfaceOwners() {
      return tasksPage.activeDirectSurfaceOwners.call(this);
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
    targets: [navigatorTarget, recoveryTarget],
    mutationRoots: [navigatorRoot, recoveryRoot],
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
  const newSurface = { id: "new-task" };
  const navigatorContext = { id: "reorder" };
  const imageContext = { id: "image-preview" };
  const modalContext = { id: "current-plan" };
  const newContext = { id: "new-model" };
  const navigator = {
    getClientRects: () => [{}],
    scrollSurfaceScope: () => ({ surfaces: [navigatorSurface] }),
    keyboardNavigationContexts: () => [navigatorContext],
  };
  const detail = {
    hidden: false,
    getClientRects: () => [{}],
    scrollSurfaceScope: () => ({ surfaces: [detailSurface] }),
    keyboardNavigationContexts: () => [modalContext],
  };
  const taskNew = {
    hidden: false,
    getClientRects: () => [{}],
    scrollSurfaceScope: () => ({ surfaces: [newSurface] }),
    keyboardNavigationContexts: () => [newContext],
  };
  const owner = {
    view: "detail",
    ensureRendered() {},
    getClientRects: () => [{}],
    taskNavigator: () => navigator,
    taskDetail: () => detail,
    imagePreviewDialog: () => ({
      keyboardNavigationContexts: () => [imageContext],
    }),
    taskNew: () => taskNew,
    taskRecovery: () => null,
    codexReadinessRecovery: () => null,
    taskStoreRecoveryVisible: () => false,
    activeDirectSurfaceOwners() {
      return tasksPage.activeDirectSurfaceOwners.call(this);
    },
  };

  assert.deepEqual(
    tasksPage.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface, detailSurface],
  );
  assert.deepEqual(
    tasksPage.keyboardNavigationContexts.call(owner),
    [navigatorContext, imageContext, modalContext],
  );
  owner.view = "new";
  assert.deepEqual(
    tasksPage.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface, newSurface],
  );
  assert.deepEqual(
    tasksPage.keyboardNavigationContexts.call(owner),
    [navigatorContext, imageContext, newContext],
  );

  owner.getClientRects = () => [];
  assert.deepEqual(
    tasksPage.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface],
  );
  assert.deepEqual(
    tasksPage.keyboardNavigationContexts.call(owner),
    [navigatorContext, imageContext],
  );
});

test("selects takeover or visible page owners and merges setup-beside explicitly", () => {
  const taskNew = { hidden: false };
  const detail = { hidden: false };
  const recovery = { hidden: false };
  const setup = { hidden: false };
  const owner = {
    view: "new",
    takeover: false,
    taskNew: () => taskNew,
    taskDetail: () => detail,
    taskRecovery: () => recovery,
    codexReadinessRecovery: () => setup,
    taskStoreRecoveryVisible() {
      return this.takeover;
    },
  };

  assert.deepEqual(tasksPage.activeDirectSurfaceOwners.call(owner), [taskNew, setup]);
  owner.view = "detail";
  assert.deepEqual(tasksPage.activeDirectSurfaceOwners.call(owner), [detail, setup]);
  owner.view = "recovery";
  assert.deepEqual(tasksPage.activeDirectSurfaceOwners.call(owner), [recovery, setup]);
  owner.takeover = true;
  assert.deepEqual(tasksPage.activeDirectSurfaceOwners.call(owner), [setup]);
  setup.hidden = true;
  assert.deepEqual(tasksPage.activeDirectSurfaceOwners.call(owner), []);
});

test("passes only the selected managed Task to Detail and clears it off-route", () => {
  const task = { threadId: "thread-a", title: "Cached task" };
  const received = [];
  const owner = {
    view: "detail",
    selectedThreadId: "thread-a",
    selectedSectionId: "",
    taskNavigator: () => ({
      taskFor(threadId) {
        return threadId === task.threadId ? task : null;
      },
    }),
    taskDetail: () => ({
      setManagedTask(value) {
        received.push(value);
      },
    }),
  };

  tasksPage.syncSelectedManagedTask.call(owner);
  owner.selectedThreadId = "thread-b";
  tasksPage.syncSelectedManagedTask.call(owner);
  owner.view = "home";
  owner.selectedThreadId = "thread-a";
  tasksPage.syncSelectedManagedTask.call(owner);

  assert.deepEqual(received, [task, null, null]);
});

test("restores managed identity before reopening Detail after a store takeover", () => {
  const calls = [];
  let takeoverChecks = 0;
  const detail = {
    setCodexStatusSnapshot() {},
    open() {
      calls.push("open");
    },
  };
  const owner = {
    codexStatusSnapshotValue: {},
    view: "detail",
    selectedThreadId: "thread-a",
    currentRoute: { kind: "tasks", threadId: "thread-a" },
    ensureRendered() {},
    taskStoreRecoveryVisible() {
      takeoverChecks += 1;
      return takeoverChecks === 1;
    },
    taskNew: () => null,
    taskDetail: () => detail,
    taskNavigator: () => null,
    codexReadinessRecovery: () => null,
    syncSelectedManagedTask() {
      calls.push("managed");
    },
    render() {},
  };

  tasksPage.setCodexStatusSnapshot.call(owner, {});

  assert.deepEqual(calls, ["managed", "open"]);
});
