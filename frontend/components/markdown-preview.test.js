import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown-preview.js");
const markdownPreview = registry.element("caffold-markdown-preview").prototype;
after(() => registry.restore());

test("provides its host as the retained Markdown scrollport", () => {
  const owner = {
    hidden: false,
    isConnected: true,
    clientHeight: 100,
    scrollHeight: 260,
    ensureRendered() {},
    getClientRects: () => [{}],
  };

  const scope = markdownPreview.scrollSurfaceScope.call(owner, {
    scopeId: "review:file:preview",
    label: "PLAN.md preview",
  });
  assert.equal(scope.surfaces[0].id, "review:file:preview:scroll");
  assert.equal(scope.surfaces[0].label, "PLAN.md preview");
  assert.equal(scope.surfaces[0].scrollport, owner);
  assert.equal(scope.surfaces[0].isEligible(), true);

  owner.scrollHeight = 101;
  assert.equal(scope.surfaces[0].isEligible(), false);
});
