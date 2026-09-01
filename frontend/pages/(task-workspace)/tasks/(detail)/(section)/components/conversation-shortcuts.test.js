import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./conversation-shortcuts.js");
const shortcuts = registry.element("caffold-section-conversation-shortcuts").prototype;
after(() => registry.restore());

test("provides the retained Fork opener only for the active Section context", () => {
  let control = {
    disabled: false,
    textContent: "Fork from Codex thread ID",
    getAttribute: () => null,
    focus() {},
    click() {},
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    context: { key: "section-a\0/repo" },
    ensureRendered() {},
    querySelector: () => control,
  };

  const target = shortcuts.actionHintScope.call(owner, {
    scopeId: "section:section-a",
  }).targets[0];
  assert.equal(target.id, "section:section-a:fork-conversation");
  assert.equal(target.actionId, "button.activate");
  assert.equal(target.isActionable(), true);
  owner.context = { key: "section-b\0/repo" };
  assert.equal(target.isActionable(), false);
  control = null;
});
