import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousMatchMedia = globalThis.matchMedia;
globalThis.document = {
  documentElement: {
    dataset: {},
    style: { colorScheme: "", setProperty() {} },
  },
  querySelector: () => null,
};
globalThis.window = {
  addEventListener() {},
  dispatchEvent() {},
  localStorage: { getItem: () => null, setItem() {} },
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
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
const appShell = registry.element("caffold-app-shell").prototype;

after(() => {
  registry.restore();
  buildInfoHook.deregister();
  restoreGlobal("document", previousDocument);
  restoreGlobal("window", previousWindow);
  restoreGlobal("matchMedia", previousMatchMedia);
});

test("provides bootstrap Retry only while its exact panel is visible", () => {
  const calls = [];
  const control = button("Retry", calls);
  const panel = {
    hidden: false,
    querySelector: () => control,
  };
  const owner = {
    isConnected: true,
    querySelector: () => panel,
  };

  const scope = appShell.bootstrapRetryActionHintScope.call(owner);
  assert.deepEqual(scope.mutationRoots, [panel]);
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => [id, actionId]),
    [["app:bootstrap:retry", "button.activate"]],
  );
  scope.targets[0].activate();
  assert.deepEqual(calls, ["focus:Retry", "click:Retry"]);

  panel.hidden = true;
  assert.equal(scope.targets[0].isActionable(), false);
  const hidden = appShell.bootstrapRetryActionHintScope.call(owner);
  assert.deepEqual(hidden.targets, []);
  assert.deepEqual(hidden.mutationRoots, [panel]);
});

test("provides foreground Retry only for the unavailable presentation", () => {
  const control = button("Retry", []);
  const notice = {
    dataset: { recoveryState: "unavailable" },
    hidden: false,
    querySelector: () => control,
  };
  const owner = {
    isConnected: true,
    querySelector: () => notice,
  };

  const scope = appShell.foregroundRetryActionHintScope.call(owner);
  assert.equal(scope.targets[0].id, "app:foreground-recovery:retry");
  assert.equal(scope.targets[0].isActionable(), true);

  notice.dataset.recoveryState = "offline";
  assert.equal(scope.targets[0].isActionable(), false);
  const offline = appShell.foregroundRetryActionHintScope.call(owner);
  assert.deepEqual(offline.targets, []);
  assert.deepEqual(offline.mutationRoots, [notice]);
});

test("composes one App Shell workspace context with public child contexts", () => {
  const dialog = {};
  const hud = {};
  const selector = {};
  const presentation = {
    actionHintDialog: () => dialog,
    scrollModeHud: () => hud,
    scrollSurfaceSelector: () => selector,
  };
  const taskChild = { id: "task-child" };
  const updateChild = { id: "update-child" };
  const scrollScope = { surfaces: [{ id: "tasks" }] };
  const taskWorkspace = {
    actionHintEditingEscapeTarget: () => "escape-target",
    contains: () => true,
    keyboardNavigationContexts: () => [taskChild],
    scrollSurfaceScope: () => scrollScope,
  };
  const owner = {
    actionHintScope: () => ({ targets: [{ id: "task" }] }),
    keyboardNavigationPresentation: presentation,
    taskWorkspace,
    updateDialog: {
      keyboardNavigationContexts: () => [updateChild],
    },
  };

  const contexts = appShell.keyboardNavigationContexts.call(owner);
  assert.equal(contexts.length, 3);
  assert.equal(contexts[0].id, "workspace");
  assert.equal(contexts[0].kind, "workspace");
  assert.equal(contexts[0].root, owner);
  assert.equal(contexts[0].actionHints.dialog, dialog);
  assert.equal(contexts[0].scroll.hud, hud);
  assert.equal(contexts[0].scroll.selector, selector);
  assert.deepEqual(contexts[0].scroll.scope.surfaces, scrollScope.surfaces);
  assert.equal(contexts[0].editing.escapeTarget({}), "escape-target");
  assert.deepEqual(contexts.slice(1), [updateChild, taskChild]);
});

test("merges only owner-declared Action Hint dependencies", () => {
  const taskRoot = {};
  const taskWorkspace = {
    actionHintScope: () => ({
      blocked: false,
      targets: [{ id: "task" }],
      mutationRoots: [taskRoot],
      scrollRoots: [],
    }),
  };
  const owner = {
    bootstrapRetryActionHintScope: () => ({
      blocked: false,
      targets: [],
      mutationRoots: [],
      scrollRoots: [],
    }),
    foregroundRetryActionHintScope: () => ({
      blocked: false,
      targets: [],
      mutationRoots: [],
      scrollRoots: [],
    }),
    buildMismatchAlert: null,
    taskWorkspace,
  };

  const scope = appShell.actionHintScope.call(owner);
  assert.deepEqual(scope.targets, [{ id: "task" }]);
  assert.deepEqual(scope.mutationRoots, [taskRoot]);
  assert.equal(scope.mutationRoots.includes(taskWorkspace), false);
});

test("cleans keyboard state before route state, URL, and workspace mutations", async () => {
  const calls = [];
  const owner = {
    initialPath: "/workspace",
    keyboardNavigation: {
      routeWillChange: () => calls.push("keyboard-cleanup"),
    },
    set currentRoute(value) {
      calls.push(`route:${value.kind}`);
    },
    setBootstrapError: () => calls.push("bootstrap-clear"),
    taskWorkspace: {
      openRoute: async () => calls.push("workspace-open"),
    },
  };
  globalThis.window.location = {
    origin: "https://caffold.test",
    pathname: "/old",
    search: "",
  };
  globalThis.window.history = {
    replaceState: () => calls.push("history-replace"),
  };

  await appShell.applyRoute.call(owner, { kind: "tasks" });
  assert.deepEqual(calls, [
    "keyboard-cleanup",
    "route:tasks",
    "history-replace",
    "bootstrap-clear",
    "workspace-open",
  ]);
});

function button(label, calls) {
  return {
    disabled: false,
    hidden: false,
    textContent: label,
    getClientRects: () => [{}],
    focus: () => calls.push(`focus:${label}`),
    click: () => calls.push(`click:${label}`),
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
