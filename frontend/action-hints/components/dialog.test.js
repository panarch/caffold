import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./dialog.js");
const ActionHintDialog = registry.element("caffold-action-hint-dialog");
const dialog = ActionHintDialog.prototype;
after(() => registry.restore());

test("allocates unique accessible labeling IDs per retained instance", () => {
  const first = new ActionHintDialog();
  const second = new ActionHintDialog();
  first.ensureState();
  second.ensureState();

  assert.match(first.titleId, /^action-hint-title-/);
  assert.match(first.descriptionId, /^action-hint-description-/);
  assert.notEqual(first.titleId, second.titleId);
  assert.notEqual(first.descriptionId, second.descriptionId);
});

test("shows only matching retained badges and restores them", () => {
  const badges = ["TA", "N"].map((code) => ({
    dataset: { actionHintCode: code },
    hidden: false,
  }));
  const owner = {
    dialog: { dataset: {} },
    badges: { querySelectorAll: () => badges },
    status: { textContent: "" },
  };

  dialog.updateInput.call(owner, {
    buffer: "T",
    matches: ["TA"],
    status: "partial",
  });

  assert.deepEqual(badges.map(({ hidden }) => hidden), [false, true]);
  assert.deepEqual(owner.dialog.dataset, {
    input: "T",
    inputState: "partial",
  });
  assert.equal(owner.status.textContent, "Typed T");

  dialog.updateInput.call(owner, {
    buffer: "",
    matches: ["TA", "N"],
    status: "idle",
  });

  assert.deepEqual(badges.map(({ hidden }) => hidden), [false, false]);
  assert.equal(owner.status.textContent, "");
});
