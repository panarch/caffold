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

  assert.deepEqual(wedge(owner.fill.d), {
    fromCenter: true,
    arcs: [{ radius: 5.25, large: 0, share: 0.16 }],
  });
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

    assert.equal(owner.fill.d, "");
    assert.equal(owner.control.attributes["aria-label"], "Context usage: not reported yet");
    assert.equal(owner.popover.innerHTML, "<p>Not reported yet.</p>");
  }
});

test("a count past the window fills the pie and keeps the agent's numbers", () => {
  const owner = pie();

  contextUsage.setSnapshot.call(owner, { usedTokens: 210_000, windowTokens: 200_000 });

  assert.deepEqual(wedge(owner.fill.d), {
    fromCenter: false,
    arcs: [
      { radius: 5.25, large: 1, share: 0.5 },
      { radius: 5.25, large: 1, share: 0 },
    ],
  });
  assert.equal(owner.control.attributes["aria-label"], "Context usage: 105%");
  assert.equal(owner.fields.used.textContent, "210,000 tokens (105%)");
});

test("fills clockwise from twelve o'clock, the long way round past half", () => {
  for (const [usedTokens, arc] of [
    [6_000, { radius: 5.25, large: 0, share: 0.03 }],
    [100_000, { radius: 5.25, large: 0, share: 0.5 }],
    [160_000, { radius: 5.25, large: 1, share: 0.8 }],
  ]) {
    const owner = pie();

    contextUsage.setSnapshot.call(owner, { usedTokens, windowTokens: 200_000 });

    assert.deepEqual(wedge(owner.fill.d), { fromCenter: true, arcs: [arc] });
  }
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

// The wedge's outline: whether it starts at the center, and each arc's radius,
// size flag, and end as a share of a turn clockwise from twelve o'clock.
function wedge(d) {
  const arcs = Array.from(
    d.matchAll(/A([\d.]+) [\d.]+ 0 ([01]) 1 ([\d.]+) ([\d.]+)/g),
    ([, radius, large, x, y]) => {
      const turn = Math.atan2(Number(x) - 12, 12 - Number(y)) / (2 * Math.PI);
      return {
        radius: Number(radius),
        large: Number(large),
        share: Math.round(((turn + 1) % 1) * 100) / 100,
      };
    },
  );
  return { fromCenter: d.startsWith("M12 12L"), arcs };
}

function pie() {
  const fields = { used: { textContent: "" }, window: { textContent: "" } };
  const fill = {
    d: null,
    setAttribute(name, value) {
      assert.equal(name, "d");
      this.d = value;
    },
  };
  const button = {
    title: "",
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelector(selector) {
      return selector === ".task-context-usage-fill" ? fill : null;
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
    fill,
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
