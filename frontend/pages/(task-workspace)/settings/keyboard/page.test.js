import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const keyboard = registry.element("caffold-settings-keyboard-page").prototype;
after(() => registry.restore());

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

  assert.equal(typeof keyboard.actionHintScope, "undefined");
  const scope = keyboard.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 100;
  assert.equal(scope.surfaces[0].isEligible(), false);
  owner.hidden = true;
  assert.deepEqual(keyboard.scrollSurfaceScope.call(owner).surfaces, []);
});
