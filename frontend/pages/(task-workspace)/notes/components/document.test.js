import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./document.js");
const documentView = registry.element("caffold-note-document").prototype;
after(() => registry.restore());

function retainedDocument() {
  const preview = {
    scrollTop: 220,
    scrollLeft: 37,
    getScrollState() { return { top: this.scrollTop, left: this.scrollLeft }; },
  };
  return { parentElement: {}, isConnected: true, preview: () => preview };
}

test("the placement fallback restores both reading axes after a disconnecting move", () => {
  const view = retainedDocument();
  const parent = { insertBefore(element, target) {
    assert.equal(element, view);
    assert.equal(target, null, "a sibling in a different slot is not an insertion target");
    element.parentElement = this;
    element.preview().scrollTop = 0;
    element.preview().scrollLeft = 0;
  } };
  documentView.place.call(view, parent, { parentElement: {} });
  assert.deepEqual(view.preview().getScrollState(), { top: 220, left: 37 });
});

test("a connected retained document uses native moveBefore and stays untouched in its current slot", () => {
  const view = retainedDocument();
  let moves = 0;
  const parent = { moveBefore(element, target) {
    assert.equal(element, view);
    assert.equal(target, sibling);
    element.parentElement = this;
    moves += 1;
  }, insertBefore() { assert.fail("native move should preserve the component lifetime"); } };
  const sibling = { parentElement: parent };
  documentView.place.call(view, parent, sibling);
  documentView.place.call(view, parent, sibling);
  assert.equal(moves, 1);
  assert.deepEqual(view.preview().getScrollState(), { top: 220, left: 37 });
});
