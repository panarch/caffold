import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./diff-viewer.js");
const diffViewer = registry.element("caffold-diff-viewer").prototype;
after(() => registry.restore());

test("provides only its retained overflowing diff-lines element", () => {
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

  const scope = diffViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:file:diff",
    label: "PLAN.md diff",
  });
  assert.equal(scope.surfaces[0].id, "review:file:diff:scroll");
  assert.equal(scope.surfaces[0].label, "PLAN.md diff");
  assert.equal(scope.surfaces[0].isEligible(), true);

  current = null;
  assert.equal(scope.surfaces[0].isEligible(), false);
});
