import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./document-dialog.js");
const documentDialog = registry.element(
  "caffold-current-plan-document-dialog",
).prototype;
after(() => registry.restore());

test("provides Close and only the currently visible Retry action", () => {
  const close = actionControl("Close document");
  const retry = actionControl("Retry", { visible: false });
  const controls = new Map([
    [".current-plan-document-close", close],
    ['[data-current-plan-dialog-action="retry"]', retry],
  ]);
  const dialog = {
    open: true,
    querySelector: (selector) => controls.get(selector),
  };
  const owner = {
    isConnected: true,
    current: { path: "task/PLAN.md" },
    dialog: () => dialog,
  };
  const scope = documentDialog.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "current-plan-document:task%2FPLAN.md:close",
    "current-plan-document:task%2FPLAN.md:retry",
  ]);
  assert.equal(scope.targets[0].isActionable(), true);
  assert.equal(scope.targets[1].isActionable(), false);
  retry.visible = true;
  assert.equal(scope.targets[1].isActionable(), true);
});

test("provides its exact modal document context and preview scrollport", () => {
  const hintDialog = {};
  const hud = { show() {}, close() {}, updateLabel() {} };
  const presentation = {
    actionHintDialog: () => hintDialog,
    scrollModeHud: () => hud,
  };
  const actionScope = { targets: [{ id: "close" }] };
  const preview = {
    clientHeight: 300,
    scrollHeight: 900,
    hidden: false,
    getClientRects: () => [{}],
  };
  const dialog = {
    open: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      assert.equal(
        selector,
        ":scope > caffold-keyboard-navigation-presentation",
      );
      return presentation;
    },
  };
  const owner = {
    current: { path: "task/PLAN.md", label: "Plan" },
    isConnected: true,
    dialog: () => dialog,
    preview: () => preview,
    actionHintScope: () => actionScope,
  };

  const [context] = documentDialog.keyboardNavigationContexts.call(owner);
  const surface = context.scroll.scope.surfaces[0];
  assert.equal(context.id, "current-plan-document:task/PLAN.md");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, dialog);
  assert.equal(context.actionHints.dialog, hintDialog);
  assert.deepEqual(context.actionHints.scope.targets, actionScope.targets);
  assert.equal(context.scroll.hud, hud);
  assert.equal(surface.id, "current-plan:task/PLAN.md:preview");
  assert.equal(surface.label, "Plan document");
  assert.equal(surface.scrollport, preview);
  assert.equal(surface.isEligible(), true);
  preview.hidden = true;
  assert.equal(surface.isEligible(), false);
  preview.hidden = false;
  owner.current = { path: "task/CHECKLIST.md", label: "Checklist" };
  assert.equal(surface.isEligible(), false);
});

function actionControl(textContent, { visible = true } = {}) {
  return {
    disabled: false,
    textContent,
    visible,
    getAttribute: (name) => name === "aria-label" ? textContent : "",
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    focus() {},
    click() {},
  };
}
