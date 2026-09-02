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

test("provides retained final links through its own scroll boundary", () => {
  const attributes = new Map([
    ["href", "https://example.com/preview"],
    ["target", "_blank"],
    ["rel", "noreferrer"],
  ]);
  const tableScrollRoot = {};
  const control = {
    innerText: "Preview docs",
    getAttribute: (name) => attributes.get(name) ?? null,
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    closest: () => tableScrollRoot,
    focus() {},
    click() {},
  };
  const record = {
    control,
    ordinal: 1,
    binding: {
      href: "https://example.com/preview",
      target: "_blank",
      rel: "noreferrer",
    },
  };
  const body = {
    contains: (element) => [control, tableScrollRoot].includes(element),
  };
  let current = true;
  const owner = {
    actionHintLinks: [record],
    dataset: { renderState: "markdown" },
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    body: () => body,
  };
  const scope = markdownPreview.actionHintScope.call(owner, {
    scopeId: "review:file:preview",
    linkActionId: "link.open",
    isCurrent: () => current,
  });

  assert.equal(scope.targets[0].id, "review:file:preview:link:1");
  assert.equal(scope.targets[0].actionId, "link.open");
  assert.equal(scope.targets[0].label, "Open Preview docs in a new tab");
  assert.deepEqual(scope.scrollRoots, [owner, tableScrollRoot]);
  assert.equal(scope.targets[0].isActionable(), true);
  current = false;
  assert.equal(scope.targets[0].isActionable(), false);
});
