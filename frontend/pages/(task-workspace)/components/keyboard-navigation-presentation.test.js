import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./keyboard-navigation-presentation.js");
const Presentation = registry.element(
  "caffold-keyboard-navigation-presentation",
);
after(() => registry.restore());

test("mounts and exposes only the shared context-local presentations", () => {
  const presentation = new Presentation();
  presentation.ensureRendered();
  assert.match(presentation.innerHTML, /caffold-action-hint-dialog/);
  assert.match(presentation.innerHTML, /caffold-scroll-mode-hud/);
  assert.doesNotMatch(presentation.innerHTML, /scroll-surface-selector/);

  const dialog = {};
  const hud = {};
  presentation.querySelector = (selector) => new Map([
    [":scope > caffold-action-hint-dialog", dialog],
    [":scope > caffold-scroll-mode-hud", hud],
  ]).get(selector) ?? null;
  assert.equal(presentation.actionHintDialog(), dialog);
  assert.equal(presentation.scrollModeHud(), hud);
});
