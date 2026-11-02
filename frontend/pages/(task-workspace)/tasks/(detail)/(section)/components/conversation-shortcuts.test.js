import assert from "node:assert/strict";
import test, { after } from "node:test";
import { elementStandIn, installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
const registry = installCustomElementUnitRegistry();
await import("./conversation-shortcuts.js");
const shortcuts = registry.element("caffold-section-conversation-shortcuts").prototype;
after(() => registry.restore());

test("the common opener is independent of Codex readiness and obeys Task transport", () => {
  const owner = elementStandIn(shortcuts, {
    active: false, hidden: true, context: {sectionId: "section-a"},
    transportAvailable: true, taskStoreStatusSnapshot: null, forkDialog: () => null,
  });
  owner.activate(); owner.updated();
  assert.equal(owner.hidden, false);
  assert.equal(owner.disabledReason(), "");
  owner.setTransportAvailable(false);
  assert.match(owner.disabledReason(), /Reconnect/);
  owner.deactivate(); owner.updated();
  assert.equal(owner.hidden, true);
});
