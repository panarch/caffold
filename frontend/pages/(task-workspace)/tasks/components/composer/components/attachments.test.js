import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./attachments.ts");
const Strip = registry.element("caffold-task-composer-attachments");
after(() => registry.restore());

function attachmentButton(action, id, label) {
  return {
    dataset: { attachmentAction: action, attachmentId: id },
    disabled: false,
    title: "",
    clicks: 0,
    getAttribute: (name) => (name === "aria-label" ? label : null),
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("offers each attachment's Preview and Remove under the Composer's ids", () => {
  const preview = attachmentButton("preview-image", "image-a", "Preview shot.png");
  const removeImage = attachmentButton("remove-image", "image-a", "Remove shot.png");
  const removeFile = attachmentButton("remove-file", "file-b", "Remove server.log");
  const controls = [preview, removeImage, removeFile];
  const owner = Object.create(Strip.prototype, {
    isConnected: { value: true, writable: true },
    attachments: {
      value: [{ id: "image-a" }, { id: "file-b" }],
      writable: true,
    },
    contains: { value: (control) => controls.includes(control) },
    querySelectorAll: {
      value(selector) {
        const action = /data-attachment-action="([^"]+)"/.exec(selector)[1];
        return controls.filter(({ dataset }) => dataset.attachmentAction === action);
      },
    },
  });

  const targets = owner.actionHintTargets({
    scopeId: "new",
    clipRoots: [{}],
  });

  assert.deepEqual(targets.map(({ id, label }) => ({ id, label })), [
    { id: "task-composer:new:preview-image:image-a", label: "Preview shot.png" },
    { id: "task-composer:new:remove-image:image-a", label: "Remove shot.png" },
    { id: "task-composer:new:remove-file:file-b", label: "Remove server.log" },
  ]);
  targets.forEach((target) => target.activate());
  assert.deepEqual(controls.map(({ clicks }) => clicks), [1, 1, 1]);

  owner.attachments = [{ id: "image-a" }];
  assert.equal(targets[2].isActionable(), false, "a removed attachment's key goes with it");
  assert.equal(targets[0].isActionable(), true);
  owner.isConnected = false;
  assert.equal(targets[0].isActionable(), false);
  assert.deepEqual(owner.actionHintTargets({}), []);
});
