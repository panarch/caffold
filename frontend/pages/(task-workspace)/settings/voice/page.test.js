import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.ts");
const voicePage = registry.element("caffold-settings-voice-page").prototype;
after(() => registry.restore());

function control({ checked = false, hidden = false, disabled = false } = {}) {
  return {
    checked,
    hidden,
    disabled,
    getAttribute: () => null,
    getClientRects: () => [{}],
    closest: () => null,
    focus() {},
    click() {},
  };
}
