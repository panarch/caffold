import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./item.js");
const item = registry.element("caffold-settings-navigator-item").prototype;
after(() => registry.restore());

const KEYBOARD = { section: "keyboard", label: "Keyboard", icon: "Keyboard" };

function control() {
  return {
    disabled: false,
    getAttribute: () => null,
    toggleAttribute() {},
    focus() {},
    click() {},
  };
}

function itemHost(entry, button = control()) {
  return elementStandIn(item, {
    button,
    entry,
    selected: false,
    updateAvailable: false,
    reloadReady: false,
    isConnected: true,
  });
}

test("asks to open its section when its own button is clicked", () => {
  const host = itemHost(KEYBOARD);
  const events = [];
  host.dispatchEvent = (event) => events.push(event);

  host.open();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:settings-navigator-intent");
  assert.equal(events[0].bubbles, true);
  assert.deepEqual(events[0].detail, { section: "keyboard" });
});
