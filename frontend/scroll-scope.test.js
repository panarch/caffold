import assert from "node:assert/strict";
import test from "node:test";

import {
  availableScrollAxes,
  emptyScrollSurfaceScope,
  hasHorizontalScrollOverflow,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
  mergeScrollSurfaceScopes,
  normalizeScrollAxes,
} from "./scroll-scope.js";

test("Scroll surface scopes compose direct owners in declaration order", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const mutationRoot = {};
  const resizeElement = {};
  const scrollRoot = {};
  const merged = mergeScrollSurfaceScopes(
    null,
    { surfaces: [first], mutationRoots: [mutationRoot] },
    {
      blocked: true,
      surfaces: [second],
      resizeElements: [resizeElement],
      scrollRoots: [scrollRoot],
    },
  );

  assert.deepEqual(merged, {
    blocked: true,
    surfaces: [first, second],
    mutationRoots: [mutationRoot],
    resizeElements: [resizeElement],
    scrollRoots: [scrollRoot],
  });
  assert.throws(
    () => mergeScrollSurfaceScopes({ surfaces: {} }),
    /scope surfaces must be an array/,
  );
  assert.notEqual(emptyScrollSurfaceScope().surfaces, emptyScrollSurfaceScope().surfaces);
});

test("Scroll geometry requires a layout box and more than one overflow pixel", () => {
  assert.equal(hasScrollLayoutBox({ getClientRects: () => [{}] }), true);
  assert.equal(hasScrollLayoutBox({ getClientRects: () => [] }), false);
  assert.equal(
    hasVerticalScrollOverflow({ clientHeight: 100, scrollHeight: 102 }),
    true,
  );
  assert.equal(
    hasVerticalScrollOverflow({ clientHeight: 100, scrollHeight: 101 }),
    false,
  );
  assert.equal(
    hasVerticalScrollOverflow({ clientHeight: 0, scrollHeight: 200 }),
    false,
  );
  assert.equal(
    hasHorizontalScrollOverflow({ clientWidth: 100, scrollWidth: 102 }),
    true,
  );
  assert.equal(
    hasHorizontalScrollOverflow({ clientWidth: 100, scrollWidth: 101 }),
    false,
  );
});

test("normalizes owner-declared axes and intersects exact current overflow", () => {
  assert.deepEqual(normalizeScrollAxes(), ["vertical"]);
  assert.deepEqual(normalizeScrollAxes(["horizontal", "vertical"]), [
    "vertical",
    "horizontal",
  ]);
  assert.equal(normalizeScrollAxes([]), null);
  assert.equal(normalizeScrollAxes(["depth"]), null);
  assert.equal(normalizeScrollAxes(["vertical", "vertical"]), null);
  assert.deepEqual(availableScrollAxes({
    clientHeight: 100,
    scrollHeight: 160,
    clientWidth: 100,
    scrollWidth: 101,
  }, ["vertical", "horizontal"]), ["vertical"]);
  assert.deepEqual(availableScrollAxes({
    clientHeight: 100,
    scrollHeight: 100,
    clientWidth: 100,
    scrollWidth: 160,
  }, ["vertical", "horizontal"]), ["horizontal"]);
  assert.equal(availableScrollAxes({}, []), null);
});
