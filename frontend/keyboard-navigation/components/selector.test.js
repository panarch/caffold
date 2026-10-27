import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
const previousButton = globalThis.HTMLButtonElement;
globalThis.Element = globalThis.HTMLElement;
globalThis.HTMLButtonElement = class TestButton extends globalThis.HTMLElement {};
await import("./selector.js");
const Selector = registry.element("caffold-scroll-surface-selector");
const selector = Selector.prototype;
const { DrawnRefs } = await import("../../components/drawn-refs.js");
after(() => {
  restoreGlobal("Element", previousElement);
  restoreGlobal("HTMLButtonElement", previousButton);
  registry.restore();
});

test("opens one modal selector, focuses it, and clears its frozen surfaces", () => {
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
  const owner = selectorOwner({
    dialog: { value: dialog },
    draw() {
      calls.push(["draw", this.input]);
    },
    positionBadges() {
      calls.push("position");
    },
  });
  const surfaces = [{ id: "task-list", code: "A" }];
  const viewport = rect(0, 0, 800, 600);

  selector.open.call(owner, surfaces, viewport);

  assert.notEqual(owner.surfaces, surfaces);
  assert.deepEqual(owner.surfaces, surfaces);
  assert.equal(owner.viewportRect, viewport);
  assert.deepEqual(calls, [
    ["draw", { buffer: "", matches: ["A"], status: "idle" }],
    "show-modal",
    "position",
    ["focus", { preventScroll: true }],
  ]);
  assert.equal(selector.ownsModal.call(owner, dialog), true);

  selector.close.call(owner);
  assert.equal(dialog.open, false);
  assert.deepEqual(owner.surfaces, []);
  assert.equal(owner.viewportRect, null);
});

test("keeps pinch gestures native while blocking background wheel and one-finger scroll", () => {
  const owner = new Selector();
  let prevented = 0;
  const preventDefault = () => {
    prevented += 1;
  };

  owner.wheel.handleEvent({ ctrlKey: false, metaKey: false, preventDefault });
  owner.wheel.handleEvent({ ctrlKey: true, metaKey: false, preventDefault });
  owner.touchMove.handleEvent({ touches: [{}], preventDefault });
  owner.touchMove.handleEvent({ touches: [{}, {}], preventDefault });

  assert.equal(prevented, 2);
  assert.equal(owner.wheel.passive, false);
  const button = new HTMLButtonElement();
  const shown = selectorOwner({
    dialog: { value: { contains: (element) => element === button } },
  });
  assert.equal(
    selector.allowsNativeActivation.call(shown, { key: "Enter", target: button }),
    true,
  );
  assert.equal(
    selector.allowsNativeActivation.call(shown, { key: "Escape", target: button }),
    false,
  );
});

test("shows only the regions whose codes still match what was typed", () => {
  const owner = selectorOwner({
    surfaces: [
      { code: "AA", label: "Conversation", visibleRect: rect(0, 0, 10, 10) },
      { code: "S", label: "Task list", visibleRect: rect(0, 0, 10, 10) },
    ],
  });

  selector.updateInput.call(owner, {
    buffer: "A",
    matches: ["AA"],
    status: "partial",
  });
  const typed = drawn(owner);
  assert.match(typed, /data-input-state="partial" data-input="A"/);
  assert.match(typed, /\?hidden="false" > <button type="button" class="scroll-surface-selector-badge" data-scroll-surface-code="AA"/);
  assert.match(typed, /\?hidden="true" > <button type="button" class="scroll-surface-selector-badge" data-scroll-surface-code="S"/);
  assert.match(typed, />Typed A<\/output/);

  selector.updateSurfaceLabels.call(owner, [{ code: "S", label: "Tasks" }]);
  assert.match(drawn(owner), /aria-label="S — Tasks"/);
});

test("stacks nested badge anchors without leaving the viewport", () => {
  const viewport = rect(0, 0, 200, 120);
  const surface = rect(4, 4, 196, 116);
  const badges = Object.fromEntries(
    ["A", "B"].map((code) => [
      code,
      { style: {}, getBoundingClientRect: () => rect(0, 0, 32, 24) },
    ]),
  );
  const owner = selectorOwner({
    badges: { get: (code) => badges[code] },
    surfaces: ["A", "B"].map((code) => ({ code, visibleRect: surface })),
    viewportRect: viewport,
  });

  selector.positionBadges.call(owner);

  assert.deepEqual(Object.values(badges).map(({ style }) => style), [
    { left: "0px", top: "0px" },
    { left: "0px", top: "28px" },
  ]);
});

// A selector with the given state, which draws only when a test asks.
function selectorOwner(state = {}) {
  const owner = Object.assign(Object.create(selector), {
    surfaces: [],
    labels: new Map(),
    viewportRect: null,
    input: { buffer: "", matches: [], status: "idle" },
    draw() {},
    ...state,
  });
  owner.badges ??= new DrawnRefs(owner);
  return owner;
}

function drawn(owner) {
  return templateHtml(owner.render()).replace(/\s+/g, " ");
}

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
