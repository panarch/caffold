import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown.js");
const markdown = registry.element("caffold-task-markdown").prototype;
after(() => registry.restore());

test("merges only code-block providers mounted in the retained Markdown body", () => {
  const targets = [{ id: "wrap" }, { id: "copy" }];
  const blocks = targets.map((target) => ({
    actionHintScope: () => ({ targets: [target] }),
  }));
  const body = { querySelectorAll: () => blocks };
  const owner = {
    hidden: false,
    isConnected: true,
    dataset: { renderState: "markdown" },
    body: () => body,
  };
  assert.deepEqual(
    markdown.actionHintScope.call(owner, { scopeId: "message:a" }).targets,
    targets,
  );
  owner.dataset.renderState = "plain";
  assert.deepEqual(markdown.actionHintScope.call(owner, { scopeId: "message:a" }).targets, []);
});

test("provides only retained final links with table scroll dependencies", () => {
  const attributes = new Map([
    ["href", "https://example.com/docs"],
    ["target", "_blank"],
    ["rel", "noreferrer"],
  ]);
  const tableScrollRoot = {};
  const control = {
    innerText: "External docs",
    getAttribute: (name) => attributes.get(name) ?? null,
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    closest: () => tableScrollRoot,
    focus() {},
    click() {},
  };
  const record = {
    control,
    ordinal: 2,
    binding: {
      href: "https://example.com/docs",
      target: "_blank",
      rel: "noreferrer",
    },
  };
  const body = {
    contains: (element) => [control, tableScrollRoot].includes(element),
    querySelectorAll: () => [],
  };
  const owner = {
    actionHintLinks: [record],
    hidden: false,
    isConnected: true,
    dataset: { renderState: "markdown" },
    body: () => body,
  };
  const scope = markdown.actionHintScope.call(owner, {
    scopeId: "message:a",
    clipRoots: [{ id: "conversation" }],
  });

  assert.equal(scope.targets[0].id, "message:a:link:2");
  assert.equal(scope.targets[0].label, "Open External docs in a new tab");
  assert.deepEqual(scope.scrollRoots, [tableScrollRoot]);
  assert.deepEqual(scope.targets[0].clipRoots, [
    owner,
    body,
    tableScrollRoot,
    { id: "conversation" },
  ]);
  assert.equal(scope.targets[0].isActionable(), true);
  attributes.set("href", "https://example.com/changed");
  assert.equal(scope.targets[0].isActionable(), false);
  assert.deepEqual(
    markdown.actionHintScope.call(owner, { scopeId: "message:a" }).targets,
    [],
  );
});

test("merges exact retained table and code-block Scroll providers", () => {
  const table = layoutElement();
  const tableRecord = {
    kind: "table",
    label: "Markdown table 1",
    ordinal: 1,
    scrollport: table,
  };
  const codeSurface = { id: "message:a:code-block:1:scroll" };
  const code = {
    label: "JavaScript",
    scrollSurfaceScope(options) {
      this.options = options;
      return {
        surfaces: [codeSurface],
        mutationRoots: [this],
        resizeElements: [this],
        scrollRoots: [this],
      };
    },
  };
  const body = {
    contains: (element) => [table, code].includes(element),
  };
  let current = true;
  const owner = layoutElement({
    hidden: false,
    isConnected: true,
    dataset: { renderState: "markdown" },
    body: () => body,
    scrollSurfaceRecords: [tableRecord],
    scrollCodeBlocks: [code],
  });

  const scope = markdown.scrollSurfaceScope.call(owner, {
    scopeId: "message:a",
    clipRoots: [{ id: "conversation" }],
    isCurrent: () => current,
  });

  assert.deepEqual(scope.surfaces.map(({ id }) => id), [
    "message:a:table:1",
    codeSurface.id,
  ]);
  assert.deepEqual(scope.surfaces[0].axes, ["horizontal"]);
  assert.equal(scope.surfaces[0].scrollport, table);
  assert.equal(scope.surfaces[0].isEligible(), true);
  assert.equal(code.options.scopeId, "message:a:code-block:1");
  assert.equal(code.options.label, "JavaScript code block 1");
  assert.equal(code.options.isCurrent(), true);
  owner.scrollSurfaceRecords = [];
  assert.equal(scope.surfaces[0].isEligible(), false);
  owner.scrollSurfaceRecords = [tableRecord];
  current = false;
  assert.equal(code.options.isCurrent(), false);
});

test("provides a renderer-registered native progress code scrollport", () => {
  const code = layoutElement();
  const codeRecord = {
    kind: "code",
    label: "text code block 1",
    ordinal: 1,
    scrollport: code,
  };
  const body = { contains: (element) => element === code };
  const owner = layoutElement({
    hidden: false,
    isConnected: true,
    dataset: { renderState: "markdown" },
    body: () => body,
    scrollSurfaceRecords: [codeRecord],
    scrollCodeBlocks: [],
  });

  const scope = markdown.scrollSurfaceScope.call(owner, {
    scopeId: "message:progress",
  });

  assert.equal(scope.surfaces.length, 1);
  assert.equal(scope.surfaces[0].id, "message:progress:code:1");
  assert.equal(scope.surfaces[0].label, "text code block 1");
  assert.equal(scope.surfaces[0].scrollport, code);
  assert.deepEqual(scope.surfaces[0].axes, ["horizontal"]);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.scrollSurfaceRecords = [];
  assert.equal(scope.surfaces[0].isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
