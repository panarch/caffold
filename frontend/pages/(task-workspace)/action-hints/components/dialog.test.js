import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./dialog.js");
const ActionHintDialog = registry.element("caffold-action-hint-dialog");
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
