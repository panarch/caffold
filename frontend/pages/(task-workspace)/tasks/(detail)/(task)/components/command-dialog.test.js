import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./command-dialog.js");
const commandDialog = registry.element("caffold-task-command-dialog").prototype;
after(() => registry.restore());

test("binds Close and parent plus output Scroll to retained dialog controls", () => {
  const close = {
    disabled: false,
    getAttribute: () => "Close command output",
    focus() {},
    click() {},
  };
  const output = layoutElement();
  const body = layoutElement({
    clientHeight: 100,
    scrollHeight: 260,
    contains: (element) => element === output,
  });
  const dialog = layoutElement({
    open: true,
    querySelector(selector) {
      return selector.includes("data-command-dialog-action") ? close : body;
    },
  });
  const owner = {
    isConnected: true,
    threadId: "thread/1",
    outputScrollport: output,
    dialog: () => dialog,
  };
  const action = commandDialog.actionHintScope.call(owner).targets[0];
  const surfaces = commandDialog.scrollSurfaceScope.call(owner).surfaces;

  assert.equal(action.id, "task-command:thread%2F1:close");
  assert.equal(action.isActionable(), true);
  assert.deepEqual(surfaces.map(({ id, axes, scrollport }) => ({
    id,
    axes,
    scrollport,
  })), [
    {
      id: "task-command:thread%2F1:body",
      axes: undefined,
      scrollport: body,
    },
    {
      id: "task-command:thread%2F1:output",
      axes: ["horizontal"],
      scrollport: output,
    },
  ]);
  assert.equal(surfaces[0].isEligible(), true);
  assert.equal(surfaces[1].isEligible(), true);
  owner.outputScrollport = layoutElement();
  assert.equal(surfaces[1].isEligible(), false);
  owner.outputScrollport = output;
  owner.threadId = "thread/2";
  assert.equal(action.isActionable(), false);
  assert.equal(surfaces[0].isEligible(), false);
  assert.equal(surfaces[1].isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
