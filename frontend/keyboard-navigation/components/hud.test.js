import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./hud.js");
const hud = registry.element("caffold-scroll-mode-hud").prototype;
after(() => registry.restore());

test("renders only a compact label and keyboard shortcut affordance", () => {
  const owner = {};
  hud.ensureRendered.call(owner);
  assert.match(owner.innerHTML, /data-scroll-mode-label/);
  assert.match(owner.innerHTML, /data-scroll-mode-shortcut-help/);
  assert.match(owner.innerHTML, /Press question mark for keyboard shortcuts/);
  assert.doesNotMatch(owner.innerHTML, /<button/);
  assert.doesNotMatch(owner.innerHTML, /data-scroll-mode-instructions/);
  assert.equal(owner.hidden, true);
});

test("shows, relabels, and closes at the surface's top-right corner", () => {
  const label = { textContent: "" };
  const outline = { style: {} };
  const status = {
    style: {},
    getBoundingClientRect() {
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      const width = label.textContent.includes("Longer") ? 180 : 120;
      return rect(left, top, left + width, top + 32);
    },
  };
  const owner = {
    hidden: true,
    ensureRendered() {},
    positionStatus: hud.positionStatus,
    querySelector(selector) {
      return new Map([
        ["[data-scroll-mode-label]", label],
        [":scope > .scroll-mode-outline", outline],
        [":scope > .scroll-mode-status", status],
      ]).get(selector);
    },
  };

  assert.equal(hud.show.call(owner, {
    label: "Conversation",
    visibleRect: rect(25, 40, 225, 340),
    contextRect: rect(10, 20, 310, 220),
  }), true);
  assert.equal(owner.hidden, false);
  assert.equal(label.textContent, "Scroll: Conversation");
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
  assert.equal(label.textContent, "Scroll: Longer task list label");
  assert.equal(status.style.left, "37px");
  hud.close.call(owner);
  assert.equal(owner.hidden, true);
  assert.equal(owner.contextRect, null);
  assert.equal(owner.surfaceRect, null);
  assert.equal(label.textContent, "");
});

test("rejects missing label or geometry without leaving a stale HUD", () => {
  let closes = 0;
  const owner = {
    ensureRendered() {},
    close: () => {
      closes += 1;
    },
  };
  assert.equal(hud.show.call(owner, {
    label: "",
    visibleRect: rect(0, 0, 100, 100),
    contextRect: rect(0, 0, 100, 100),
  }), false);
  assert.equal(closes, 1);
});

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
