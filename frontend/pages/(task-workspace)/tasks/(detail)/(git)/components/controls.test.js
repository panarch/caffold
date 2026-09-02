import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./controls.js");
const controls = registry.element("caffold-git-review-controls").prototype;
after(() => registry.restore());

test("provides only the retained Refresh Git button", () => {
  let button = {
    disabled: false,
    getAttribute: () => "Refresh Git review",
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    get refreshButton() {
      return button;
    },
  };
  const target = controls.actionHintScope.call(owner, {
    scopeId: "git:/repo",
  }).targets[0];
  assert.equal(target.id, "git:/repo:refresh");
  assert.equal(target.actionId, "button.activate");
  assert.equal(target.isActionable(), true);
  button = { disabled: false };
  assert.equal(target.isActionable(), false);
});

test("provides visible Compare ref selects with Refresh in visual order", () => {
  const base = select("main");
  const head = select("feature/keyboard-hints");
  const refresh = {
    disabled: false,
    getAttribute: () => "Refresh Compare",
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    compareRefs: { hidden: false },
    snapshot: { mode: "compare", refs: [{ name: "main" }] },
    baseRefSelect: base,
    headRefSelect: head,
    refreshButton: refresh,
    ensureRendered() {},
  };

  const scope = controls.actionHintScope.call(owner, { scopeId: "git:/repo" });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "git:/repo:compare-ref:base",
    "git:/repo:compare-ref:head",
    "git:/repo:refresh",
  ]);
  assert.deepEqual(scope.targets.map(({ controlKind }) => controlKind), [
    "select",
    "select",
    "button",
  ]);
  assert.equal(scope.targets[0].label, "Choose Base ref (current main)");
  assert.equal(
    scope.targets[1].label,
    "Choose Head ref (current feature/keyboard-hints)",
  );
  scope.targets[0].activate();
  assert.equal(base.focused, 1);
  assert.equal(base.pickerCalls, 1);

  owner.snapshot = { mode: "log", refs: [{ name: "main" }] };
  assert.equal(scope.targets[0].isActionable(), false);
  assert.deepEqual(
    controls.actionHintScope.call(owner, { scopeId: "git:/repo" }).targets.map(
      ({ id }) => id,
    ),
    ["git:/repo:refresh"],
  );
  owner.snapshot = { mode: "compare", refs: [{ name: "main" }] };
  owner.baseRefSelect = select("develop");
  assert.equal(scope.targets[0].isActionable(), false);
});

function select(value) {
  return {
    value,
    disabled: false,
    hidden: false,
    focused: 0,
    pickerCalls: 0,
    getClientRects: () => [{}],
    focus() {
      this.focused += 1;
    },
    showPicker() {
      this.pickerCalls += 1;
    },
  };
}
