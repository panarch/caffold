import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./diff-viewer.js");
const viewer = registry.element("caffold-diff-viewer").prototype;
after(() => registry.restore());

// A viewer whose rows scroll in a scroller on the page, or one taken off it.
function scrolledViewer({ onPage = true } = {}) {
  const scroller = {
    scrollTop: 480,
    scrollLeft: 12,
    getClientRects: () => (onPage ? [{}] : []),
  };
  const owner = elementStandIn(viewer, {
    scrollport: { value: scroller },
    table: { value: { children: [] } },
    readingScroll: null,
  });
  return { owner, scroller };
}

test("records where it is read as it scrolls, and keeps that while it is off the page", () => {
  const { owner, scroller } = scrolledViewer();

  viewer.recordReading.call(owner);
  assert.deepEqual(owner.readingPosition(), { top: 480, left: 12 });

  scroller.getClientRects = () => [];
  scroller.scrollTop = 0;
  viewer.recordReading.call(owner);
  assert.deepEqual(owner.readingPosition(), { top: 480, left: 12 });
});

test("reads the place it is put at, which sends no scroll when it was there already", () => {
  const { owner, scroller } = scrolledViewer();
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  owner.readingScroll = { top: 900, left: 40 };

  viewer.restorePosition.call(owner, { scroll: null });

  assert.deepEqual(owner.readingPosition(), { top: 0, left: 0 });

  viewer.restorePosition.call(owner, { scroll: { top: 300, left: 5 } });
  assert.deepEqual(owner.readingPosition(), { top: 300, left: 5 });
});
