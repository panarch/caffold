import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./code-viewer.js");
const viewer = registry.element("caffold-code-viewer").prototype;
after(() => registry.restore());

// A viewer whose rows, as tall as `heights`, scroll in a scroller on the page,
// or in one taken off it. The heights can change, as wrapping or a new width
// changes them.
function scrolledViewer({ heights = [20, 60, 20, 20], onPage = true } = {}) {
  const scroller = {
    scrollTop: 0,
    scrollLeft: 0,
    getClientRects: () => (onPage ? [{}] : []),
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const rows = heights.map((_, index) => ({
    dataset: {},
    get offsetTop() {
      return heights.slice(0, index).reduce((sum, height) => sum + height, 0);
    },
    getBoundingClientRect() {
      const top = 100 + this.offsetTop - scroller.scrollTop;
      return { top, bottom: top + heights[index], height: heights[index] };
    },
  }));
  const owner = elementStandIn(viewer, {
    scrollport: { value: scroller },
    table: { value: { children: rows } },
    readingScroll: null,
  });
  return { owner, scroller, heights };
}

test("records the row it is read at as it scrolls, and keeps that while it is off the page", () => {
  const { owner, scroller } = scrolledViewer();
  scroller.scrollTop = 50;
  scroller.scrollLeft = 12;

  viewer.recordReading.call(owner);
  const read = { anchor: { page: 1, fraction: 0.5 }, left: 12 };
  assert.deepEqual(owner.readingPosition(), read);

  scroller.getClientRects = () => [];
  scroller.scrollTop = 0;
  viewer.recordReading.call(owner);
  assert.deepEqual(owner.readingPosition(), read);
});

test("reads the place it is put at, which sends no scroll when it was there already", () => {
  const { owner, scroller } = scrolledViewer();
  owner.readingScroll = { anchor: { page: 3, fraction: 0 }, left: 40 };

  viewer.restorePosition.call(owner, { scroll: null });
  assert.deepEqual(owner.readingPosition(), { anchor: { page: 0, fraction: 0 }, left: 0 });

  const place = { anchor: { page: 1, fraction: 0.5 }, left: 5 };
  viewer.restorePosition.call(owner, { scroll: place });
  assert.equal(scroller.scrollTop, 20 + 30);
  assert.equal(scroller.scrollLeft, 5);
  assert.deepEqual(owner.readingPosition(), place);
});

test("keeps the row it reads at the top when wrapping or a new width changes the rows' heights", () => {
  const { owner, scroller, heights } = scrolledViewer();
  scroller.scrollTop = 50;
  viewer.recordReading.call(owner);

  heights.splice(0, heights.length, 40, 120, 40, 40);
  viewer.updated.call(owner, new Map([["wrap", false]]));
  assert.equal(scroller.scrollTop, 40 + 60);

  heights.splice(0, heights.length, 20, 30, 20, 20);
  viewer.keepReadingPlace.call(owner);
  assert.equal(scroller.scrollTop, 20 + 15);
});

test("a place it is handed off the page waits there until it comes back", () => {
  const { owner, scroller } = scrolledViewer({ onPage: false });
  const place = { anchor: { page: 2, fraction: 0.5 }, left: 0 };

  viewer.restorePosition.call(owner, { scroll: place });
  assert.equal(scroller.scrollTop, 0);
  assert.deepEqual(owner.readingPosition(), place);
  viewer.keepReadingPlace.call(owner);
  assert.equal(scroller.scrollTop, 0);

  scroller.getClientRects = () => [{}];
  viewer.keepReadingPlace.call(owner);
  assert.equal(scroller.scrollTop, 80 + 10);

  scroller.getClientRects = () => [];
  viewer.restorePosition.call(owner, { scroll: null });
  assert.equal(owner.readingPosition(), null);
});
