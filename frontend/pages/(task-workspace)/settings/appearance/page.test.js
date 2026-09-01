import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const appearance = registry.element("caffold-settings-appearance-page").prototype;
after(() => registry.restore());

function button(label) {
  return {
    disabled: false,
    hidden: false,
    textContent: label,
    title: "",
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides visible reset buttons and the exact settings scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const resetAll = button("Reset all");
  const resetTheme = button("Reset theme");
  const resetTypeface = button("Reset font");
  resetTypeface.hidden = true;
  const controls = new Map([
    ['button[data-action="reset-appearance"]', resetAll],
    ['button[data-action="reset-theme"]', resetTheme],
    ['button[data-action="reset-typeface"]', resetTypeface],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = appearance.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:appearance:reset-all",
    "settings:appearance:reset-theme",
  ]);
  assert.ok(scope.targets.every(({ actionId }) =>
    actionId === "button.activate"
  ));
  scope.targets[0].activate();
  assert.equal(resetAll.clicks, 1);

  controls.set('button[data-action="reset-appearance"]', button("New"));
  assert.equal(scope.targets[0].isActionable(), false);

  const scrollScope = appearance.scrollSurfaceScope.call(owner);
  assert.equal(scrollScope.surfaces[0].scrollport, scrollport);
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 100;
  assert.equal(scrollScope.surfaces[0].isEligible(), false);
});
