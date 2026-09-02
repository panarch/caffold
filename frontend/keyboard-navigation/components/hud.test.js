import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./hud.js");
const hud = registry.element("caffold-scroll-mode-hud").prototype;
after(() => registry.restore());

test("advertises axis commands and the Action Hint switch in the active Scroll HUD", () => {
  const owner = {};
  hud.ensureRendered.call(owner);
  assert.match(owner.innerHTML, /data-scroll-mode-instructions/);
  assert.equal(owner.hidden, true);
});

test("shows, relabels, and closes one context-local Scroll presentation", () => {
  const label = { textContent: "" };
  const instructions = { textContent: "" };
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
        ["[data-scroll-mode-instructions]", instructions],
        [":scope > .scroll-mode-outline", outline],
        [":scope > .scroll-mode-status", status],
      ]).get(selector);
    },
  };

  assert.equal(hud.show.call(owner, {
    label: "Conversation",
    visibleRect: rect(25, 40, 225, 340),
    contextRect: rect(10, 20, 310, 220),
    availableAxes: ["vertical", "horizontal"],
  }), true);
  assert.equal(owner.hidden, false);
  assert.equal(label.textContent, "Scroll: Conversation");
  assert.equal(
    instructions.textContent,
    "J/K small · D/U half page · H/L small · F Action Hints · Escape exits",
  );
  assert.deepEqual(outline.style, {
    left: "25px",
    top: "40px",
    width: "200px",
    height: "300px",
  });
  assert.equal(status.style.left, "100px");
  assert.equal(status.style.top, "180px");
  assert.equal(status.style.maxWidth, "284px");

  hud.updateLabel.call(owner, "Longer task list label");
  assert.equal(label.textContent, "Scroll: Longer task list label");
  assert.equal(status.style.left, "70px");
  hud.close.call(owner);
  assert.equal(owner.hidden, true);
  assert.equal(owner.contextRect, null);
  assert.equal(label.textContent, "");
  assert.equal(instructions.textContent, "");
});

test("shows only commands for the captured axis", () => {
  const instructions = { textContent: "" };
  const owner = {
    hidden: true,
    ensureRendered() {},
    positionStatus: () => true,
    querySelector(selector) {
      return new Map([
        ["[data-scroll-mode-label]", { textContent: "" }],
        ["[data-scroll-mode-instructions]", instructions],
        [":scope > .scroll-mode-outline", { style: {} }],
      ]).get(selector);
    },
  };
  assert.equal(hud.show.call(owner, {
    label: "Wide code",
    visibleRect: rect(0, 0, 100, 100),
    contextRect: rect(0, 0, 100, 100),
    availableAxes: ["horizontal"],
  }), true);
  assert.equal(
    instructions.textContent,
    "H/L small · F Action Hints · Escape exits",
  );
  assert.equal(hud.show.call(owner, {
    label: "Conversation",
    visibleRect: rect(0, 0, 100, 100),
    contextRect: rect(0, 0, 100, 100),
    availableAxes: ["vertical"],
  }), true);
  assert.equal(
    instructions.textContent,
    "J/K small · D/U half page · F Action Hints · Escape exits",
  );
});

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
