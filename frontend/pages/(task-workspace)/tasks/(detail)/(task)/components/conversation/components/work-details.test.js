import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./work-details.js");
const workDetails = registry.element("caffold-task-work-details").prototype;
after(() => registry.restore());

test("merges only direct retained command and message work items", () => {
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
  const owner = {
    identity: "work-a",
    hidden: false,
    ensureState() {},
    querySelector: () => body,
  };
  assert.deepEqual(
    workDetails.actionHintScope.call(owner, { scopeId: "work:a" }).targets,
    [commandTarget, messageTarget],
  );
  owner.identity = "";
  assert.deepEqual(workDetails.actionHintScope.call(owner, { scopeId: "work:a" }).targets, []);
});
