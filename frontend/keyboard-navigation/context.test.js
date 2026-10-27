import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const {
  KeyboardContexts,
  mergeKeyboardNavigationContexts,
  normalizeKeyboardNavigationContexts,
} = await import("./context.js");
const previousElement = globalThis.Element;
const previousShadowRoot = globalThis.ShadowRoot;
const previousNode = globalThis.Node;
globalThis.Element = globalThis.HTMLElement;
globalThis.ShadowRoot = class TestShadowRoot {};
globalThis.Node = { DOCUMENT_POSITION_PRECEDING: 2 };

after(() => {
  restoreGlobal("Element", previousElement);
  restoreGlobal("ShadowRoot", previousShadowRoot);
  restoreGlobal("Node", previousNode);
  registry.restore();
});

test("composes context lists as they are", () => {
  const workspace = { id: "workspace" };
  const popover = { id: "model" };
  assert.deepEqual(
    mergeKeyboardNavigationContexts([workspace], null, [popover]),
    [workspace, popover],
  );
});

test("accepts each context once, its lists without repeats", () => {
  const root = element();
  const shown = presentation(root);
  root.append(shown);
  const scrollport = element();
  const clip = element();
  const context = {
    id: " workspace ",
    kind: "workspace",
    root,
    presentation: shown,
    sessionBound: false,
    actionHints: {
      blocked: false,
      targets: [{ id: "a" }],
      mutationRoots: [clip, clip],
      scrollRoots: [clip, clip],
    },
    scroll: {
      blocked: false,
      surfaces: [{ id: "list", label: " List ", scrollport, clipRoots: [clip, clip] }],
      mutationRoots: [clip],
      resizeElements: [clip],
      scrollRoots: [scrollport],
    },
    editing: null,
  };

  const [normalized] = normalizeKeyboardNavigationContexts([context]);
  assert.equal(normalized.id, "workspace");
  assert.deepEqual(normalized.actionHints.mutationRoots, [clip]);
  assert.deepEqual(normalized.actionHints.scrollRoots, [clip]);
  assert.deepEqual(normalized.scroll.mutationRoots, [root, clip]);
  assert.deepEqual(normalized.scroll.resizeElements, [root, clip]);
  assert.deepEqual(
    normalized.scroll.surfaces.map(({ label, axes, clipRoots }) => ({
      label,
      axes,
      clipRoots,
    })),
    [{ label: "List", axes: ["vertical"], clipRoots: [clip] }],
  );

  const editingOnly = {
    ...context,
    actionHints: null,
    scroll: null,
    editing: { escapeTarget: () => root },
  };
  assert.equal(normalizeKeyboardNavigationContexts([editingOnly]).length, 1);
  assert.equal(
    normalizeKeyboardNavigationContexts([
      { ...editingOnly, editing: null },
    ]),
    null,
    "a context that offers nothing",
  );
  assert.equal(
    normalizeKeyboardNavigationContexts([context, { ...context }]),
    null,
    "two contexts with one id and root",
  );
  assert.equal(
    normalizeKeyboardNavigationContexts([
      { ...context, presentation: presentation(null) },
    ]),
    null,
    "a presentation outside the root",
  );
  assert.equal(
    normalizeKeyboardNavigationContexts([
      {
        ...context,
        scroll: {
          ...context.scroll,
          surfaces: [context.scroll.surfaces[0], context.scroll.surfaces[0]],
        },
      },
    ]),
    null,
    "two surfaces with one id",
  );
});

