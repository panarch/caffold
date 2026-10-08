import assert from "node:assert/strict";
import test from "node:test";

import {
  containsRange,
  coverMerges,
  trackOffsets,
  visibleTracks,
} from "./window.js";

test("sums the sizes of the tracks after the frozen ones", () => {
  assert.deepEqual([...trackOffsets([10, 20, 30])], [0, 10, 30, 60]);
  assert.deepEqual([...trackOffsets([10, 20, 30], 1)], [0, 20, 50]);
  assert.deepEqual([...trackOffsets([10, 20], 2)], [0]);
});

test("finds the tracks a viewport touches, as indices of the whole sheet", () => {
  const sizes = [10, 10, 10, 10, 10, 10];

  assert.deepEqual(visibleTracks(trackOffsets(sizes), 0, 15, 20), {
    first: 1,
    last: 3,
  });
  // Two frozen tracks: the scrolling part starts at the third.
  assert.deepEqual(visibleTracks(trackOffsets(sizes, 2), 2, 15, 20), {
    first: 3,
    last: 5,
  });
});

test("widens the tracks by the overscan without leaving the sheet", () => {
  const offsets = trackOffsets([10, 10, 10, 10, 10, 10]);

  assert.deepEqual(visibleTracks(offsets, 0, 15, 20, 1), { first: 0, last: 4 });
  assert.deepEqual(visibleTracks(offsets, 0, 15, 20, 10), { first: 0, last: 5 });
  assert.deepEqual(visibleTracks(offsets, 0, 500, 20), { first: 5, last: 5 });
});

test("starts past hidden tracks at the position they collapse into", () => {
  const offsets = trackOffsets([10, 0, 0, 10]);

  assert.deepEqual(visibleTracks(offsets, 0, 10, 5), { first: 3, last: 3 });
});

test("finds no tracks when everything is frozen", () => {
  assert.deepEqual(visibleTracks(trackOffsets([10, 10], 2), 2, 0, 100), {
    first: 2,
    last: 1,
  });
});

test("grows a range until every merge it touches lies inside", () => {
  const merges = [
    { top: 2, bottom: 6, left: 3, right: 5 },
    // Touches only the range the first merge grows into.
    { top: 0, bottom: 2, left: 5, right: 6 },
    { top: 20, bottom: 21, left: 0, right: 1 },
  ];

  assert.deepEqual(
    coverMerges({ top: 5, bottom: 10, left: 0, right: 3 }, merges),
    { top: 0, bottom: 10, left: 0, right: 6 },
  );
  assert.deepEqual(
    coverMerges({ top: 8, bottom: 10, left: 0, right: 3 }, merges),
    { top: 8, bottom: 10, left: 0, right: 3 },
  );
});

test("tells whether a drawn range already holds another", () => {
  const drawn = { top: 0, bottom: 10, left: 0, right: 5 };

  assert.equal(containsRange(drawn, { top: 2, bottom: 10, left: 1, right: 5 }), true);
  assert.equal(containsRange(drawn, { top: 2, bottom: 11, left: 1, right: 5 }), false);
  assert.equal(containsRange(null, { top: 0, bottom: 0, left: 0, right: 0 }), false);
});
