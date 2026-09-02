import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./presentation.js");
const Presentation = registry.element(
  "caffold-keyboard-navigation-presentation",
);
after(() => registry.restore());

test("mounts and exposes every shared context-local presentation", () => {
  const presentation = new Presentation();
  presentation.ensureRendered();
  assert.match(presentation.innerHTML, /caffold-action-hint-dialog/);
  assert.match(presentation.innerHTML, /caffold-scroll-mode-hud/);
  assert.match(presentation.innerHTML, /scroll-surface-selector/);

  const dialog = {};
  const hud = {};
  const selector = {};
  presentation.querySelector = (query) => new Map([
    [":scope > caffold-action-hint-dialog", dialog],
    [":scope > caffold-scroll-mode-hud", hud],
    [":scope > caffold-scroll-surface-selector", selector],
  ]).get(query) ?? null;
  assert.equal(presentation.actionHintDialog(), dialog);
  assert.equal(presentation.scrollModeHud(), hud);
  assert.equal(presentation.scrollSurfaceSelector(), selector);
});
