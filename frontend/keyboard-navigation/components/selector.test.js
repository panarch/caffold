import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
const previousButton = globalThis.HTMLButtonElement;
globalThis.Element = globalThis.HTMLElement;
globalThis.HTMLButtonElement = class TestButton extends globalThis.HTMLElement {};
await import("./selector.js");
const selector = registry.element("caffold-scroll-surface-selector").prototype;
after(() => {
  restoreGlobal("Element", previousElement);
  restoreGlobal("HTMLButtonElement", previousButton);
  registry.restore();
});

test("opens one modal selector, focuses it, and clears its frozen presentation", () => {
  const calls = [];
  const dialog = {
    open: false,
    showModal() {
      this.open = true;
      calls.push("show-modal");
    },
    focus(options) {
      calls.push(["focus", options]);
    },
    close() {
      this.open = false;
      calls.push("close");
    },
  };
  const owner = {
    dialog,
    surfaces: [],
    viewportRect: null,
    ensureRendered() {},
    renderRegions() {
      calls.push("render");
    },
    updateInput(progression) {
      calls.push(["input", progression]);
    },
    positionBadges() {
      calls.push("position");
    },
  };
  const surfaces = [{ id: "task-list", code: "A" }];
  const viewport = rect(0, 0, 800, 600);

  selector.open.call(owner, surfaces, viewport);

  assert.notEqual(owner.surfaces, surfaces);
  assert.deepEqual(owner.surfaces, surfaces);
  assert.equal(owner.viewportRect, viewport);
  assert.deepEqual(calls, [
    "render",
    ["input", { buffer: "", matches: ["A"], status: "idle" }],
    "show-modal",
    "position",
    ["focus", { preventScroll: true }],
  ]);
  assert.equal(selector.ownsModal.call(owner, dialog), true);

  selector.close.call(owner);
  assert.equal(dialog.open, false);
  assert.deepEqual(owner.surfaces, []);
  assert.equal(owner.viewportRect, null);
  assert.equal(calls.at(-1), "close");
});

test("keeps pinch gestures native while blocking background wheel and one-finger scroll", () => {
  const owner = {};
  selector.ensureState.call(owner);
  let prevented = 0;
  const preventDefault = () => {
    prevented += 1;
  };

  owner.boundWheel({ ctrlKey: false, metaKey: false, preventDefault });
  owner.boundWheel({ ctrlKey: true, metaKey: false, preventDefault });
  owner.boundTouchMove({ touches: [{}], preventDefault });
  owner.boundTouchMove({ touches: [{}, {}], preventDefault });

  assert.equal(prevented, 2);
  const button = new HTMLButtonElement();
  owner.dialog = { contains: (element) => element === button };
  assert.equal(
    selector.allowsNativeActivation.call(owner, {
      key: "Enter",
      target: button,
    }),
    true,
  );
  assert.equal(
    selector.allowsNativeActivation.call(owner, {
      key: "Escape",
      target: button,
    }),
    false,
  );
});

test("positions instructions inside the captured visual viewport", () => {
  const instructions = {
    style: {},
    getBoundingClientRect: () => rect(388, 750, 892, 788),
  };
  const owner = {
    viewportRect: rect(0, 0, 1024, 640),
    dialog: {
      querySelector(selector) {
        assert.equal(
          selector,
          ":scope > .scroll-surface-selector-instructions",
        );
        return instructions;
      },
    },
  };

  selector.positionInstructions.call(owner);

  assert.deepEqual(instructions.style, {
    right: "auto",
    bottom: "auto",
    left: "260px",
    top: "594px",
    transform: "none",
  });
});

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
