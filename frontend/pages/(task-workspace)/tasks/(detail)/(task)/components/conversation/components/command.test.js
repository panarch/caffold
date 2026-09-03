import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./command.js");
const command = registry.element("caffold-task-command").prototype;
after(() => registry.restore());

test("provides the retained active Command as a disclosure", () => {
  let clicks = 0;
  const anchor = { id: "command-chevron" };
  let currentAnchor = anchor;
  const summary = {
    querySelector: () => currentAnchor,
    focus() {},
    click() {
      clicks += 1;
    },
  };
  let currentSummary = summary;
  const disclosure = {
    open: false,
    querySelector: () => currentSummary,
  };
  const terminalControl = {
    disabled: false,
    textContent: "View output",
    getAttribute: () => null,
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    commandKey: "command-a",
    presentation: { mode: "active" },
    ensureState() {},
    disclosure: () => disclosure,
    action: () => terminalControl,
  };

  const collapsed = command.actionHintScope.call(owner, {
    scopeId: "task:a:command:a",
  }).targets[0];
  assert.deepEqual(
    {
      id: collapsed.id,
      actionId: collapsed.actionId,
      label: collapsed.label,
      controlKind: collapsed.controlKind,
      anchor: collapsed.anchor,
    },
    {
      id: "task:a:command:a:disclosure:command-a",
      actionId: "disclosure.toggle",
      label: "Expand Command",
      controlKind: "disclosure",
      anchor,
    },
  );
  assert.equal(collapsed.isActionable(), true);
  collapsed.activate();
  assert.equal(clicks, 1);

  disclosure.open = true;
  const expanded = command.actionHintScope.call(owner, {
    scopeId: "task:a:command:a",
  }).targets[0];
  assert.equal(expanded.id, collapsed.id);
  assert.equal(expanded.label, "Collapse Command");
  currentAnchor = { id: "replacement-chevron" };
  assert.equal(collapsed.isActionable(), false);
  currentAnchor = anchor;
  currentSummary = { id: "replacement-summary" };
  assert.equal(collapsed.isActionable(), false);
  currentSummary = summary;
  owner.isConnected = false;
  assert.equal(collapsed.isActionable(), false);
  owner.isConnected = true;
  owner.hidden = true;
  assert.equal(collapsed.isActionable(), false);
  assert.deepEqual(
    command.actionHintScope.call(owner, { scopeId: "task:a:command:a" }).targets,
    [],
  );
  owner.hidden = false;
  owner.presentation = { mode: "terminal" };
  assert.equal(collapsed.isActionable(), false);
  assert.equal(
    command.actionHintScope.call(owner, {
      scopeId: "task:a:command:a",
    }).targets[0].id,
    "task:a:command:a:view-output",
  );
  owner.commandKey = "command-b";
  assert.equal(collapsed.isActionable(), false);
});

test("provides View output only for the retained terminal command", () => {
  let control = {
    disabled: false,
    textContent: "View output",
    clicks: 0,
    getAttribute: () => null,
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    commandKey: "command-a",
    presentation: { mode: "terminal" },
    ensureState() {},
    action: () => control,
  };
  const target = command.actionHintScope.call(owner, {
    scopeId: "task:a:command:a",
  }).targets[0];
  assert.equal(target.id, "task:a:command:a:view-output");
  assert.equal(target.controlKind, "button");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(control.clicks, 1);
  owner.hidden = true;
  assert.equal(target.isActionable(), false);
  owner.hidden = false;
  owner.commandKey = "command-b";
  assert.equal(target.isActionable(), false);
  control = null;
});

test("provides active output only while its exact disclosure is expanded", () => {
  const output = layoutElement();
  const disclosure = {
    open: true,
    querySelector: () => output,
  };
  let currentDisclosure = disclosure;
  const owner = layoutElement({
    hidden: false,
    isConnected: true,
    commandKey: "command-a",
    presentation: { mode: "active" },
    ensureState() {},
    disclosure: () => currentDisclosure,
  });

  const scope = command.scrollSurfaceScope.call(owner, {
    scopeId: "task:a:command:a",
  });
  const surface = scope.surfaces[0];
  assert.equal(surface.id, "task:a:command:a:output");
  assert.equal(surface.scrollport, output);
  assert.deepEqual(surface.axes, ["horizontal"]);
  assert.equal(surface.isEligible(), true);
  disclosure.open = false;
  assert.equal(surface.isEligible(), false);
  disclosure.open = true;
  currentDisclosure = { ...disclosure };
  assert.equal(surface.isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
