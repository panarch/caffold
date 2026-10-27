import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./docx-viewer.js");
const docxViewer = registry.element("caffold-docx-viewer").prototype;
after(() => registry.restore());

// A viewer drawing a document, ready to be handed another file.
function drawingViewer() {
  const opened = [];
  return {
    opened,
    owner: {
      generation: 4,
      renderState: "docx",
      release() {
        docxViewer.release.call(this);
      },
      open(generation, file) {
        opened.push({ generation, file });
      },
    },
  };
}

function page(offsetWidth) {
  return { element: { offsetWidth, style: { zoom: "" } }, width: 0 };
}

function fittingViewer(clientWidth, pages) {
  return {
    isConnected: true,
    generation: 2,
    mount: { clientWidth },
    pages,
    isCurrent(generation) {
      return docxViewer.isCurrent.call(this, generation);
    },
  };
}

test("lets go of the document shown and opens the file it is handed", () => {
  const { owner, opened } = drawingViewer();
  const file = Promise.resolve(new Blob(["bytes"]));

  owner.file = { file, newerCopy: false };
  docxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.renderState, "loading", "it says the file is loading until it is drawn");
  assert.deepEqual(opened, [{ generation: 5, file }], "the document shown before is let go of first");
});

test("stops fitting the document when released", () => {
  const events = [];
  const owner = {
    generation: 2,
    widthObserver: { disconnect: () => events.push("disconnect") },
    mount: {},
    pages: [page(794)],
  };

  docxViewer.release.call(owner);

  assert.deepEqual(events, ["disconnect"]);
  assert.equal(owner.generation, 3);
  assert.equal(owner.widthObserver, null);
  assert.equal(owner.mount, null);
  assert.equal(owner.pages, null);
});

test("treats a replaced generation or a detached viewer as stale", () => {
  assert.equal(docxViewer.isCurrent.call({ isConnected: true, generation: 3 }, 3), true);
  assert.equal(docxViewer.isCurrent.call({ isConnected: true, generation: 4 }, 3), false);
  assert.equal(docxViewer.isCurrent.call({ isConnected: false, generation: 3 }, 3), false);
});

test("zooms a page down to a narrower viewer and leaves a fitting page alone", () => {
  const a4 = page(794);
  const narrow = page(300);
  const owner = fittingViewer(397, [a4, narrow]);

  docxViewer.fitPages.call(owner, 2);

  assert.equal(a4.element.style.zoom, "0.5");
  assert.equal(narrow.element.style.zoom, "");

  owner.mount.clientWidth = 1200;
  docxViewer.fitPages.call(owner, 2);

  assert.equal(a4.element.style.zoom, "");
});

test("measures each page once, before any zoom applies", () => {
  const a4 = page(794);
  const owner = fittingViewer(397, [a4]);
  docxViewer.fitPages.call(owner, 2);
  Object.defineProperty(a4.element, "offsetWidth", {
    get: () => assert.fail("a zoomed page must not be measured again"),
  });

  owner.mount.clientWidth = 794 / 4;
  docxViewer.fitPages.call(owner, 2);

  assert.equal(a4.element.style.zoom, "0.25");
});

test("waits for the viewer to have a width before measuring pages", () => {
  const a4 = page(794);
  const owner = fittingViewer(0, [a4]);

  docxViewer.fitPages.call(owner, 2);

  assert.equal(a4.width, 0);
  assert.equal(a4.element.style.zoom, "");
});

test("ignores a width change from a replaced generation", () => {
  const a4 = page(794);
  const owner = fittingViewer(397, [a4]);

  docxViewer.fitPages.call(owner, 1);

  assert.equal(a4.element.style.zoom, "");
});
