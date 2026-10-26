import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./image-preview-dialog.ts");
const ImageDialog = registry.element("caffold-task-image-preview-dialog");
const imageDialog = ImageDialog.prototype;
after(() => registry.restore());

test("keeps the retained image Close control as its only target", () => {
  const control = {
    disabled: false,
    getAttribute: () => "Close image preview",
    focus() {},
    click() {},
  };
  const dialog = {
    open: true,
    querySelector: () => control,
  };
  const owner = { isConnected: true, dialog };
  const scope = imageDialog.actionHintScope.call(owner);

  assert.equal(scope.targets.length, 1);
  assert.equal(scope.targets[0].id, "task-image-preview:close");
  assert.equal(scope.targets[0].isActionable(), true);
  dialog.querySelector = () => null;
  assert.equal(scope.targets[0].isActionable(), false);
});

test("says the picture is loading until it can be drawn, or that it cannot", () => {
  const loading = draw({ name: "diagram.png", src: "", view: "loading" });
  assert.match(loading, /<p data-task-image-preview-name>diagram.png<\/p>/);
  assert.match(loading, /data-task-image-preview-image alt="diagram.png" src="" \?hidden="true"/);
  assert.match(loading, /data-task-image-preview-loading \?hidden="false"/);
  assert.match(loading, /data-task-image-preview-unavailable \?hidden="true"/);

  const shown = draw({ name: "diagram.png", src: "blob:picture", view: "image" });
  assert.match(shown, /src="blob:picture" \?hidden="false"/);
  assert.match(shown, /data-task-image-preview-loading \?hidden="true"/);

  const unavailable = draw({ name: "diagram.png", src: "", view: "unavailable" });
  assert.match(unavailable, /data-task-image-preview-unavailable \?hidden="false"/);
});

function draw(state) {
  const dialog = Object.create(
    ImageDialog.prototype,
    Object.getOwnPropertyDescriptors(state),
  );
  return templateHtml(dialog.render()).replace(/\s+/g, " ");
}
