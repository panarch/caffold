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
    body: () => null,
    scrollSurfaceRecords: [],
    getClientRects: () => [{}],
  };

  const scope = markdownPreview.scrollSurfaceScope.call(owner, {
    scopeId: "review:file:preview",
    label: "PLAN.md preview",
  });
  assert.equal(scope.surfaces[0].id, "review:file:preview:scroll");
  assert.equal(scope.surfaces[0].label, "PLAN.md preview");
  assert.equal(scope.surfaces[0].scrollport, owner);
  assert.deepEqual(scope.surfaces[0].axes, ["vertical", "horizontal"]);
  assert.equal(scope.surfaces[0].isEligible(), true);

  owner.scrollHeight = 101;
  assert.equal(scope.surfaces[0].isEligible(), true);
});

test("composes retained code and table scrollports with the preview host", () => {
  const code = layoutElement({ localName: "pre" });
  const table = layoutElement();
  const body = {
    contains: (element) => [code, table].includes(element),
  };
  const codeRecord = {
    kind: "code",
    ordinal: 1,
    label: "code block 1",
    scrollport: code,
  };
  const tableRecord = {
    kind: "table",
    ordinal: 1,
    label: "Markdown table 1",
    scrollport: table,
  };
  let current = true;
  const owner = layoutElement({
    dataset: { renderState: "markdown" },
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    body: () => body,
    scrollSurfaceRecords: [codeRecord, tableRecord],
  });

  const scope = markdownPreview.scrollSurfaceScope.call(owner, {
    scopeId: "review:file:preview",
    label: "PLAN.md preview",
    clipRoots: [{ id: "viewer" }],
    isCurrent: () => current,
  });

  assert.deepEqual(scope.surfaces.map(({ id, label, axes, scrollport }) => ({
    id,
    label,
    axes,
    scrollport,
  })), [
    {
      id: "review:file:preview:scroll",
      label: "PLAN.md preview",
      axes: ["vertical", "horizontal"],
      scrollport: owner,
    },
    {
      id: "review:file:preview:code:1",
      label: "PLAN.md preview code block 1",
      axes: ["horizontal"],
      scrollport: code,
    },
    {
      id: "review:file:preview:table:1",
      label: "PLAN.md preview Markdown table 1",
      axes: ["horizontal"],
      scrollport: table,
    },
  ]);
  assert.deepEqual(new Set(scope.scrollRoots), new Set([owner, code, table]));
  assert.equal(scope.surfaces[1].isEligible(), true);
  owner.scrollSurfaceRecords = [tableRecord];
  assert.equal(scope.surfaces[1].isEligible(), false);
  owner.scrollSurfaceRecords = [codeRecord, tableRecord];
  current = false;
  assert.equal(scope.surfaces[2].isEligible(), false);
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

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
