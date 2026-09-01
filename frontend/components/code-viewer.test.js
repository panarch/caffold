import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./code-viewer.js");
const codeViewer = registry.element("caffold-code-viewer").prototype;
after(() => registry.restore());

test("provides only its retained overflowing code-lines element", () => {
  let current;
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 260,
    getClientRects: () => [{}],
  };
  current = scrollport;
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: () => current,
  };

  const scope = codeViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:file:source",
    label: "PLAN.md source",
  });
  assert.equal(scope.surfaces[0].id, "review:file:source:scroll");
  assert.equal(scope.surfaces[0].label, "PLAN.md source");
  assert.equal(scope.surfaces[0].isEligible(), true);

  current = null;
  assert.equal(scope.surfaces[0].isEligible(), false);
});
