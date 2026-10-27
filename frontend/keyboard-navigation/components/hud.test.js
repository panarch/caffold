import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./hud.js");
const hud = registry.element("caffold-scroll-mode-hud").prototype;
after(() => registry.restore());

test("draws only a compact label and the keyboard shortcut affordance", () => {
  const drawn = templateHtml(
    hud.render.call({ label: "Conversation", outline: {}, status: {} }),
  );
  assert.match(drawn, /data-scroll-mode-label>Scroll: Conversation</);
  assert.match(drawn, /data-scroll-mode-shortcut-help/);
  assert.match(drawn, /Press question mark for keyboard shortcuts/);
  assert.doesNotMatch(drawn, /<button/);
});

test("shows, relabels, and closes at the surface's top-right corner", () => {
  const outline = { style: {} };
  const status = {
    style: {},
    getBoundingClientRect() {
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      const width = owner.label.includes("Longer") ? 180 : 120;
      return rect(left, top, left + width, top + 32);
    },
  };
  const owner = {
    hidden: true,
    label: "",
    outline: { value: outline },
    status: { value: status },
    draw() {},
    positionStatus: hud.positionStatus,
  };

  assert.equal(
    hud.show.call(owner, {
      label: "Conversation",
      visibleRect: rect(25, 40, 225, 340),
      contextRect: rect(10, 20, 310, 220),
    }),
    true,
  );
  assert.equal(owner.hidden, false);
  assert.equal(owner.label, "Conversation");
  assert.deepEqual(outline.style, {
    left: "25px",
    top: "40px",
    width: "200px",
    height: "300px",
  });
  assert.equal(status.style.left, "97px");
  assert.equal(status.style.top, "48px");
  assert.equal(status.style.maxWidth, "184px");

  hud.updateLabel.call(owner, "Longer task list label");
  assert.equal(owner.label, "Longer task list label");
  assert.equal(status.style.left, "37px");
  hud.close.call(owner);
  assert.equal(owner.hidden, true);
  assert.equal(owner.contextRect, null);
  assert.equal(owner.surfaceRect, null);
  assert.equal(owner.label, "");
});

test("rejects missing label or geometry without leaving a stale HUD", () => {
  let closes = 0;
  const owner = {
    close: () => {
      closes += 1;
    },
  };
  assert.equal(
    hud.show.call(owner, {
      label: "",
      visibleRect: rect(0, 0, 100, 100),
      contextRect: rect(0, 0, 100, 100),
    }),
    false,
  );
  assert.equal(closes, 1);
});

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
