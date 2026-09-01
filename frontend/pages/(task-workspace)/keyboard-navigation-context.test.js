import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
globalThis.Element = globalThis.HTMLElement;
const {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
  normalizeKeyboardNavigationContexts,
  popoverScrollSurfaceScope,
} = await import("./keyboard-navigation-context.js");

after(() => {
  restoreGlobal("Element", previousElement);
  registry.restore();
});

test("composes context lists without rebuilding owner capabilities", () => {
  const workspace = { id: "workspace" };
  const popover = { id: "model" };
  assert.deepEqual(
    mergeKeyboardNavigationContexts([workspace], null, [popover]),
    [workspace, popover],
  );
  assert.throws(
    () => mergeKeyboardNavigationContexts([workspace], { id: "invalid" }),
    /must be an array/,
  );
});

test("keeps Action Hint, Scroll, and Editing as separate optional capabilities", () => {
  const root = element();
  const dialog = actionHintDialog();
  const hud = scrollHud();
  const target = { id: "target" };
  const surface = { id: "surface" };
  const escapeTarget = () => root;
  const context = keyboardNavigationContext({
    id: "workspace",
    kind: "workspace",
    root,
    actionHints: {
      dialog,
      scope: { targets: [target] },
    },
    scroll: {
      hud,
      scope: { surfaces: [surface] },
    },
    editing: { escapeTarget },
  });

  assert.equal(context.actionHints.dialog, dialog);
  assert.deepEqual(context.actionHints.scope.targets, [target]);
  assert.deepEqual(context.actionHints.scope.mutationRoots, []);
  assert.equal(context.scroll.hud, hud);
  assert.deepEqual(context.scroll.scope.surfaces, [surface]);
  assert.deepEqual(context.scroll.scope.resizeElements, []);
  assert.equal(context.editing.escapeTarget, escapeTarget);
});

test("normalizes exact owners and rejects duplicate or malformed providers", () => {
  const workspaceRoot = element();
  const popoverRoot = element();
  const targetControl = element();
  const workspaceDialog = actionHintDialog();
  const popoverHud = scrollHud();
  workspaceRoot.append(workspaceDialog);
  popoverRoot.append(popoverHud);
  const contexts = [
    keyboardNavigationContext({
      id: "workspace",
      kind: "workspace",
      root: workspaceRoot,
      actionHints: {
        dialog: workspaceDialog,
        scope: {
          targets: [{
            id: "new",
            actionId: "task.create",
            label: "New task",
            controlKind: "button",
            control: targetControl,
            anchor: targetControl,
            clipRoots: [],
            isActionable: () => true,
            activate: () => {},
          }],
        },
      },
    }),
    keyboardNavigationContext({
      id: "popover:model",
      kind: "popover",
      root: popoverRoot,
      scroll: {
        hud: popoverHud,
        scope: popoverScrollSurfaceScope({
          id: "popover:model",
          label: "Model options",
          popover: popoverRoot,
        }),
      },
    }),
  ];

  const normalized = normalizeKeyboardNavigationContexts(contexts);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0].actionHints.scope.mutationRoots, []);
  assert.equal(normalized[0].editing, null);
  assert.equal(normalized[1].scroll.scope.surfaces[0].scrollport, popoverRoot);
  assert.deepEqual(normalized[1].scroll.scope.resizeElements, [popoverRoot]);

  assert.equal(normalizeKeyboardNavigationContexts([
    contexts[0],
    { ...contexts[1], id: "workspace" },
  ]), null);
  assert.equal(normalizeKeyboardNavigationContexts([
    contexts[0],
    { ...contexts[1], root: workspaceRoot },
  ]), null);
  assert.equal(normalizeKeyboardNavigationContexts([{
    id: "bad-kind",
    kind: "overlay",
    root: element(),
    scroll: contexts[1].scroll,
  }]), null);
  assert.equal(normalizeKeyboardNavigationContexts([{
    id: "bad-capability",
    kind: "popover",
    root: element(),
    actionHints: { dialog: element(), scope: { targets: {} } },
  }]), null);
  assert.equal(normalizeKeyboardNavigationContexts([{
    ...contexts[0],
    actionHints: {
      ...contexts[0].actionHints,
      dialog: actionHintDialog(),
    },
  }]), null);
  assert.equal(normalizeKeyboardNavigationContexts([{
    ...contexts[1],
    scroll: {
      ...contexts[1].scroll,
      hud: scrollHud(),
    },
  }]), null);
  assert.equal(normalizeKeyboardNavigationContexts([{
    id: "bad-editing",
    kind: "modal",
    root: element(),
    editing: { escapeTarget: null },
  }]), null);
});

test("normalizes an Editing-only owner-declared escape destination", () => {
  const root = element();
  const destination = element();
  root.append(destination);
  const escapeTarget = () => destination;
  const [context] = normalizeKeyboardNavigationContexts([
    keyboardNavigationContext({
      id: "modal:editing",
      kind: "modal",
      root,
      editing: { escapeTarget },
    }),
  ]);

  assert.equal(context.actionHints, null);
  assert.equal(context.scroll, null);
  assert.equal(context.editing.escapeTarget, escapeTarget);
});

test("popover Scroll helper binds one exact declared root", () => {
  let current = true;
  const popover = element({
    matches(selector) {
      assert.equal(selector, ":popover-open");
      return true;
    },
  });
  const scope = popoverScrollSurfaceScope({
    id: "permission",
    label: "Permission options",
    popover,
    isCurrent: () => current,
  });

  assert.deepEqual(scope.mutationRoots, [popover]);
  assert.deepEqual(scope.resizeElements, [popover]);
  assert.deepEqual(scope.scrollRoots, [popover]);
  assert.deepEqual(scope.surfaces[0].clipRoots, [popover]);
  assert.equal(scope.surfaces[0].scrollport, popover);
  assert.equal(scope.surfaces[0].isEligible(), true);
  current = false;
  assert.equal(scope.surfaces[0].isEligible(), false);
});

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
    ...properties,
  });
}

function actionHintDialog() {
  return element({
    open() {},
    close() {},
    allowsNativeActivation() {},
    ownsModal() {},
    updateInput() {},
    updateTargetLabels() {},
  });
}

function scrollHud() {
  return element({ show() {}, close() {}, updateLabel() {} });
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
