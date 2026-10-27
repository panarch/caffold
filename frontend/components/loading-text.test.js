import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./loading-text.js");
const loadingText = registry.element("caffold-loading-text").prototype;
after(() => registry.restore());

test("announces itself as a status once connected", () => {
  const attributes = new Map();
  const element = {
    setAttribute: (name, value) => attributes.set(name, `${value}`),
  };
  loadingText.connectedCallback.call(element);
  assert.equal(attributes.get("role"), "status");
});
