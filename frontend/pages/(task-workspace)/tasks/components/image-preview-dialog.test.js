import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./image-preview-dialog.js");
const { ActionHints } = await import("#app/action-hints.js");
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");
const ImageDialog = registry.element("caffold-task-image-preview-dialog");
after(() => registry.restore());

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
  dialog.hints = new ActionHints(dialog);
  dialog.keyboard = new KeyboardContexts(dialog);
  return templateHtml(dialog.render()).replace(/\s+/g, " ");
}
