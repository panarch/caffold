import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./loading-text.js");
const LoadingText = registry.element("caffold-loading-text");
after(() => registry.restore());

test("announces itself as a status once connected", () => {
  const attributes = new Map();
  // Its root and its drawing need a document; the role does not.
  const element = Object.assign(new LoadingText(), {
    renderRoot: {},
    enableUpdating() {},
    setAttribute: (name, value) => attributes.set(name, `${value}`),
  });
  element.connectedCallback();
  assert.equal(attributes.get("role"), "status");
});
