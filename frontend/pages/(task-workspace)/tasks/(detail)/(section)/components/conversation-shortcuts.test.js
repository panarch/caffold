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

test("shows the Fork opener only once Codex is known to be installed", () => {
  const button = { disabled: false, title: "" };
  const reason = { textContent: "", hidden: true };
  const owner = {
    active: true,
    hidden: false,
    context: { sectionId: "section-a" },
    transportAvailable: true,
    taskStoreStatusSnapshot: null,
    codexStatusSnapshot: { phase: "checking", status: null, error: "" },
    toggleAttribute(name, force) {
      assert.equal(name, "hidden");
      this.hidden = force;
    },
    disabledReason: shortcuts.disabledReason,
    querySelector: (selector) =>
      selector.includes("fork-codex") ? button : reason,
  };
  const readiness = (state, diagnosticMessage = "") => ({
    phase: "loaded",
    status: {
      readiness: {
        state,
        blocksTaskOperations: state !== "ready",
        diagnosticMessage,
      },
    },
    error: "",
  });

  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, true);

  owner.codexStatusSnapshot = readiness("missing", "Install Codex.");
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, true);

  owner.codexStatusSnapshot = readiness("signInRequired", "Sign in to Codex.");
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(reason.textContent, "Sign in to Codex.");

  owner.codexStatusSnapshot = readiness("ready");
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, false);
  assert.equal(button.disabled, false);
});
