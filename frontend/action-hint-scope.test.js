import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "./action-hint-scope.js";

test("Action Hint scopes compose direct owners in declaration order", () => {
  const firstTarget = { id: "first" };
  const secondTarget = { id: "second" };
  const mutationRoot = {};
  const scrollRoot = {};
  const first = {
    targets: [firstTarget],
    mutationRoots: [mutationRoot],
  };
  const second = {
    blocked: true,
    targets: [secondTarget],
    scrollRoots: [scrollRoot],
  };

  const merged = mergeActionHintScopes(null, first, second);

  assert.deepEqual(merged, {
    blocked: true,
    targets: [firstTarget, secondTarget],
    mutationRoots: [mutationRoot],
    scrollRoots: [scrollRoot],
  });
  assert.notEqual(merged.targets, first.targets);
  first.targets.push({ id: "later" });
  assert.deepEqual(merged.targets, [firstTarget, secondTarget]);
});

test("Action Hint scope helpers return complete shapes and reject malformed lists", () => {
  const first = emptyActionHintScope();
  const second = emptyActionHintScope();

  assert.deepEqual(first, {
    blocked: false,
    targets: [],
    mutationRoots: [],
    scrollRoots: [],
  });
  assert.notEqual(first.targets, second.targets);
  assert.throws(
    () => mergeActionHintScopes({ targets: {} }),
    /scope targets must be an array/,
  );
  assert.equal(hasActionHintLayoutBox({ getClientRects: () => [{}] }), true);
  assert.equal(hasActionHintLayoutBox({ getClientRects: () => [] }), false);
  assert.equal(hasActionHintLayoutBox(null), false);
});
