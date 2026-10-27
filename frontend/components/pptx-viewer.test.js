import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pptx-viewer.js");
const pptxViewer = registry.element("caffold-pptx-viewer").prototype;
after(() => registry.restore());

// A viewer drawing a document, ready to be handed another file.
function drawingViewer() {
  const opened = [];
  return {
    opened,
    owner: {
      generation: 4,
      renderState: "pptx",
      release() {
        pptxViewer.release.call(this);
      },
      open(generation, file) {
        opened.push({ generation, file });
      },
    },
  };
}

function control(localName, attributes, text) {
  const values = new Map(Object.entries(attributes));
  return {
    localName,
    textContent: text,
    innerText: text,
    getAttribute: (name) => values.get(name) ?? null,
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    focus() {},
    click() {},
  };
}

function slide(index, controls) {
  return {
    dataset: { slideIndex: `${index}` },
    querySelectorAll: () => controls,
  };
}

function deckViewer(slides) {
  const controls = slides.flatMap((entry) => entry.querySelectorAll());
  const root = {
    querySelectorAll: () => slides,
    contains: (element) => controls.includes(element),
  };
  return {
    root,
    owner: {
      renderRoot: { id: "viewer-root" },
      mount: { shadowRoot: root },
      isConnected: true,
      hidden: false,
      renderState: "pptx",
    },
  };
}

test("lets go of the deck shown and opens the file it is handed", () => {
  const { owner, opened } = drawingViewer();
  const file = Promise.resolve(new Blob(["bytes"]));

  owner.file = { file, newerCopy: false };
  pptxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.renderState, "loading", "it says the file is loading until it is drawn");
  assert.deepEqual(opened, [{ generation: 5, file }], "the deck shown before is let go of first");
});

test("offers the links out of the deck and to other slides on the slides drawn now", () => {
  const report = control("a", {
    href: "https://example.com/report",
    target: "_blank",
    rel: "noopener noreferrer",
  }, "Quarterly report");
  const bookmark = control("a", { href: "#notes" }, "Notes");
  const jump = control("span", { role: "link", title: "Go to slide 3" }, "Appendix");
  const tooltip = control("span", { role: "link", title: "Back to the start" }, "Summary");
  const bare = control("span", { role: "link", title: "Go to slide 1" }, " ");
  // Whole shapes the renderer links, out of the deck and to another slide.
  const diagram = control("div", { role: "link", title: "https://example.com/diagram" }, "");
  const button = control("div", { role: "link", title: "mailto:team@example.com" }, "Write to us");
  const { owner, root } = deckViewer([
    slide(0, [report, bookmark]),
    slide(4, [jump, tooltip, bare, diagram, button]),
  ]);
  const fileViewer = { id: "file-viewer" };

  const scope = pptxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
    actions: { link: "link.open" },
    clipRoots: [fileViewer],
  });

  assert.deepEqual(scope.targets.map(({ id, label }) => ({ id, label })), [
    {
      id: "review:viewer:document:slide:0:link:0",
      label: "Open Quarterly report in a new tab",
    },
    {
      id: "review:viewer:document:slide:4:link:0",
      label: "Go to Appendix (slide 3)",
    },
    {
      id: "review:viewer:document:slide:4:link:1",
      label: "Go to Summary",
    },
    {
      id: "review:viewer:document:slide:4:link:2",
      label: "Go to slide 1",
    },
    {
      id: "review:viewer:document:slide:4:link:3",
      label: "Open https://example.com/diagram",
    },
    {
      id: "review:viewer:document:slide:4:link:4",
      label: "Open Write to us",
    },
  ]);
  assert.deepEqual(scope.targets[0].clipRoots, [owner, fileViewer]);
  // A slide drawn or released inside the deck's shadow root changes the
  // links, and so does the mount the viewer's own root draws.
  assert.deepEqual(scope.mutationRoots, [owner, owner.renderRoot, root]);
});

test("offers no links before the deck is drawn or without a link action", () => {
  const { owner } = deckViewer([
    slide(0, [control("a", { href: "https://example.com", target: "_blank" }, "Site")]),
  ]);

  assert.deepEqual(pptxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
  }).targets, []);
  owner.renderState = "loading";
  assert.deepEqual(pptxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
    actions: { link: "link.open" },
  }).targets, []);
});

test("stops watching slides and drawing them when released", () => {
  const events = [];
  const owner = {
    generation: 2,
    slideObserver: { disconnect: () => events.push("disconnect") },
    viewer: { destroy: () => events.push("destroy") },
    mount: {},
  };

  pptxViewer.release.call(owner);

  assert.deepEqual(events, ["disconnect", "destroy"]);
  assert.equal(owner.generation, 3);
  assert.equal(owner.slideObserver, null);
  assert.equal(owner.viewer, null);
  assert.equal(owner.mount, null);
});
