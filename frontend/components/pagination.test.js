import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pagination.js");
const pagination = registry.element("caffold-pagination").prototype;
after(() => registry.restore());

test("combines the scopes its page buttons declare and watches its own button set", () => {
  const received = [];
  const button = (id) => ({
    actionHintScope(options) {
      received.push(options);
      return {
        blocked: false,
        targets: [{ id }],
        mutationRoots: [this],
        scrollRoots: [],
      };
    },
  });
  const previous = button("issues:page:page:previous:1");
  const next = button("issues:page:page:next:3");
  const owner = paginationWith({ previous, next });
  const options = { scopeId: "issues:page", actionId: "navigation.page", clipRoots: [] };

  const scope = owner.actionHintScope(options);

  assert.deepEqual(received, [options, options]);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "issues:page:page:previous:1",
    "issues:page:page:next:3",
  ]);
  assert.deepEqual(scope.mutationRoots, [owner, previous, next]);
});

// A drawn pagination whose own declarations are none and whose page buttons
// are the given ones, by kind.
function paginationWith(buttons) {
  const owner = Object.create(pagination);
  return Object.assign(owner, {
    hints: {
      scope: () => ({
        blocked: false,
        targets: [],
        mutationRoots: [owner],
        scrollRoots: [],
      }),
    },
    pageButtons: { get: (kind) => buttons[kind] },
  });
}
