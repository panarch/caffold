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

test("provides retained sanitized Shadow DOM links and table scroll roots", () => {
  const attributes = new Map([
    ["href", "https://github.com/example/repo"],
    ["target", "_blank"],
    ["rel", "noreferrer"],
  ]);
  const tableScrollRoot = {};
  const control = {
    innerText: "Repository",
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
      href: "https://github.com/example/repo",
      target: "_blank",
      rel: "noreferrer",
    },
  };
  const body = {
    contains: (element) => [control, tableScrollRoot].includes(element),
  };
  const shadowRoot = {
    querySelector: () => body,
  };
  const owner = {
    actionHintLinks: [record],
    hidden: false,
    isConnected: true,
    shadowRoot,
  };
  const scope = markdown.actionHintScope.call(owner, {
    scopeId: "github:issue:42:body",
  });

  assert.equal(scope.targets[0].id, "github:issue:42:body:link:1");
  assert.equal(scope.targets[0].label, "Open Repository in a new tab");
  assert.deepEqual(scope.mutationRoots, [owner, shadowRoot]);
  assert.deepEqual(scope.scrollRoots, [owner, tableScrollRoot]);
  assert.equal(scope.targets[0].isActionable(), true);
  attributes.set("target", "_self");
  assert.equal(scope.targets[0].isActionable(), false);
});
