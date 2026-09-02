import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const keyboard = registry.element("caffold-settings-keyboard-page").prototype;
after(() => registry.restore());

test("describes the active Scroll to Action Hint switch", () => {
  const owner = {};
  keyboard.render.call(owner);
  assert.match(
    owner.innerHTML,
    /Once scrolling is active, press F to switch to available actions\./,
  );
});

test("provides only the exact overflowing keyboard settings scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: (selector) =>
      selector === ":scope > .settings-keyboard-scroll" ? scrollport : null,
  };

  assert.deepEqual(keyboard.actionHintScope.call(owner).targets, []);
  const scope = keyboard.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 100;
  assert.equal(scope.surfaces[0].isEligible(), false);
  owner.hidden = true;
  assert.deepEqual(keyboard.scrollSurfaceScope.call(owner).surfaces, []);
});

test("provides the enabled keyboard navigation switch as a disable action", () => {
  const scrollport = {};
  let control = keyboardSwitch();
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      if (selector === ":scope > .settings-keyboard-scroll") return scrollport;
      return selector === "input[data-action-hints-enabled]" ? control : null;
    },
  };

  const scope = keyboard.actionHintScope.call(owner);
  assert.equal(scope.targets.length, 1);
  assert.equal(
    scope.targets[0].id,
    "settings:keyboard:action-hints:disable",
  );
  assert.equal(scope.targets[0].controlKind, "switch");
  assert.equal(scope.targets[0].label, "Turn keyboard navigation off");
  scope.targets[0].activate();
  assert.equal(control.focused, 1);
  assert.equal(control.clicks, 1);

  control.checked = false;
  assert.equal(scope.targets[0].isActionable(), false);
  assert.deepEqual(keyboard.actionHintScope.call(owner).targets, []);
  control = keyboardSwitch();
  assert.equal(scope.targets[0].isActionable(), false);
});

function keyboardSwitch() {
  return {
    checked: true,
    disabled: false,
    hidden: false,
    focused: 0,
    clicks: 0,
    closest: () => null,
    getClientRects: () => [{}],
    focus() {
      this.focused += 1;
    },
    click() {
      this.clicks += 1;
    },
  };
}
