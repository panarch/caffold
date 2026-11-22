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

// A page already measured at its own size.
function page(width, height = width * 1.414) {
  return {
    element: { offsetWidth: width, offsetHeight: height, style: { zoom: "" } },
    width,
    height,
    scale: 1,
  };
}

function zoomingViewer(zoom, room, pageRecords) {
  return { zoom, room, clientWidth: room?.width ?? 0, pageRecords };
}

const FIT_WIDTH = { fit: "width" };
const FIT_PAGE = { fit: "page" };

test("lets go of the document shown and opens the file it is handed", () => {
  const { owner, opened } = drawingViewer();
  const file = Promise.resolve(new Blob(["bytes"]));

  owner.file = { file, newerCopy: false };
  docxDocument.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.renderState, "loading", "it says the file is loading until it is drawn");
  assert.deepEqual(opened, [{ generation: 5, file }], "the document shown before is let go of first");
});

test("lets go of the drawn pages when released", () => {
  const owner = { generation: 2, content: {}, pageRecords: [page(794)] };

  docxDocument.release.call(owner);

  assert.equal(owner.generation, 3);
  assert.equal(owner.content, null);
  assert.equal(owner.pageRecords, null);
});

test("treats a replaced generation or a detached viewer as stale", () => {
  assert.equal(docxDocument.isCurrent.call({ isConnected: true, generation: 3 }, 3), true);
  assert.equal(docxDocument.isCurrent.call({ isConnected: true, generation: 4 }, 3), false);
  assert.equal(docxDocument.isCurrent.call({ isConnected: false, generation: 3 }, 3), false);
});

test("Fit width zooms a page down to a narrower room and leaves a fitting page alone", () => {
  const a4 = page(794);
  const narrow = page(300);
  const owner = zoomingViewer(FIT_WIDTH, { width: 397, height: 500 }, [a4, narrow]);

  docxDocument.zoomPages.call(owner);

  assert.equal(a4.element.style.zoom, "0.5");
  assert.equal(a4.scale, 0.5);
  assert.equal(narrow.element.style.zoom, "");
  assert.equal(narrow.scale, 1);

  owner.room = { width: 1200, height: 500 };
  docxDocument.zoomPages.call(owner);

  assert.equal(a4.element.style.zoom, "", "a wide room leaves a page at its own size");
});

test("Fit page keeps each whole page within the room, page by page", () => {
  const portrait = page(794, 1123);
  const landscape = page(1123, 794);
  const owner = zoomingViewer(FIT_PAGE, { width: 900, height: 650 }, [portrait, landscape]);

  docxDocument.zoomPages.call(owner);

  assert.equal(portrait.scale, 650 / 1123, "a tall page fits the room's height");
  assert.equal(landscape.scale, 900 / 1123, "a wide page fits the room's width");
});

test("a percent zooms every page by the same share of its own size, past it too", () => {
  const portrait = page(794, 1123);
  const landscape = page(1123, 794);
  const owner = zoomingViewer({ percent: 150 }, { width: 900, height: 650 }, [portrait, landscape]);

  docxDocument.zoomPages.call(owner);

  assert.equal(portrait.element.style.zoom, "1.5");
  assert.equal(landscape.element.style.zoom, "1.5");
});

test("measures each page once, before any zoom applies, and zooms it at once", () => {
  const element = { offsetWidth: 794, offsetHeight: 1123, style: { zoom: "" } };
  const owner = {
    zoom: FIT_WIDTH,
    room: { width: 397, height: 500 },
    renderRoot: { querySelectorAll: () => [element] },
  };
  owner.zoomPages = () => docxDocument.zoomPages.call(owner);

  docxDocument.measurePages.call(owner);

  assert.equal(element.style.zoom, "0.5");
  Object.defineProperty(element, "offsetWidth", {
    get: () => assert.fail("a zoomed page must not be measured again"),
  });
  owner.room = { width: 794 / 4, height: 500 };
  docxDocument.zoomPages.call(owner);
  assert.equal(element.style.zoom, "0.25");
});

test("waits for the room to have a width before zooming pages", () => {
  const a4 = page(794);
  const owner = zoomingViewer(FIT_WIDTH, { width: 0, height: 0 }, [a4]);

  docxDocument.zoomPages.call(owner);

  assert.equal(a4.element.style.zoom, "");
});

test("zooms a drawn document's pages before it says it is drawn, and again for a new zoom or room", () => {
  const order = [];
  const owner = {
    renderState: "docx",
    dataset: {},
    measurePages: () => order.push("measure"),
    zoomPages: () => order.push("zoom"),
    dispatchEvent: (event) => order.push(`${event.type}:${event.detail}`),
  };

  docxDocument.updated.call(owner, new Map([["renderState", "loading"]]));

  assert.deepEqual(order, ["measure", "caffold:docx-document-state:docx"]);
  assert.equal(owner.dataset.renderState, "docx");

  for (const changed of ["zoom", "room"]) {
    order.length = 0;
    docxDocument.updated.call(owner, new Map([[changed, null]]));
    assert.deepEqual(order, ["zoom"], changed);
  }

  order.length = 0;
  owner.renderState = "loading";
  docxDocument.updated.call(owner, new Map([["renderState", "docx"]]));
  assert.deepEqual(order, ["caffold:docx-document-state:loading"]);
});

test("names the drawn pages in order and the zoom of each, and none before the document is drawn", () => {
  const first = page(794);
  const second = { ...page(794), scale: 0.5 };

  assert.deepEqual(
    docxDocument.pages.call({ pageRecords: [first, second] }),
    [first.element, second.element],
  );
  assert.equal(docxDocument.pageScale.call({ pageRecords: [first, second] }, 1), 0.5);
  assert.deepEqual(docxDocument.pages.call({ pageRecords: null }), []);
  assert.equal(docxDocument.pageScale.call({ pageRecords: null }, 0), null);
});
