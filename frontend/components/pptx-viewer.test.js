import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pptx-viewer.js");
const pptxViewer = registry.element("caffold-pptx-viewer").prototype;
after(() => registry.restore());

function loadedViewer(url, revision = 1700) {
  const opened = [];
  return {
    opened,
    owner: {
      initialized: true,
      generation: 4,
      url,
      revision,
      dataset: { renderState: "pptx" },
      ensureRendered() {},
      showMessage(renderState) {
        this.dataset.renderState = renderState;
      },
      release() {
        pptxViewer.release.call(this);
      },
      open(generation, requested) {
        opened.push(requested);
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
      mount: { shadowRoot: root },
      isConnected: true,
      hidden: false,
      dataset: { renderState: "pptx" },
    },
  };
}

test("keeps the open deck while its file is unchanged", () => {
  const { owner, opened } = loadedViewer("/api/document?path=deck.pptx");

  pptxViewer.setSource.call(owner, {
    url: "/api/document?path=deck.pptx",
    revision: 1700,
  });

  assert.deepEqual(opened, []);
  assert.equal(owner.dataset.renderState, "pptx");
});

test("reopens the deck when the file changed on disk or another file is selected", () => {
  const changed = loadedViewer("/api/document?path=deck.pptx");
  pptxViewer.setSource.call(changed.owner, {
    url: "/api/document?path=deck.pptx",
    revision: 1800,
  });
  assert.deepEqual(changed.opened, ["/api/document?path=deck.pptx"]);
  assert.equal(changed.owner.dataset.renderState, "loading");
  assert.equal(changed.owner.revision, 1800);

  const other = loadedViewer("/api/document?path=deck.pptx");
  pptxViewer.setSource.call(other.owner, {
    url: "/api/document?path=pitch.pptx",
    revision: 1700,
  });
  assert.deepEqual(other.opened, ["/api/document?path=pitch.pptx"]);
});

test("retries the same deck after a failed load", () => {
  const { owner, opened } = loadedViewer("/api/document?path=deck.pptx");
  owner.dataset.renderState = "error";

  pptxViewer.setSource.call(owner, {
    url: "/api/document?path=deck.pptx",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/document?path=deck.pptx"]);
});

test("publishes only the vertical axis of slides fitted to its width", () => {
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    getClientRects: () => [{}],
  };

  const scope = pptxViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer:pptx",
  });

  assert.equal(scope.surfaces.length, 1);
  assert.deepEqual(scope.surfaces[0].axes, ["vertical"]);
  assert.equal(scope.surfaces[0].scrollport, owner);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.hidden = true;
  assert.equal(scope.surfaces[0].isEligible(), false);
  assert.deepEqual(pptxViewer.scrollSurfaceScope.call(owner, {}).surfaces, []);
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
  let current = true;

  const scope = pptxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
    linkActionId: "link.open",
    clipRoots: [{ id: "file-viewer" }],
    isCurrent: () => current,
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
  // A slide drawn or released inside the deck's shadow root changes the links.
  assert.deepEqual(scope.mutationRoots, [owner, root]);
  assert.equal(scope.targets[1].isActionable(), true);
  current = false;
  assert.equal(scope.targets[1].isActionable(), false);
});

test("offers no links before the deck is drawn or without a link action", () => {
  const { owner } = deckViewer([
    slide(0, [control("a", { href: "https://example.com", target: "_blank" }, "Site")]),
  ]);

  assert.deepEqual(pptxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
  }).targets, []);
  owner.dataset.renderState = "loading";
  assert.deepEqual(pptxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
    linkActionId: "link.open",
  }).targets, []);
});

test("stops reading, watching slides, and drawing them when released", () => {
  const events = [];
  const owner = {
    generation: 2,
    url: "/api/document?path=deck.pptx",
    revision: 1700,
    reading: { abort: () => events.push("abort") },
    slideObserver: { disconnect: () => events.push("disconnect") },
    viewer: { destroy: () => events.push("destroy") },
    mount: {},
  };

  pptxViewer.release.call(owner);

  assert.deepEqual(events, ["abort", "disconnect", "destroy"]);
  assert.equal(owner.generation, 3);
  assert.equal(owner.url, null);
  assert.equal(owner.revision, null);
  assert.equal(owner.reading, null);
  assert.equal(owner.slideObserver, null);
  assert.equal(owner.viewer, null);
  assert.equal(owner.mount, null);
});
