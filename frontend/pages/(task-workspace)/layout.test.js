import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import { parseRoute } from "../../navigation-routes.js";
import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const buildInfoHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("build-info.js")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const BUILD_INFO={id:'test',version:'test',number:0}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const workspace = registry.element("caffold-task-workspace").prototype;
after(() => {
  registry.restore();
  buildInfoHook.deregister();
});

test("keeps the visible Task navigator scope when the detail-side Tasks host is hidden", () => {
  const navigatorSurface = { id: "task-list" };
  let calls = 0;
  const tasksPage = {
    getClientRects: () => [],
    scrollSurfaceScope() {
      calls += 1;
      return { surfaces: [navigatorSurface] };
    },
  };
  const owner = {
    hidden: false,
    mode: "tasks",
    tasksPage,
  };

  assert.deepEqual(
    workspace.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface],
  );
  assert.equal(calls, 1);

  owner.hidden = true;
  assert.deepEqual(
    workspace.scrollSurfaceScope.call(owner).surfaces,
    [],
  );
  assert.equal(calls, 1);
});

test("composes the navigation pane resizer through its public scope", () => {
  let options = null;
  const masterResizer = {
    getClientRects: () => [{}],
    actionHintScope(input) {
      options = input;
      return { targets: [{ id: "separator" }] };
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    mode: "tasks",
    masterResizer,
    masterDetail: {},
    masterPane: null,
    backButton: null,
    navigation: null,
    tasksPage: null,
    querySelector: () => null,
  };

  assert.deepEqual(workspace.actionHintScope.call(owner).targets, [
    { id: "separator" },
  ]);
  assert.equal(options.scopeId, "workspace:navigation-pane");
  assert.equal(options.actionId, "control.separator.focus");
  assert.deepEqual(options.clipRoots, [owner, owner.masterDetail]);
  assert.equal(options.isCurrent(), true);
  owner.masterResizer = { getClientRects: () => [{}] };
  assert.equal(options.isCurrent(), false);
});

test("offers the visible compact Back as the workspace parent action", () => {
  const backButton = {
    hidden: false,
    disabled: false,
    getClientRects: () => [{}],
    getAttribute: (name) => (name === "aria-label" ? "Back to tasks" : null),
  };
  const owner = {
    hidden: false,
    isConnected: true,
    mode: "tasks",
    backButton,
    masterResizer: null,
    masterDetail: {},
    masterPane: null,
    navigation: null,
    tasksPage: null,
    querySelector: () => null,
  };

  const [target, ...others] = workspace.actionHintScope.call(owner).targets;
  assert.deepEqual(others, []);
  assert.equal(target.id, "workspace:parent:tasks");
  assert.equal(target.actionId, "navigation.parent");
  assert.equal(target.label, "Back to tasks");
  assert.equal(target.control, backButton);
  assert.equal(target.isActionable(), true);

  backButton.hidden = true;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(workspace.actionHintScope.call(owner).targets, []);
});

test("shows the compact Back on Task, Section, and New Task roots only", (t) => {
  globalThis.window = { location: { origin: "http://caffold.test" } };
  t.after(() => {
    delete globalThis.window;
  });
  const backVisible = (url) => {
    const route = parseRoute(url);
    const attributes = new Map();
    const owner = {
      backButton: { hidden: true },
      route,
      mode: route.kind === "settings" ? "settings" : "tasks",
      dataset: {},
      navigation: { setMode() {} },
      renderIcons() {},
      syncPresentationState() {},
      toggleAttribute(name, force) {
        attributes.set(name, force);
      },
    };
    workspace.updateChrome.call(owner);
    assert.equal(
      attributes.get("data-workspace-route-control-visible"),
      !owner.backButton.hidden,
      url,
    );
    return !owner.backButton.hidden;
  };

  for (const url of [
    "/tasks/new",
    "/tasks/thread",
    "/tasks/thread/recovery",
    "/tasks/thread/review",
    "/tasks/thread/git/compare",
    "/tasks/thread/git/log",
    "/tasks/thread/github/issues",
    "/tasks/thread/github/pulls",
    "/?section=repo-1",
    "/?section=repo-1&surface=review",
    "/?section=repo-1&surface=git&tool=compare",
    "/?section=repo-1&surface=git&tool=log",
    "/?section=repo-1&surface=github&tool=issues",
    "/?section=repo-1&surface=github&tool=pulls",
  ]) {
    assert.equal(backVisible(url), true, url);
  }
  for (const url of [
    "/",
    "/settings",
    "/tasks/thread/review?file=src%2Flib.rs",
    "/tasks/thread/git/compare?file=src%2Flib.rs",
    "/tasks/thread/git/log?sha=abcdef",
    "/tasks/thread/github/issues/42",
    "/tasks/thread/github/pulls/12/files",
    "/?section=repo-1&surface=review&file=src%2Flib.rs",
    "/?section=repo-1&surface=git&tool=compare&file=src%2Flib.rs",
    "/?section=repo-1&surface=git&tool=log&sha=abcdef",
    "/?section=repo-1&surface=github&tool=issues&number=42",
    "/?section=repo-1&surface=github&tool=pulls&number=12&files=true",
  ]) {
    assert.equal(backVisible(url), false, url);
  }
});

test("composes the keyboard contexts of the shown workspace mode", () => {
  const tasksContext = { id: "tasks" };
  const notesContext = { id: "notes" };
  const owner = {
    hidden: false,
    mode: "notes",
    ensureRendered() {},
    tasksPage: { keyboardNavigationContexts: () => [tasksContext] },
    notesWorkspace: { keyboardNavigationContexts: () => [notesContext] },
  };

  assert.deepEqual(workspace.keyboardNavigationContexts.call(owner), [notesContext]);
  owner.mode = "tasks";
  assert.deepEqual(workspace.keyboardNavigationContexts.call(owner), [tasksContext]);
  owner.mode = "settings";
  assert.deepEqual(workspace.keyboardNavigationContexts.call(owner), []);
  owner.mode = "notes";
  owner.hidden = true;
  assert.deepEqual(workspace.keyboardNavigationContexts.call(owner), []);
});

test("hands the Task switcher the navigator's own active Task snapshot", () => {
  const snapshot = {
    rows: [{ task: { threadId: "one" }, sectionName: "caffold" }],
    loaded: true,
  };
  let opened = null;
  const owner = {
    hidden: false,
    mode: "tasks",
    ensureRendered() {},
    taskNavigator: { activeTaskSnapshot: () => snapshot },
    taskSwitcherDialog: {
      open(given) {
        opened = given;
        return true;
      },
    },
  };

  assert.equal(workspace.openTaskSwitcher.call(owner), true);
  assert.equal(opened, snapshot);

  for (const refusal of [
    { hidden: true },
    { mode: "notes" },
    { mode: "settings" },
  ]) {
    Object.assign(owner, { hidden: false, mode: "tasks" }, refusal);
    opened = null;
    assert.equal(workspace.openTaskSwitcher.call(owner), false);
    assert.equal(opened, null);
  }
});

test("turns a switched Task into one route request and one focus handoff", () => {
  const requested = [];
  const focused = [];
  const owner = {
    dispatchEvent: (event) => requested.push(event),
    focusOpenedTask: (threadId, control) => focused.push([threadId, control]),
  };

  workspace.openSwitchedTask.call(owner, { threadId: "one" });
  workspace.openSwitchedTask.call(owner, {
    threadId: "two",
    recovery: true,
  });
  workspace.openSwitchedTask.call(owner, { threadId: "" });
  workspace.openSwitchedTask.call(owner);

  assert.deepEqual(requested.map(({ detail }) => detail.route), [
    { kind: "tasks", threadId: "one" },
    { kind: "tasks", threadId: "two", recovery: true },
  ]);
  assert.deepEqual(focused, [["one", undefined], ["two", undefined]]);
});

test("sends focus to the Task itself when no visible control opened it", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    let destinations = 0;
    const owner = {
      isConnected: true,
      mode: "tasks",
      route: { kind: "tasks", threadId: "one" },
      tasksPage: {
        focusActionHintDestination() {
          destinations += 1;
        },
      },
    };
    const queued = [];
    const previousQueue = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (callback) => queued.push(callback);
    try {
      workspace.focusOpenedTask.call(owner, "one");
      workspace.focusOpenedTask.call(owner, "other");
      for (const callback of queued) {
        callback();
      }
    } finally {
      globalThis.queueMicrotask = previousQueue;
    }

    assert.equal(destinations, 1);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
