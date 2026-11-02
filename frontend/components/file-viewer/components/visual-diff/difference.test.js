import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGED_COLOR,
  CHANNEL_TOLERANCE,
  differencePixels,
  formatChangedShare,
} from "./difference.js";

test("paints a pixel that moved past the tolerance and fades the rest", () => {
  const before = new Uint8ClampedArray([
    10, 10, 10, 255,
    0, 0, 0, 255,
    100, 100, 100, 255,
    50, 50, 50, 0,
  ]);
  const after = new Uint8ClampedArray([
    10 + CHANNEL_TOLERANCE, 10, 10, 255,
    0, 0, CHANNEL_TOLERANCE + 1, 255,
    100, 100, 100, 255 - CHANNEL_TOLERANCE - 1,
    50, 50, 50, 0,
  ]);
  const out = new Uint8ClampedArray(after.length);

  assert.equal(differencePixels(before, after, out), 2);
  const pixels = [0, 1, 2, 3].map((pixel) => [...out.slice(pixel * 4, pixel * 4 + 4)]);
  // 0.299 × 22 + 0.587 × 10 + 0.114 × 10, and 22% of full opacity.
  assert.deepEqual(pixels[0], [14, 14, 14, 56]);
  assert.deepEqual(pixels[1], [...CHANGED_COLOR, 255]);
  assert.deepEqual(pixels[2], [...CHANGED_COLOR, 255], "a change in opacity alone counts");
  assert.deepEqual(pixels[3], [50, 50, 50, 0], "a clear pixel stays clear");
});

test("says the changed share with one decimal, and a tiny change as one", () => {
  assert.equal(formatChangedShare(0, 100), "0.0%");
  assert.equal(formatChangedShare(1, 100_000), "< 0.1%");
  assert.equal(formatChangedShare(181, 1000), "18.1%");
  assert.equal(formatChangedShare(5, 5), "100.0%");
  assert.equal(formatChangedShare(0, 0), "0.0%");
});
