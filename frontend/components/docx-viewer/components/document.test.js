import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./document.js");
const docxDocument = registry.element("caffold-docx-document").prototype;
after(() => registry.restore());

// A viewer drawing a document, ready to be handed another file.
function drawingViewer() {
  const opened = [];
  return {
    opened,
    owner: {
      isConnected: true,
      generation: 4,
      renderState: "docx",
      release() {
        docxDocument.release.call(this);
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

function fittingViewer(clientWidth, pageRecords) {
  return {
    isConnected: true,
    generation: 2,
    clientWidth,
    pageRecords,
    isCurrent(generation) {
      return docxDocument.isCurrent.call(this, generation);
    },
  };
}

test("lets go of the document shown and opens the file it is handed", () => {
  const { owner, opened } = drawingViewer();
  const file = Promise.resolve(new Blob(["bytes"]));

  owner.file = { file, newerCopy: false };
  docxDocument.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.renderState, "loading", "it says the file is loading until it is drawn");
  assert.deepEqual(opened, [{ generation: 5, file }], "the document shown before is let go of first");
});

test("stops fitting the document when released", () => {
  const events = [];
  const owner = {
    generation: 2,
    widthObserver: { disconnect: () => events.push("disconnect") },
    content: {},
    pageRecords: [page(794)],
  };

  docxDocument.release.call(owner);

  assert.deepEqual(events, ["disconnect"]);
  assert.equal(owner.generation, 3);
  assert.equal(owner.widthObserver, null);
  assert.equal(owner.content, null);
  assert.equal(owner.pageRecords, null);
});

test("treats a replaced generation or a detached viewer as stale", () => {
  assert.equal(docxDocument.isCurrent.call({ isConnected: true, generation: 3 }, 3), true);
  assert.equal(docxDocument.isCurrent.call({ isConnected: true, generation: 4 }, 3), false);
  assert.equal(docxDocument.isCurrent.call({ isConnected: false, generation: 3 }, 3), false);
});

test("zooms a page down to a narrower viewer and leaves a fitting page alone", () => {
  const a4 = page(794);
  const narrow = page(300);
  const owner = fittingViewer(397, [a4, narrow]);

  docxDocument.fitPages.call(owner, 2);

  assert.equal(a4.element.style.zoom, "0.5");
  assert.equal(narrow.element.style.zoom, "");

  owner.clientWidth = 1200;
  docxDocument.fitPages.call(owner, 2);

  assert.equal(a4.element.style.zoom, "");
});

test("measures each page once, before any zoom applies", () => {
  const a4 = page(794);
  const owner = fittingViewer(397, [a4]);
  docxDocument.fitPages.call(owner, 2);
  Object.defineProperty(a4.element, "offsetWidth", {
    get: () => assert.fail("a zoomed page must not be measured again"),
  });

  owner.clientWidth = 794 / 4;
  docxDocument.fitPages.call(owner, 2);

  assert.equal(a4.element.style.zoom, "0.25");
});

test("waits for the viewer to have a width before measuring pages", () => {
  const a4 = page(794);
  const owner = fittingViewer(0, [a4]);

  docxDocument.fitPages.call(owner, 2);

  assert.equal(a4.width, 0);
  assert.equal(a4.element.style.zoom, "");
});

test("ignores a width change from a replaced generation", () => {
  const a4 = page(794);
  const owner = fittingViewer(397, [a4]);

  docxDocument.fitPages.call(owner, 1);

  assert.equal(a4.element.style.zoom, "");
});

test("fits a drawn document's pages before it says the document is drawn", () => {
  const order = [];
  const owner = {
    renderState: "docx",
    dataset: {},
    fitDrawnPages: () => order.push("fit"),
    dispatchEvent: (event) => order.push(`${event.type}:${event.detail}`),
  };

  docxDocument.updated.call(owner, new Map([["renderState", "loading"]]));

  assert.deepEqual(order, ["fit", "caffold:docx-document-state:docx"]);
  assert.equal(owner.dataset.renderState, "docx");

  order.length = 0;
  owner.renderState = "loading";
  docxDocument.updated.call(owner, new Map([["renderState", "docx"]]));
  assert.deepEqual(order, ["caffold:docx-document-state:loading"]);
});

test("names the drawn pages in order, and none before the document is drawn", () => {
  const first = page(794);
  const second = page(794);

  assert.deepEqual(
    docxDocument.pages.call({ pageRecords: [first, second] }),
    [first.element, second.element],
  );
  assert.deepEqual(docxDocument.pages.call({ pageRecords: null }), []);
});
