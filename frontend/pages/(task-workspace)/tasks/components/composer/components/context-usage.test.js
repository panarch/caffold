import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./context-usage.js");
const contextUsage = registry.element("caffold-task-context-usage").prototype;
after(() => registry.restore());

test("draws the agent's count as a filled share of the window with the numbers behind it", () => {
  const owner = pie();

  contextUsage.setSnapshot.call(owner, { usedTokens: 32_147, windowTokens: 200_000 });

  assert.equal(owner.control.used, "16");
  assert.equal(owner.control.attributes["aria-label"], "Context usage: 16%");
  assert.equal(owner.control.title, "Context usage: 16%");
  assert.match(owner.popover.innerHTML, /<dt>Used<\/dt>[\s\S]*<dt>Window<\/dt>/);
  assert.equal(owner.fields.used.textContent, "32,147 tokens (16%)");
  assert.equal(owner.fields.window.textContent, "200,000 tokens");
});

test("says nothing is known until the agent has said", () => {
  for (const context of [
    null,
    {},
    { usedTokens: 10, windowTokens: 0 },
    { usedTokens: -1, windowTokens: 200_000 },
    { usedTokens: "many", windowTokens: 200_000 },
  ]) {
    const owner = pie();
    owner.context = { usedTokens: 1, windowTokens: 2 };

    contextUsage.setSnapshot.call(owner, context);

    assert.equal(owner.control.used, "0");
    assert.equal(owner.control.attributes["aria-label"], "Context usage: not reported yet");
    assert.equal(owner.popover.innerHTML, "<p>Not reported yet.</p>");
  }
});

test("a count past the window fills the pie and keeps the agent's numbers", () => {
  const owner = pie();

  contextUsage.setSnapshot.call(owner, { usedTokens: 210_000, windowTokens: 200_000 });

  assert.equal(owner.control.used, "100");
  assert.equal(owner.control.attributes["aria-label"], "Context usage: 105%");
  assert.equal(owner.fields.used.textContent, "210,000 tokens (105%)");
});

test("a new count changes the numbers in place, and the same count changes nothing", () => {
  const owner = pie();
  contextUsage.setSnapshot.call(owner, { usedTokens: 32_147, windowTokens: 200_000 });
  const rows = owner.popover.innerHTML;
  owner.popover.writes = 0;

  contextUsage.setSnapshot.call(owner, { usedTokens: 50_000, windowTokens: 200_000 });

  assert.equal(owner.popover.writes, 0, "the open popover keeps its rows");
  assert.equal(owner.popover.innerHTML, rows);
  assert.equal(owner.fields.used.textContent, "50,000 tokens (25%)");

  owner.patches = 0;
  contextUsage.setSnapshot.call(owner, { usedTokens: 50_000, windowTokens: 200_000 });
  assert.equal(owner.patches, 0);
});

test("offers the pie to Action Hints while it is shown", () => {
  const owner = pie();
  owner.isConnected = true;
  owner.hidden = false;
  owner.control.getAttribute = (name) => owner.control.attributes[name];
  owner.control.getBoundingClientRect = () => ({ width: 28, height: 28 });
  owner.control.getClientRects = () => [{ width: 28, height: 28 }];
  contextUsage.setSnapshot.call(owner, { usedTokens: 32_147, windowTokens: 200_000 });

  const target = contextUsage.actionHintTarget.call(owner, { scopeId: "task:thread-a" });

  assert.equal(target.id, "task-composer:task:thread-a:context-usage");
  assert.equal(target.label, "Context usage: 16%");
  assert.equal(target.control, owner.control);
  assert.equal(target.isActionable(), true);
  owner.hidden = true;
  assert.equal(target.isActionable(), false);
  assert.equal(contextUsage.actionHintTarget.call(owner, { scopeId: "task:thread-a" }), null);
});

function pie() {
  const fields = { used: { textContent: "" }, window: { textContent: "" } };
  const button = {
    used: "",
    title: "",
    attributes: {},
    style: {
      setProperty(name, value) {
        assert.equal(name, "--task-context-used");
        button.used = value;
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  let html = "";
  const popover = {
    writes: 0,
    get innerHTML() {
      return html.replace(/\s+</g, "<").replace(/>\s+/g, ">");
    },
    set innerHTML(value) {
      this.writes += 1;
      html = value;
    },
    querySelector(selector) {
      const field = /data-context-usage-field="(\w+)"/.exec(selector)?.[1];
      return html.includes(selector.slice(1, -1)) ? fields[field] : null;
    },
  };
  const owner = {
    context: null,
    renderedKnown: null,
    patches: 0,
    control: button,
    popover,
    fields,
    ensureRendered() {},
    querySelector(selector) {
      if (selector === ":scope > .task-context-usage-button") return button;
      if (selector === ":scope > .task-context-usage-popover") return popover;
      return null;
    },
    button: () => button,
    patch() {
      this.patches += 1;
      contextUsage.patch.call(this);
    },
  };
  return owner;
}
