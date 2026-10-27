import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./presentation.js");
const presentation = registry.element(
  "caffold-keyboard-navigation-presentation",
).prototype;
after(() => registry.restore());

test("draws and hands out every part one context shows its modes with", () => {
  const dialog = {};
  const hud = {};
  const selector = {};
  const owner = Object.assign(Object.create(presentation), {
    dialog: { value: dialog },
    hud: { value: hud },
    selector: { value: selector },
    performUpdate() {},
  });

  const drawn = templateHtml(owner.render());
  assert.match(drawn, /<caffold-action-hint-dialog/);
  assert.match(drawn, /<caffold-scroll-mode-hud/);
  assert.match(drawn, /<caffold-scroll-surface-selector/);
  assert.equal(owner.actionHintDialog(), dialog);
  assert.equal(owner.scrollModeHud(), hud);
  assert.equal(owner.scrollSurfaceSelector(), selector);
});
