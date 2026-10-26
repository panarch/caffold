import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./copy-button.ts");
const copyButton = registry
  .element("caffold-task-assistant-message-copy-button")
  .prototype;
after(() => registry.restore());

function copyButtonHost(properties = {}) {
  return Object.create(copyButton, {
    ...Object.getOwnPropertyDescriptors({
      hidden: false,
      isConnected: true,
      generation: 0,
      copyState: "idle",
      text: "",
      clearFeedback() {},
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

test("retires a copy in flight when its message reports different text", () => {
  const host = copyButtonHost({ copyState: "copying", text: "current text" });
  const inFlight = host.generation;
  assert.equal(host.acceptsCompletion(inFlight), true);

  host.willUpdate(new Map([["text", "older text"]]));
  assert.equal(host.acceptsCompletion(inFlight), false);
  assert.equal(host.copyState, "idle");

  // Drawing a message that says the same thing leaves a copy alone.
  const current = host.generation;
  host.willUpdate(new Map([["hidden", true]]));
  assert.equal(host.acceptsCompletion(current), true);
});

test("refuses a completion that outlived its element", () => {
  const host = copyButtonHost({ generation: 3 });
  assert.equal(host.acceptsCompletion(3), true);
  host.isConnected = false;
  assert.equal(host.acceptsCompletion(3), false);
});
