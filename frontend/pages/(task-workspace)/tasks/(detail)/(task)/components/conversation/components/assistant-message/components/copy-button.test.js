import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./copy-button.js");
const copyButton = registry
  .element("caffold-task-assistant-message-copy-button")
  .prototype;
after(() => registry.restore());

function control(label = "Copy message") {
  return {
    attributes: new Map([["aria-label", label]]),
    clicks: 0,
    disabled: false,
    title: label,
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

function copyButtonHost(properties = {}) {
  return Object.assign(Object.create(copyButton), {
    connected: true,
    hidden: false,
    initialized: true,
    isConnected: true,
    generation: 0,
    copyState: "idle",
    text: "",
    patched: 0,
    ensureDom() {},
    clearFeedback() {},
    patchPresentation() {
      this.patched += 1;
    },
    ...properties,
  });
}

test("provides its retained button as the message's one Copy action", () => {
  const button = control();
  const host = copyButtonHost({ button: () => button });
  const message = { id: "message" };

  const scope = host.actionHintScope({
    scopeId: "message:a:copy-button",
    clipRoots: [message],
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "message:a:copy-button:copy",
  ]);
  assert.deepEqual(scope.mutationRoots, [host]);
  const [target] = scope.targets;
  assert.equal(target.label, "Copy message");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(button.clicks, 1);
});

test("withholds the action while copying, hidden, replaced, or disconnected", () => {
  const button = control();
  const host = copyButtonHost({ button: () => button });
  const scopeOf = () => host.actionHintScope({ scopeId: "message:a:copy-button" });
  const [target] = scopeOf().targets;

  button.attributes.set("aria-disabled", "true");
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scopeOf().targets, []);
  button.attributes.delete("aria-disabled");
  assert.equal(target.isActionable(), true);

  host.button = () => control();
  assert.equal(target.isActionable(), false);
  host.button = () => button;

  host.hidden = true;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scopeOf().targets, []);
  host.hidden = false;

  host.connected = false;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scopeOf().targets, []);
});

test("retires a copy in flight when its message reports different text", () => {
  const host = copyButtonHost({ copyState: "copying", text: "older text" });
  const inFlight = host.generation;
  assert.equal(host.acceptsCompletion(inFlight), true);

  host.setText("current text");
  assert.equal(host.acceptsCompletion(inFlight), false);
  assert.equal(host.copyState, "idle");
  assert.equal(host.patched, 1);

  // Redrawing a message that says the same thing leaves a copy alone.
  host.setText("current text");
  assert.equal(host.patched, 1);
  assert.equal(host.acceptsCompletion(host.generation), true);
});

test("refuses a completion that outlived its element", () => {
  const host = copyButtonHost({ generation: 3 });
  assert.equal(host.acceptsCompletion(3), true);
  host.isConnected = false;
  assert.equal(host.acceptsCompletion(3), false);
  host.isConnected = true;
  host.connected = false;
  assert.equal(host.acceptsCompletion(3), false);
});
