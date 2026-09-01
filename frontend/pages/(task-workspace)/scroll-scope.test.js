import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
  mergeScrollSurfaceScopes,
  scrollContextScope,
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
});

test("Scroll context keeps its exact root and context-local HUD", () => {
  const root = {};
  const hud = {};
  const context = scrollContextScope({
    id: "workspace",
    kind: "workspace",
    root,
    hud,
    scope: { surfaces: [{ id: "task-list" }] },
  });

  assert.deepEqual(context, {
    id: "workspace",
    kind: "workspace",
    root,
    hud,
    blocked: false,
    surfaces: [{ id: "task-list" }],
    mutationRoots: [],
    resizeElements: [],
    scrollRoots: [],
  });
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
});
