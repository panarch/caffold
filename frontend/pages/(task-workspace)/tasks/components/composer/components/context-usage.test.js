import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./context-usage.ts");
const ContextUsage = registry.element("caffold-task-context-usage");
after(() => registry.restore());

test("draws the agent's count as a filled share of the window with the numbers behind it", () => {
  const owner = pie();

  owner.setSnapshot({ usedTokens: 32_147, windowTokens: 200_000 });

  const drawn = drawing(owner);
  assert.deepEqual(wedge(drawn.d), {
    fromCenter: true,
    arcs: [{ radius: 5.25, large: 0, share: 0.16 }],
  });
  assert.equal(drawn.label, "Context usage: 16%");
  assert.equal(drawn.title, "Context usage: 16%");
  assert.match(drawn.popover, /<dt>Used<\/dt>[\s\S]*<dt>Window<\/dt>/);
  assert.equal(drawn.used, "32,147 tokens (16%)");
  assert.equal(drawn.window, "200,000 tokens");
});

test("says nothing is known until the agent has said", () => {
  for (const context of [
    null,
    {},
    { usedTokens: 10, windowTokens: 0 },
    { usedTokens: -1, windowTokens: 200_000 },
    { usedTokens: "many", windowTokens: 200_000 },
  ]) {
    const owner = pie({ usage: { usedTokens: 1, windowTokens: 2 } });

    owner.setSnapshot(context);

    const drawn = drawing(owner);
    assert.equal(drawn.d, "");
    assert.equal(drawn.label, "Context usage: not reported yet");
    assert.equal(drawn.popover, "<p>Not reported yet.</p>");
  }
});

test("a count past the window fills the pie and keeps the agent's numbers", () => {
  const owner = pie();

  owner.setSnapshot({ usedTokens: 210_000, windowTokens: 200_000 });

  const drawn = drawing(owner);
  assert.deepEqual(wedge(drawn.d), {
    fromCenter: false,
    arcs: [
      { radius: 5.25, large: 1, share: 0.5 },
      { radius: 5.25, large: 1, share: 0 },
    ],
  });
  assert.equal(drawn.label, "Context usage: 105%");
  assert.equal(drawn.used, "210,000 tokens (105%)");
});

test("fills clockwise from twelve o'clock, the long way round past half", () => {
  for (const [usedTokens, arc] of [
    [6_000, { radius: 5.25, large: 0, share: 0.03 }],
    [100_000, { radius: 5.25, large: 0, share: 0.5 }],
    [160_000, { radius: 5.25, large: 1, share: 0.8 }],
  ]) {
    const owner = pie();

    owner.setSnapshot({ usedTokens, windowTokens: 200_000 });

    assert.deepEqual(wedge(drawing(owner).d), { fromCenter: true, arcs: [arc] });
  }
});

test("a new count is drawn at once, and the same count draws nothing", () => {
  const owner = pie();
  owner.setSnapshot({ usedTokens: 32_147, windowTokens: 200_000 });
  assert.equal(owner.updates, 1);

  owner.setSnapshot({ usedTokens: 50_000, windowTokens: 200_000 });
  assert.equal(owner.updates, 2);
  assert.equal(drawing(owner).used, "50,000 tokens (25%)");

  owner.setSnapshot({ usedTokens: 50_000, windowTokens: 200_000 });
  assert.equal(owner.updates, 2);
});

test("offers the pie to Action Hints while it is shown", () => {
  const control = {
    getAttribute: (name) => (name === "aria-label" ? "Context usage: 16%" : null),
    getBoundingClientRect: () => ({ width: 28, height: 28 }),
    getClientRects: () => [{ width: 28, height: 28 }],
    focus() {},
    click() {},
  };
  const owner = pie({
    isConnected: true,
    hidden: false,
    querySelector: (selector) =>
      selector === ":scope > .task-context-usage-button" ? control : null,
  });

  const target = owner.actionHintTarget({ scopeId: "task:thread-a" });

  assert.equal(target.id, "task-composer:task:thread-a:context-usage");
  assert.equal(target.label, "Context usage: 16%");
  assert.equal(target.control, control);
  assert.equal(target.isActionable(), true);
  owner.hidden = true;
  assert.equal(target.isActionable(), false);
  assert.equal(owner.actionHintTarget({ scopeId: "task:thread-a" }), null);
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

// A pie whose drawing is its `render()` alone; each drawing it asks for is
// counted.
function pie(properties = {}) {
  return Object.create(ContextUsage.prototype, {
    ...Object.getOwnPropertyDescriptors({
      usage: null,
      popoverId: "task-context-usage-1",
      updates: 0,
      performUpdate() {
        this.updates += 1;
      },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

// What the pie draws: the wedge, the button's names, and the popover's rows.
function drawing(owner) {
  const html = templateHtml(owner.render());
  const popover = /popover="auto"[\s\S]*?>([\s\S]*)<\/div>\s*$/.exec(html)[1];
  const field = (name) =>
    new RegExp(`data-context-usage-field="${name}">([^<]*)<`).exec(html)?.[1];
  return {
    d: /class="task-context-usage-fill"\s+d="([^"]*)"/.exec(html)[1],
    label: /aria-label="([^"]*)"/.exec(html)[1],
    title: /title="([^"]*)"/.exec(html)[1],
    popover: popover.replace(/\s+</g, "<").replace(/>\s+/g, ">").trim(),
    used: field("used"),
    window: field("window"),
  };
}
