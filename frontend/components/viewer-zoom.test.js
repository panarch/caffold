import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasPixelRatio,
  readZoomPlace,
  returnToZoomPlace,
  ShownZoom,
  zoomScale,
} from "./viewer-zoom.js";

const A4 = { width: 794, height: 1123 };
const LANDSCAPE = { width: 1123, height: 794 };

test("Fit width fits a page to the room's width and never past its own size", () => {
  const fit = { fit: "width" };

  assert.equal(zoomScale(fit, A4, { width: 397, height: 100 }), 0.5);
  assert.equal(zoomScale(fit, A4, { width: 1600, height: 100 }), 1);
});

test("Fit page keeps the whole page within the room, and never past its own size", () => {
  const fit = { fit: "page" };
  const room = { width: 900, height: 650 };

  assert.equal(zoomScale(fit, A4, room), 650 / 1123, "a tall page fits the height");
  assert.equal(zoomScale(fit, LANDSCAPE, room), 900 / 1123, "a wide page fits the width");
  assert.equal(zoomScale(fit, A4, { width: 2000, height: 2000 }), 1);
});

test("a percent is that share of the page's own size, whatever the room", () => {
  assert.equal(zoomScale({ percent: 150 }, A4, { width: 10, height: 10 }), 1.5);
  assert.equal(zoomScale({ percent: 25 }, LANDSCAPE, { width: 5000, height: 5000 }), 0.25);
});

test("draws a canvas at the device's pixels, at most two for each CSS pixel", () => {
  assert.equal(canvasPixelRatio(794, 1123, 1), 1);
  assert.equal(canvasPixelRatio(794, 1123, 2), 2);
  assert.equal(canvasPixelRatio(794, 1123, 3), 2);
  assert.equal(canvasPixelRatio(794, 1123, 0), 1, "a browser that reports none draws one");
});

test("draws a page zoomed far in coarser, so its canvas stays within what an iPhone draws", () => {
  // An A4 page at 400% on a screen of two device pixels per CSS pixel.
  const width = 794 * 4;
  const height = 1123 * 4;
  const ratio = canvasPixelRatio(width, height, 2);

  assert.ok(ratio < 2);
  assert.ok(
    Math.round(width * ratio) * Math.round(height * ratio) <= 4096 * 4096,
    "each side rounded up still fits",
  );
});

test("says the scale it shows only when it changes, and again after it forgets", () => {
  const sent = [];
  const shown = new ShownZoom({ dispatchEvent: (event) => sent.push(event) });

  shown.report(0.5);
  shown.report(0.5);
  shown.report(null);
  shown.report(Number.NaN);
  shown.report(1.25);
  shown.forget();
  shown.report(1.25);

  assert.deepEqual(
    sent.map((event) => [event.type, event.detail.percent]),
    [
      ["caffold:viewer-zoom-shown", 50],
      ["caffold:viewer-zoom-shown", 125],
      ["caffold:viewer-zoom-shown", 125],
    ],
  );
});

// A scrollport 400 wide and 300 tall over content 1200 by 2000, scrolled to
// `left` and `top`, holding pages 1000 tall one below the other.
function scrollport({ left, top, pageCount = 2 }) {
  const port = {
    scrollLeft: left,
    scrollTop: top,
    clientWidth: 400,
    clientHeight: 300,
    scrollWidth: 1200,
    scrollHeight: 2000,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 0 }),
  };
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    getBoundingClientRect: () => {
      const pageTop = index * 1000 - port.scrollTop;
      return { top: pageTop, bottom: pageTop + 1000, height: 1000 };
    },
  }));
  return { port, pages };
}

test("keeps the page at the top and the middle across through a change of zoom", () => {
  const { port, pages } = scrollport({ left: 100, top: 1250 });

  const place = readZoomPlace(port, pages);
  assert.deepEqual(place.anchor, { page: 1, fraction: 0.25 });
  assert.equal(place.across, 300 / 1200);

  // Twice the size: pages 2000 tall, content twice as wide.
  port.scrollWidth = 2400;
  for (const [index, page] of pages.entries()) {
    page.getBoundingClientRect = () => {
      const pageTop = index * 2000 - port.scrollTop;
      return { top: pageTop, bottom: pageTop + 2000, height: 2000 };
    };
  }
  returnToZoomPlace(port, pages, place);

  assert.equal(port.scrollTop, 2000 + 0.25 * 2000);
  assert.equal(port.scrollLeft, 0.25 * 2400 - 200, "the middle across stays in the middle");
});

test("keeps the middle of a picture in the middle through a change of zoom", () => {
  const { port } = scrollport({ left: 400, top: 850 });

  const place = readZoomPlace(port, []);
  assert.equal(place.anchor, null);
  assert.equal(place.across, 0.5);
  assert.equal(place.down, 0.5);

  // Half the size.
  port.scrollWidth = 600;
  port.scrollHeight = 1000;
  returnToZoomPlace(port, [], place);

  assert.equal(port.scrollTop, 0.5 * 1000 - 150);
  assert.equal(port.scrollLeft, 0.5 * 600 - 200);
});
