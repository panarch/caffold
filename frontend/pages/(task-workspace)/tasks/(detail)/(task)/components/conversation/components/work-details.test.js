import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./work-details.js");
const workDetails = registry.element("caffold-task-work-details").prototype;
after(() => registry.restore());

test("merges its root disclosure with only direct retained work items", () => {
  const commandTarget = { id: "command" };
  const messageTarget = { id: "message" };
  const command = { actionHintScope: () => ({ targets: [commandTarget] }) };
  const message = { actionHintScope: () => ({ targets: [messageTarget] }) };
  const body = {
    children: [
      {
        dataset: { commandWorkIdentity: "command-a" },
        querySelector: () => command,
      },
      {
        dataset: { messageWorkIdentity: "message-a" },
        querySelector: (selector) => selector.includes("assistant-message") ? message : null,
      },
    ],
  };
  let clicks = 0;
  const anchor = { id: "work-chevron" };
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
  const owner = {
    isConnected: true,
    identity: "work-a",
    snapshot: { label: "Worked for 8m" },
    hidden: false,
    ensureState() {},
    querySelector(selector) {
      return selector.includes("data-work-details-disclosure-key")
        ? disclosure
        : body;
    },
  };
  const targets = workDetails.actionHintScope.call(owner, {
    scopeId: "work:a",
  }).targets;
  assert.deepEqual(targets.slice(1), [commandTarget, messageTarget]);
  assert.deepEqual(
    {
      id: targets[0].id,
      actionId: targets[0].actionId,
      label: targets[0].label,
      controlKind: targets[0].controlKind,
      anchor: targets[0].anchor,
    },
    {
      id: "work:a:disclosure:work-a:root",
      actionId: "disclosure.toggle",
      label: "Expand Worked for 8m",
      controlKind: "disclosure",
      anchor,
    },
  );
  assert.equal(targets[0].isActionable(), true);
  targets[0].activate();
  assert.equal(clicks, 1);

  disclosure.open = true;
  const expanded = workDetails.actionHintScope.call(owner, {
    scopeId: "work:a",
  }).targets[0];
  assert.equal(expanded.id, targets[0].id);
  assert.equal(expanded.label, "Collapse Worked for 8m");

  currentAnchor = { id: "replacement-chevron" };
  assert.equal(targets[0].isActionable(), false);
  currentAnchor = anchor;
  currentSummary = { id: "replacement-summary" };
  assert.equal(targets[0].isActionable(), false);
  currentSummary = summary;
  owner.isConnected = false;
  assert.equal(targets[0].isActionable(), false);
  owner.isConnected = true;
  owner.hidden = true;
  assert.equal(targets[0].isActionable(), false);
  assert.deepEqual(
    workDetails.actionHintScope.call(owner, { scopeId: "work:a" }).targets,
    [],
  );
  owner.hidden = false;
  owner.identity = "";
  assert.deepEqual(workDetails.actionHintScope.call(owner, { scopeId: "work:a" }).targets, []);
  assert.equal(targets[0].isActionable(), false);
});
