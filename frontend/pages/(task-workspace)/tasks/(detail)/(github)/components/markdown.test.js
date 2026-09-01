import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown.js");
const markdown = registry.element("caffold-github-markdown").prototype;
after(() => registry.restore());

test("provides the Issue Markdown host without inspecting Shadow DOM", () => {
  const shadowRoot = {};
  const owner = {
    hidden: false,
    isConnected: true,
    shadowRoot,
    clientHeight: 100,
    scrollHeight: 320,
    getClientRects: () => [{}],
  };
  let current = true;
  const scope = markdown.scrollSurfaceScope.call(owner, {
    scopeId: "github:issue:42:body",
    isCurrent: () => current,
  });
  assert.equal(scope.surfaces[0].scrollport, owner);
  assert.deepEqual(scope.mutationRoots, [owner, shadowRoot]);
  assert.equal(scope.surfaces[0].isEligible(), true);
  current = false;
  assert.equal(scope.surfaces[0].isEligible(), false);
});