test("makes a context for each declared modal or popover that is open and offered", () => {
  const owner = element();
  const modal = declaredRoot(owner, ":modal");
  const popover = declaredRoot(owner, ":popover-open");
  const keyboard = new KeyboardContexts(owner);
  keyboard.roots.add(modal, {
    element: modal,
    value: { kind: "modal", declaration: { id: "restart" } },
  });
  keyboard.roots.add(popover, {
    element: popover,
    value: {
      kind: "popover",
      declaration: { id: "git", label: "Git actions", sessionBound: true },
    },
  });
  const modalPresentation = presentation(modal);
  const popoverPresentation = presentation(popover);
  keyboard.presentations.add(modalPresentation, {
    element: modalPresentation,
    value: null,
  });
  keyboard.presentations.add(popoverPresentation, {
    element: popoverPresentation,
    value: null,
  });
  const pulls = [];
  const capabilities = {
    actionHints(pull) {
      pulls.push(pull);
      return { targets: [{ id: `${pull.scopeId}:target` }] };
    },
  };

  modal.open = true;
  const [restart] = keyboard.contexts(capabilities);
  assert.equal(restart.id, "restart");
  assert.equal(restart.kind, "modal");
  assert.equal(restart.root, modal);
  assert.equal(restart.presentation, modalPresentation);
  assert.equal(restart.sessionBound, false);
  assert.deepEqual(restart.actionHints.targets, [{ id: "restart:target" }]);
  assert.deepEqual(restart.actionHints.scrollRoots, [modal]);
  assert.equal(restart.scroll, null);
  assert.deepEqual(pulls, [
    { scopeId: "restart", clipRoots: [modal], contextRoot: modal },
  ]);
  const [prefixed] = keyboard.contexts({
    ...capabilities,
    scopeId: "review:viewer",
  });
  assert.equal(prefixed.id, "review:viewer:restart");

  modal.open = false;
  popover.open = true;
  const [git, ...rest] = keyboard.contexts(capabilities);
  assert.deepEqual(rest, []);
  assert.equal(git.kind, "popover");
  assert.equal(git.root, popover);
  assert.equal(git.sessionBound, true);
  assert.equal(git.presentation, popoverPresentation);
  assert.deepEqual(
    git.scroll.surfaces.map(({ id, label, scrollport }) => ({
      id,
      label,
      scrollport,
    })),
    [{ id: "git", label: "Git actions", scrollport: popover }],
  );

  keyboard.roots.add(popover, {
    element: popover,
    value: {
      kind: "popover",
      declaration: { id: "git", label: "Git actions", when: false },
    },
  });
  assert.deepEqual(keyboard.contexts(capabilities), []);
});

test("a declared root whose presentation is not drawn makes no context", () => {
  const owner = element();
  const modal = declaredRoot(owner, ":modal");
  modal.open = true;
  const keyboard = new KeyboardContexts(owner);
  keyboard.roots.add(modal, {
    element: modal,
    value: { kind: "modal", declaration: { id: "restart" } },
  });

  assert.deepEqual(
    keyboard.contexts({ actionHints: () => ({ targets: [] }) }),
    [],
  );
});

test("the workspace context is rooted at the owner and reads outside its roots", () => {
  const owner = element();
  const ownPresentation = presentation(owner);
  const keyboard = new KeyboardContexts(owner);
  keyboard.presentations.add(ownPresentation, {
    element: ownPresentation,
    value: null,
  });
  const pulls = [];
  const escapeTarget = () => owner;
  const [workspace] = keyboard.workspace("workspace", {
    actionHints(pull) {
      pulls.push(pull);
      return { targets: [] };
    },
    scroll(pull) {
      pulls.push(pull);
      return { surfaces: [] };
    },
    editing: { escapeTarget },
  });

  assert.equal(workspace.id, "workspace");
  assert.equal(workspace.kind, "workspace");
  assert.equal(workspace.root, owner);
  assert.equal(workspace.presentation, ownPresentation);
  assert.equal(workspace.editing.escapeTarget, escapeTarget);
  assert.deepEqual(pulls, [{ contextRoot: null }, { contextRoot: null }]);
});

// A modal or popover drawn under `owner`, open while `open` is true.
function declaredRoot(owner, openSelector) {
  const root = element({
    parentElement: owner,
    open: false,
    matches(selector) {
      return selector === openSelector && this.open;
    },
  });
  owner.append(root);
  return root;
}

function presentation(parentElement) {
  return element({ parentElement });
}

function element(properties = {}) {
  const children = new Set();
  return Object.assign(new HTMLElement(), {
    isConnected: true,
    append(...elements) {
      for (const child of elements) {
        children.add(child);
      }
    },
    contains(candidate) {
      return candidate === this || children.has(candidate);
    },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    }),
    getClientRects: () => [{}],
    compareDocumentPosition: () => 4,
    ...properties,
  });
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
