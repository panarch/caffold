import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown-preview.js");
const markdownPreview = registry.element("caffold-markdown-preview").prototype;
after(() => registry.restore());

test("adds the code blocks and tables drawn from the Markdown to its own surface", () => {
  const code = layoutElement({ localName: "pre" });
  const table = layoutElement();
  const body = {
    contains: (element) => [code, table].includes(element),
  };
  const viewer = { id: "viewer" };
  const pulls = [];
  const owner = elementStandIn(markdownPreview, {
    renderState: "markdown",
    body: { value: body },
    scrollSurfaceRecords: [
      { kind: "code", ordinal: 1, label: "code block 1", scrollport: code },
      { kind: "table", ordinal: 1, label: "Markdown table 1", scrollport: table },
    ],
    surfaces: {
      scope(pull) {
        pulls.push(pull);
        return { surfaces: [{ id: `${pull.scopeId}:scroll` }] };
      },
    },
  });

  const scope = owner.scrollSurfaceScope({
    scopeId: "review:file:preview",
    label: "PLAN.md preview",
    clipRoots: [viewer],
  });

  assert.deepEqual(pulls, [{
    scopeId: "review:file:preview",
    label: "PLAN.md preview",
    clipRoots: [viewer],
  }]);
  assert.equal(scope.surfaces[0].id, "review:file:preview:scroll");
  assert.deepEqual(scope.surfaces.slice(1).map(({ id, label, axes, scrollport, clipRoots }) => ({
    id,
    label,
    axes,
    scrollport,
    clipRoots,
  })), [
    {
      id: "review:file:preview:code:1",
      label: "PLAN.md preview code block 1",
      axes: ["horizontal"],
      scrollport: code,
      clipRoots: [owner, body, code, viewer],
    },
    {
      id: "review:file:preview:table:1",
      label: "PLAN.md preview Markdown table 1",
      axes: ["horizontal"],
      scrollport: table,
      clipRoots: [owner, body, table, viewer],
    },
  ]);
  assert.deepEqual(new Set(scope.scrollRoots), new Set([owner, code, table]));

  owner.renderState = "plain";
  assert.deepEqual(
    owner.scrollSurfaceScope({ scopeId: "review:file:preview" }).surfaces,
    [{ id: "review:file:preview:scroll" }],
  );
});

test("offers the links drawn from the Markdown, inside the tables that scroll them", () => {
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
  const owner = {
    actionHintLinks: [record],
    renderState: "markdown",
    body: { value: body },
  };
  const scope = markdownPreview.actionHintScope.call(owner, {
    scopeId: "review:file:preview",
    actions: { link: "link.open" },
  });

  assert.equal(scope.targets[0].id, "review:file:preview:link:1");
  assert.equal(scope.targets[0].actionId, "link.open");
  assert.equal(scope.targets[0].label, "Open Preview docs in a new tab");
  assert.deepEqual(scope.targets[0].clipRoots, [owner, body, tableScrollRoot]);
  assert.deepEqual(scope.scrollRoots, [owner, tableScrollRoot]);
  assert.deepEqual(
    markdownPreview.actionHintScope.call(owner, { scopeId: "review:file:preview" }).targets,
    [],
  );
});

test("lets go of every image it fetched and puts each back to loading", (context) => {
  const revoked = [];
  context.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const picture = (objectUrl) => {
    const removed = [];
    const image = { hidden: false, removeAttribute: (name) => removed.push(name) };
    const loading = { hidden: true };
    const slot = {
      querySelector: (selector) => selector === ":scope > img" ? image : loading,
    };
    return { slot, image, loading, removed, record: { fetching: new AbortController(), objectUrl } };
  };
  const drawn = picture("blob:drawn");
  const fetching = picture("");
  let disconnected = false;
  const owner = {
    imageObserver: { disconnect: () => { disconnected = true; } },
    fetchedImages: new Map([
      [drawn.slot, drawn.record],
      [fetching.slot, fetching.record],
    ]),
  };

  markdownPreview.releaseImages.call(owner);

  assert.equal(disconnected, true);
  assert.equal(drawn.record.fetching.signal.aborted, true);
  assert.equal(fetching.record.fetching.signal.aborted, true);
  assert.deepEqual(revoked, ["blob:drawn"]);
  for (const { image, loading, removed } of [drawn, fetching]) {
    assert.deepEqual(removed, ["src"]);
    assert.equal(image.hidden, true);
    assert.equal(loading.hidden, false);
  }
  assert.equal(owner.fetchedImages.size, 0);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
