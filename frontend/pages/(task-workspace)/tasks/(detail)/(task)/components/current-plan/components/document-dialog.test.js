import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./document-dialog.js");
const documentDialog = registry.element(
  "caffold-current-plan-document-dialog",
).prototype;
after(() => registry.restore());

test("provides its exact modal document context and preview scrollport", () => {
  const hud = { show() {}, close() {}, updateLabel() {} };
  const preview = {
    clientHeight: 300,
    scrollHeight: 900,
    hidden: false,
    getClientRects: () => [{}],
  };
  const dialog = {
    open: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      assert.equal(selector, ":scope > caffold-scroll-mode-hud");
      return hud;
    },
  };
  const owner = {
    current: { path: "task/PLAN.md", label: "Plan" },
    isConnected: true,
    dialog: () => dialog,
    preview: () => preview,
  };

  const [context] = documentDialog.keyboardNavigationContexts.call(owner);
  const surface = context.scroll.scope.surfaces[0];
  assert.equal(context.id, "current-plan-document:task/PLAN.md");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, dialog);
  assert.equal(context.scroll.hud, hud);
  assert.equal(surface.id, "current-plan:task/PLAN.md:preview");
  assert.equal(surface.label, "Plan document");
  assert.equal(surface.scrollport, preview);
  assert.equal(surface.isEligible(), true);
  preview.hidden = true;
  assert.equal(surface.isEligible(), false);
  preview.hidden = false;
  owner.current = { path: "task/CHECKLIST.md", label: "Checklist" };
  assert.equal(surface.isEligible(), false);
});
