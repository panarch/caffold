import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./task-start-dialog.js");
const taskStart = registry.element("caffold-github-task-start-dialog").prototype;
after(() => registry.restore());

test("merges own, turn-option, and current source targets", () => {
  const cancel = button("Cancel");
  const start = button("Start Task");
  const body = layoutElement();
  const dialog = layoutElement({
    open: true,
    querySelector(selector) {
      if (selector === ".github-task-start-body") {
        return body;
      }
      return selector.includes("cancel") ? cancel : start;
    },
  });
  const model = { id: "model" };
  const permission = { id: "permission" };
  const sourceTarget = { id: "source" };
  const source = {
    source: () => ({ number: 12 }),
    actionHintScope: () => ({ targets: [sourceTarget] }),
  };
  const turnOptions = {
    actionHintModelTarget: () => model,
    actionHintPermissionTarget: () => permission,
  };
  const owner = {
    isConnected: true,
    sourceKind: "issue",
    pending: false,
    dialog: () => dialog,
    sourceComponent: () => source,
    turnOptions: () => turnOptions,
  };
  const scope = taskStart.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "github-task-start:issue:12:cancel",
    "github-task-start:issue:12:start",
    "model",
    "permission",
    "source",
  ]);
});

test("binds modal Editing escape and exact Task setup scrollport", () => {
  const cancel = button("Cancel");
  const select = {};
  const body = layoutElement({ clientHeight: 100, scrollHeight: 240 });
  const hintDialog = {};
  const hud = {};
  const presentation = {
    actionHintDialog: () => hintDialog,
    scrollModeHud: () => hud,
  };
  const dialog = layoutElement({
    open: true,
    querySelector(selector) {
      if (selector.includes("keyboard-navigation-presentation")) {
        return presentation;
      }
      if (selector === ".github-task-start-body") {
        return body;
      }
      return cancel;
    },
  });
  const source = { source: () => ({ number: 12 }) };
  const turnOptions = { keyboardNavigationContexts: () => [] };
  const owner = {
    isConnected: true,
    sourceKind: "issue",
    dialog: () => dialog,
    sourceComponent: () => source,
    issueSource: () => ({ querySelector: () => select }),
    turnOptions: () => turnOptions,
    actionHintScope: () => ({ targets: [] }),
  };
  owner.scrollSurfaceScope = () => taskStart.scrollSurfaceScope.call(owner);
  const [context] = taskStart.keyboardNavigationContexts.call(owner);
  const surface = context.scroll.scope.surfaces[0];

  assert.equal(context.actionHints.dialog, hintDialog);
  assert.equal(context.scroll.hud, hud);
  assert.equal(context.editing.escapeTarget(select), cancel);
  assert.equal(surface.scrollport, body);
  assert.equal(surface.isEligible(), true);
});

function button(textContent) {
  return {
    disabled: false,
    textContent,
    focus() {},
    click() {},
  };
}

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
