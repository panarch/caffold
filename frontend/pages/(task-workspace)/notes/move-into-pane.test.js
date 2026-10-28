import assert from "node:assert/strict";
import test, { after } from "node:test";

const previousObserver = globalThis.ResizeObserver;
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    observers.push(this);
  }
  observe(element) {
    this.observed.push(element);
  }
  disconnect() {
    this.observed = [];
  }
};
const { moveIntoPane } = await import("./move-into-pane.js");
after(() => {
  globalThis.ResizeObserver = previousObserver;
});

// A view whose scroller loses its position when the view is inserted
// elsewhere, as a disconnecting move does.
function placedView({ shown = true } = {}) {
  const scroller = {
    scrollTop: 220,
    scrollLeft: 37,
    shown,
    getClientRects() {
      return this.shown ? [{}] : [];
    },
  };
  return { parentNode: null, scroller };
}

function pane() {
  return {
    targets: [],
    insertBefore(view, target) {
      view.parentNode = this;
      view.scroller.scrollTop = 0;
      view.scroller.scrollLeft = 0;
      this.targets.push(target);
    },
  };
}

test("inserts before a sibling only in the same pane and leaves a view already there alone", () => {
  const view = placedView();
  const destination = pane();
  const sibling = { parentNode: destination };

  moveIntoPane(view, destination, { parentNode: {} }, () => view.scroller);
  moveIntoPane(view, destination, sibling, () => view.scroller);

  assert.deepEqual(destination.targets, [null], "a sibling in another pane is not an insertion target");
  assert.equal(view.parentNode, destination);
});

test("returns both scroll axes at once when the scroller is shown in its new pane", () => {
  const view = placedView();

  moveIntoPane(view, pane(), null, () => view.scroller);

  assert.deepEqual([view.scroller.scrollTop, view.scroller.scrollLeft], [220, 37]);
});

test("returns the position a hidden scroller had once it is shown, across another move", () => {
  const view = placedView();
  const hiddenPane = pane();
  observers.length = 0;
  view.scroller.shown = false;

  moveIntoPane(view, hiddenPane, null, () => view.scroller);
  assert.equal(view.scroller.scrollTop, 0, "nothing returns while the pane is hidden");
  moveIntoPane(view, pane(), null, () => view.scroller);
  assert.equal(observers.length, 2);
  assert.deepEqual(observers[0].observed, [], "the first wait gives way to the second");

  view.scroller.shown = true;
  observers[1].callback();
  assert.deepEqual([view.scroller.scrollTop, view.scroller.scrollLeft], [220, 37]);
  assert.deepEqual(observers[1].observed, []);
});
