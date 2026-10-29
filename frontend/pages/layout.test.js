import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";
import { NavigationHistory } from "./navigation-history.js";

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
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");

after(() => {
  registry.restore();
  buildInfoHook.deregister();
  restoreGlobal("document", previousDocument);
  restoreGlobal("window", previousWindow);
  restoreGlobal("matchMedia", previousMatchMedia);
});

test("About and bootstrap share health requests and expose failure before retry", async (t) => {
  const prior = globalThis.window;
  globalThis.window = { location: { origin: "http://caffold.test" }, setTimeout, clearTimeout };
  t.after(() => { globalThis.window = prior; });
  const requests = [];
  const health = { build: { id: "current" } };
  t.mock.method(globalThis, "fetch", () => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const published = [];
  const owner = Object.create(appShell, Object.getOwnPropertyDescriptors({
    healthRequest: null,
    updateBuildStatus: value => published.push(value),
    refreshCaffoldUpdate: async () => {},
  }));
  const bootstrap = owner.readBuildHealth();
  const about = owner.refreshAboutStatus();
  assert.equal(requests.length, 1);
  requests[0].resolve(Response.json(health));
  await Promise.all([bootstrap, about]);
  assert.deepEqual(published, [health]);
  const failed = owner.refreshAboutStatus();
  requests[1].reject(new Error("offline"));
  await assert.rejects(failed, /offline/);
  assert.equal(published.at(-1), null);
  const retry = owner.refreshAboutStatus();
  requests[2].resolve(Response.json(health));
  await retry;
  assert.deepEqual(published.at(-1), health);
});

test("composes one App Shell workspace context with public child contexts", () => {
  const presentation = {};
  const taskChild = { id: "task-child" };
  const updateChild = { id: "update-child" };
  const shortcutChild = { id: "shortcut-child" };
  const scrollScope = { surfaces: [{ id: "tasks" }] };
  const taskWorkspace = {
    actionHintEditingEscapeTarget: () => "escape-target",
    contains: () => true,
    keyboardNavigationContexts: () => [taskChild],
    scrollSurfaceScope: () => scrollScope,
  };
  const owner = Object.create(appShell, Object.getOwnPropertyDescriptors({
    actionHintScope: () => ({ targets: [{ id: "task" }] }),
    taskWorkspace,
    updateDialog: {
      value: { keyboardNavigationContexts: () => [updateChild] },
    },
    updateResultDialog: { value: { keyboardNavigationContexts: () => [] } },
    keyboardShortcutDialog: {
      value: { keyboardNavigationContexts: () => [shortcutChild] },
    },
  }));
  owner.keyboard = new KeyboardContexts(owner);
  owner.keyboard.presentations.add({}, {
    element: Object.assign(presentation, { parentElement: null }),
    value: null,
  });

  const contexts = appShell.keyboardNavigationContexts.call(owner);
  assert.equal(contexts.length, 4);
  assert.equal(contexts[0].id, "workspace");
  assert.equal(contexts[0].kind, "workspace");
  assert.equal(contexts[0].root, owner);
  assert.equal(contexts[0].presentation, presentation);
  assert.deepEqual(
    contexts[0].actionHints.targets.map(({ id }) => id),
    ["task"],
  );
  assert.deepEqual(contexts[0].scroll.surfaces, scrollScope.surfaces);
  assert.equal(contexts[0].editing.escapeTarget({}), "escape-target");
  assert.deepEqual(contexts.slice(1), [updateChild, shortcutChild, taskChild]);
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
  const panel = {};
  const owner = {
    hints: {
      scope: () => ({
        blocked: false,
        targets: [],
        mutationRoots: [panel],
        scrollRoots: [],
      }),
    },
    buildMismatchAlert: { value: undefined },
    taskWorkspace,
  };

  const scope = appShell.actionHintScope.call(owner);
  assert.deepEqual(scope.targets, [{ id: "task" }]);
  assert.deepEqual(scope.mutationRoots, [panel, taskRoot]);
  assert.equal(scope.mutationRoots.includes(taskWorkspace), false);
});

test("cleans keyboard state before route state, URL, and workspace mutations", async () => {
  const calls = [];
  const owner = {
    initialPath: "/workspace",
    keyboardNavigation: {
      routeWillChange: () => calls.push("keyboard-cleanup"),
    },
    navigationHistory: new NavigationHistory(),
    usesNavigationApi: false,
    writeEntryChain: appShell.writeEntryChain,
    writeHistoryEntry: appShell.writeHistoryEntry,
    set currentRoute(value) {
      calls.push(`route:${value.kind}`);
    },
    get currentRoute() {
      return null;
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

// A notification arrives from outside, so its Task opens over the screens it
// sits under and Back reaches the Task list rather than what was interrupted.
for (const [label, currentRoute, expected] of [
  [
    "keeps the Task list it opens over",
    { kind: "tasks" },
    ["history-push:/tasks/thread-1", "workspace-open", "update-status"],
  ],
  [
    "puts the Task list under the screen it interrupts",
    { kind: "settings", section: "appearance" },
    [
      "history-push:/",
      "history-push:/tasks/thread-1",
      "workspace-open",
      "update-status",
    ],
  ],
]) {
  test(`a notification route ${label}`, async () => {
    const calls = [];
    const owner = {
      applyRoute: appShell.applyRoute,
      currentRoute,
      initialPath: "",
      navigationHistory: new NavigationHistory(),
      usesNavigationApi: false,
      writeEntryChain: appShell.writeEntryChain,
      writeHistoryEntry: appShell.writeHistoryEntry,
      keyboardNavigation: { routeWillChange: () => {} },
      setBootstrapError: () => {},
      taskWorkspace: {
        openRoute: async () => calls.push("workspace-open"),
        recoverForeground: async () => ({ recovered: true }),
      },
      refreshCaffoldUpdate: () => calls.push("update-status"),
    };
    globalThis.window.location = {
      href: "https://caffold.test/tasks",
      origin: "https://caffold.test",
      pathname: "/tasks",
      search: "",
    };
    globalThis.window.history = {
      pushState: (_entry, _title, url) => calls.push(`history-push:${url}`),
      replaceState: (_entry, _title, url) => calls.push(`history-replace:${url}`),
    };

    const recovery = await appShell.recoverForeground.call(owner, {
      activationRoute: "/tasks/thread-1",
      initialActivation: false,
      isCurrent: () => true,
      progress: { activatingRoute: () => {} },
    });

    assert.deepEqual(calls, expected);
    assert.deepEqual(recovery, { recovered: true });
  });
}

test("asks for the update status only after a recovery that reached Caffold", async () => {
  globalThis.window.location = {
    href: "https://caffold.test/tasks",
    origin: "https://caffold.test",
    pathname: "/tasks",
    search: "",
  };
  for (const [initialActivation, recovery, asks] of [
    [false, { retry: false }, 1],
    [true, { retry: false }, 0],
    [false, { retry: true }, 0],
    [false, { stale: true, retry: false }, 0],
  ]) {
    let asked = 0;
    const owner = {
      currentRoute: { kind: "tasks" },
      taskWorkspace: { recoverForeground: async () => recovery },
      refreshCaffoldUpdate: () => {
        asked += 1;
      },
    };

    assert.equal(
      await appShell.recoverForeground.call(owner, {
        activationRoute: null,
        initialActivation,
        isCurrent: () => true,
        progress: { activatingRoute: () => {} },
      }),
      recovery,
    );
    assert.equal(asked, asks, JSON.stringify({ initialActivation, recovery }));
  }
});

test("a check shows the last answer meanwhile and outranks a read that left before it", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, options) => {
    const answer = Promise.withResolvers();
    requests.push({
      url: String(url),
      method: options.method,
      answer: (status) => answer.resolve({ ok: true, status: 200, json: async () => status }),
    });
    return answer.promise;
  };
  Object.assign(globalThis.window, {
    location: { origin: "https://caffold.test" },
    setTimeout,
    clearTimeout,
  });
  const published = [];
  const owner = {
    caffoldUpdate: null,
    caffoldUpdateRead: null,
    caffoldUpdateCheck: null,
    caffoldUpdateGeneration: 0,
    requestCaffoldUpdate: appShell.requestCaffoldUpdate,
    applyCaffoldUpdate(snapshot) {
      this.caffoldUpdate = snapshot;
      published.push(snapshot);
    },
  };
  const upToDate = { version: "0.18.2", updateAvailable: false };
  const available = { version: "0.18.2", updateAvailable: true };
  try {
    const first = appShell.refreshCaffoldUpdate.call(owner);
    requests[0].answer(upToDate);
    await first;
    assert.deepEqual(published, [{ checking: false, status: upToDate, error: null }]);

    const staleRead = appShell.refreshCaffoldUpdate.call(owner);
    const check = appShell.checkCaffoldUpdate.call(owner);
    assert.deepEqual(published.at(-1), { checking: true, status: upToDate, error: null });
    assert.deepEqual(
      requests.map(({ url, method }) => `${method} ${new URL(url).pathname}`),
      ["GET /api/caffold/update", "GET /api/caffold/update", "POST /api/caffold/update/check"],
    );

    // Reads and checks that start during the check wait for it.
    assert.equal(appShell.refreshCaffoldUpdate.call(owner), check);
    assert.equal(appShell.checkCaffoldUpdate.call(owner), check);
    assert.equal(requests.length, 3);

    requests[2].answer(available);
    await check;
    requests[1].answer(upToDate);
    await staleRead;
    assert.deepEqual(published.at(-1), { checking: false, status: available, error: null });
    assert.equal(published.length, 3);
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.window.location;
    delete globalThis.window.setTimeout;
    delete globalThis.window.clearTimeout;
  }
});

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
