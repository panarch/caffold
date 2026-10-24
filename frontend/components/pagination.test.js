import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pagination.ts");
const pagination = registry.element("caffold-pagination").prototype;
after(() => registry.restore());

test("combines the scopes its page buttons provide and watches its own button set", () => {
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
  const owner = paginationWith([previous, next]);
  const options = { scopeId: "issues:page", actionId: "navigation.page", clipRoots: [] };

  const scope = owner.actionHintScope(options);

  assert.deepEqual(received, [options, options]);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "issues:page:page:previous:1",
    "issues:page:page:next:3",
  ]);
  assert.deepEqual(scope.mutationRoots, [owner, previous, next]);
});

test("provides nothing while hidden or outside an Action Hint scope", () => {
  const button = {
    actionHintScope() {
      throw new Error("a hidden pagination does not ask its buttons");
    },
  };

  assert.deepEqual(
    paginationWith([button], { hidden: true }).actionHintScope({ scopeId: "issues:page", actionId: "navigation.page" }).targets,
    [],
  );
  assert.deepEqual(paginationWith([button]).actionHintScope({}).targets, []);
});

function paginationWith(buttons, { hidden = false } = {}) {
  return Object.assign(Object.create(pagination), {
    hidden,
    querySelectorAll(selector) {
      assert.equal(selector, ":scope > .pagination-panel > caffold-pagination-button");
      return buttons;
    },
  });
}
