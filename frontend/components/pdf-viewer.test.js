import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pdf-viewer.ts");
const pdfViewer = registry.element("caffold-pdf-viewer").prototype;
after(() => registry.restore());

// A viewer drawing a document, ready to be handed another file.
function drawingViewer() {
  const opened = [];
  return {
    opened,
    owner: {
      generation: 4,
      renderState: "pdf",
      release() {
        pdfViewer.release.call(this);
      },
      open(generation, file) {
        opened.push({ generation, file });
      },
    },
  };
}

test("lets go of the document shown and opens the file it is handed", () => {
  const { owner, opened } = drawingViewer();
  const file = Promise.resolve(new Blob(["bytes"]));

  owner.file = { file, newerCopy: false };
  pdfViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.renderState, "loading", "it says the file is loading until it is drawn");
  assert.deepEqual(opened, [{ generation: 5, file }], "the document shown before is let go of first");
});

test("publishes only the axis a scaled page can overflow", () => {
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
  };

  const scope = pdfViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer:pdf",
  });

  assert.equal(scope.surfaces.length, 1);
  assert.deepEqual(scope.surfaces[0].axes, ["vertical"]);
  assert.equal(scope.surfaces[0].scrollport, owner);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.hidden = true;
  assert.equal(scope.surfaces[0].isEligible(), false);
});

test("publishes no scroll surface without a scope identity", () => {
  const owner = { hidden: false };

  assert.deepEqual(
    pdfViewer.scrollSurfaceScope.call(owner, {}).surfaces,
    [],
  );
});

test("cancels page renders and tears down the loading task when released", () => {
  const cancelled = [];
  const disconnected = [];
  let destroyed = 0;
  const owner = {
    generation: 2,
    pages: [
      { task: { cancel: () => cancelled.push("first") } },
      { task: null },
    ],
    visiblePages: new Set(),
    pageObserver: { disconnect: () => disconnected.push("pages") },
    widthObserver: { disconnect: () => disconnected.push("width") },
    loadingTask: { destroy: () => (destroyed += 1, Promise.resolve()) },
  };

  pdfViewer.release.call(owner);

  assert.deepEqual(cancelled, ["first"]);
  assert.deepEqual(disconnected, ["pages", "width"]);
  assert.equal(destroyed, 1);
  assert.equal(owner.generation, 3);
  assert.equal(owner.pages, null);
  assert.equal(owner.loadingTask, null);
  assert.equal(owner.pageObserver, null);
});

test("tears down a loading task that never produced a document", () => {
  let destroyed = 0;
  const owner = {
    generation: 1,
    loadingTask: { destroy: () => (destroyed += 1, Promise.resolve()) },
  };

  pdfViewer.release.call(owner);

  assert.equal(destroyed, 1);
});

test("treats a replaced generation or a detached viewer as stale", () => {
  assert.equal(pdfViewer.isCurrent.call({ isConnected: true, generation: 3 }, 3), true);
  assert.equal(pdfViewer.isCurrent.call({ isConnected: true, generation: 4 }, 3), false);
  assert.equal(pdfViewer.isCurrent.call({ isConnected: false, generation: 3 }, 3), false);
});

test("does not redraw a page at a width it already rendered", async () => {
  const record = {
    element: { clientWidth: 600 },
    viewport: { width: 600 },
    renderedWidth: 600,
    task: null,
    page: {
      getViewport: () => assert.fail("an unchanged width must not re-render"),
    },
  };

  await pdfViewer.drawPage.call({ isConnected: true, generation: 1 }, 1, record);

  assert.equal(record.renderedWidth, 600);
});

test("skips a page that has no layout box yet", async () => {
  const record = {
    element: { clientWidth: 0 },
    viewport: { width: 600 },
    renderedWidth: 0,
    task: null,
    page: {
      getViewport: () => assert.fail("a page without width must not render"),
    },
  };

  await pdfViewer.drawPage.call({ isConnected: true, generation: 1 }, 1, record);

  assert.equal(record.renderedWidth, 0);
});

test("ignores page observations from a replaced generation", () => {
  const owner = {
    isConnected: true,
    generation: 5,
    pages: [{ element: { id: "page" } }],
    visiblePages: new Set(),
    isCurrent(generation) {
      return pdfViewer.isCurrent.call(this, generation);
    },
    drawPage: () => assert.fail("a stale observation must not draw"),
  };

  pdfViewer.observePages.call(owner, 4, [
    { target: owner.pages[0].element, isIntersecting: true },
  ]);

  assert.equal(owner.visiblePages.size, 0);
});
