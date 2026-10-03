import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const apiHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "#app/api.js" &&
      context.parentURL === new URL("./directory-picker.js", import.meta.url).href
    ) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const listDirectory=(...a)=>globalThis.pickerApi.listDirectory(...a);",
      };
    }
    return nextResolve(specifier, context);
  },
});
const registry = installCustomElementUnitRegistry();
await import("./directory-picker.js");
const picker = registry.element("caffold-task-directory-picker").prototype;
after(() => {
  registry.restore();
  apiHook.deregister();
  delete globalThis.pickerApi;
  delete globalThis.window;
});

test("merges owned picker buttons with the child-owned directory rows", () => {
  const controls = new Map([
    [".task-directory-picker-close", button("Close directory picker")],
    [
      ".task-directory-picker-footer [data-directory-picker-action='close']",
      button("Cancel"),
    ],
    [
      ".task-directory-picker-footer [data-directory-picker-action='choose']",
      button("Use This Folder"),
    ],
  ]);
  const body = {};
  const childTarget = { id: "new:directory-picker:file:folder" };
  let childOptions;
  const tree = {
    actionHintScope(options) {
      childOptions = options;
      return {
        targets: [childTarget],
        mutationRoots: [tree],
        scrollRoots: [{}],
      };
    },
  };
  const dialog = {
    open: true,
    querySelector(selector) {
      return selector === ".task-directory-picker-body"
        ? body
        : controls.get(selector);
    },
  };
  const owner = {
    isConnected: true,
    ensureRendered() {},
    dialog: () => dialog,
    tree: () => tree,
  };
  const scope = picker.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.slice(0, 3).map(({ label }) => label), [
    "Close directory picker",
    "Cancel",
    "Use This Folder",
  ]);
  assert.equal(scope.targets[3], childTarget);
  assert.equal(childOptions.includeDirectories, true);
  assert.equal(childOptions.disclosureActionId, undefined);
  assert.deepEqual(childOptions.clipRoots, [dialog, body]);
});

test("declares only the exact retained file-tree scroller", () => {
  const scrollport = layoutElement({ clientHeight: 100, scrollHeight: 220 });
  const tree = { scroller: () => scrollport };
  const dialog = layoutElement({ open: true });
  const owner = {
    isConnected: true,
    ensureRendered() {},
    dialog: () => dialog,
    tree: () => tree,
  };
  const scope = picker.scrollSurfaceScope.call(owner);

  assert.equal(scope.surfaces.length, 1);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 101;
  assert.equal(scope.surfaces[0].isEligible(), true);
});

function button(label) {
  return {
    disabled: false,
    textContent: label,
    getAttribute: (name) => name === "aria-label" && label.startsWith("Close")
      ? label
      : "",
    focus() {},
    click() {},
  };
}

function layoutElement(properties = {}) {
  return {
    getClientRects: () => [{}],
    ...properties,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function openingPicker() {
  const timers = new Map();
  let nextTimerId = 0;
  globalThis.window = {
    setTimeout(callback, delay) {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const models = [];
  const body = { setAttribute() {}, removeAttribute() {} };
  const owner = {
    directoryRequestId: 0,
    listings: [],
    ensureRendered() {},
    setError() {},
    setChoosingEnabled() {},
    updatePathLabel() {},
    renderDirectory(directory) {
      this.listings.push(directory);
    },
    dialog: () => ({ open: true }),
    tree: () => ({ setModel: (model) => models.push(model) }),
    querySelector: () => body,
  };
  for (const method of ["open", "loadDirectory", "setTreeMessage", "clearTree"]) {
    owner[method] = picker[method].bind(owner);
  }
  const runTimers = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.callback();
    }
  };
  return { owner, models, timers, runTimers };
}

test("opening clears the last folders and shows a loading row only after the wait", async () => {
  const read = deferred();
  globalThis.pickerApi = { listDirectory: () => read.promise };
  const { owner, models, timers, runTimers } = openingPicker();

  owner.open("projects");
  assert.deepEqual(models.map((model) => model.nodes), [[]], "the previous folders are gone at once");
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [180]);

  runTimers();
  assert.deepEqual(models.at(-1).nodes, [{
    key: "directory-picker:state",
    kind: "status",
    name: "Loading folders...",
    tone: "muted",
    loading: true,
  }]);

  read.resolve({ path: "projects", root: "", entries: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.listings.length, 1);
  assert.equal(timers.size, 0);
});

test("a folder list that arrives within the wait never shows a loading row", async () => {
  globalThis.pickerApi = {
    listDirectory: () => Promise.resolve({ path: "projects", root: "", entries: [] }),
  };
  const { owner, models, timers } = openingPicker();

  owner.open("projects");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0);
  assert.equal(models.some((model) => model.nodes.some((node) => node.loading)), false);
  assert.equal(owner.listings.length, 1);
});
