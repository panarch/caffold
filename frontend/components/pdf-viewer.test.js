import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./pdf-viewer.js");
const pdfViewer = registry.element("caffold-pdf-viewer").prototype;
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
      dataset: { renderState: "pdf" },
      ensureRendered() {},
      showMessage(renderState) {
        this.dataset.renderState = renderState;
      },
      release() {
        pdfViewer.release.call(this);
      },
      open(generation, requested) {
        opened.push(requested);
      },
    },
  };
}

test("keeps the open document while its file is unchanged", () => {
  const { owner, opened } = loadedViewer("/api/pdf?path=manual.pdf");

  pdfViewer.setSource.call(owner, {
    url: "/api/pdf?path=manual.pdf",
    revision: 1700,
  });

  assert.deepEqual(opened, []);
  assert.equal(owner.dataset.renderState, "pdf");
});

test("reopens the document when the file changed on disk", () => {
  const { owner, opened } = loadedViewer("/api/pdf?path=manual.pdf");

  pdfViewer.setSource.call(owner, {
    url: "/api/pdf?path=manual.pdf",
    revision: 1800,
  });

  assert.deepEqual(opened, ["/api/pdf?path=manual.pdf"]);
  assert.equal(owner.dataset.renderState, "loading");
  assert.equal(owner.revision, 1800);
});

test("reopens the document when another file is selected", () => {
  const { owner, opened } = loadedViewer("/api/pdf?path=manual.pdf");

  pdfViewer.setSource.call(owner, {
    url: "/api/pdf?path=other.pdf",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/pdf?path=other.pdf"]);
});

test("reads the file again once its modification time becomes known", () => {
  // Only a refresh intent delivers a modification time the viewer did not have,
  // so treating it as unchanged would leave a replaced document on screen.
  const { owner, opened } = loadedViewer("/api/pdf?path=manual.pdf", null);

  pdfViewer.setSource.call(owner, {
    url: "/api/pdf?path=manual.pdf",
    revision: 1800,
  });

  assert.deepEqual(opened, ["/api/pdf?path=manual.pdf"]);
  assert.equal(owner.revision, 1800);
});

test("keeps the open document across a re-render with no modification time", () => {
  const { owner, opened } = loadedViewer("/api/pdf?path=manual.pdf", null);

  pdfViewer.setSource.call(owner, { url: "/api/pdf?path=manual.pdf" });

  assert.deepEqual(opened, []);
});

test("retries the same source after a failed load", () => {
  const { owner, opened } = loadedViewer("/api/pdf?path=manual.pdf");
  owner.dataset.renderState = "error";

  pdfViewer.setSource.call(owner, {
    url: "/api/pdf?path=manual.pdf",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/pdf?path=manual.pdf"]);
});

test("publishes only the axis a scaled page can overflow", () => {
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    ensureRendered() {},
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
  const owner = { initialized: true, hidden: false, ensureRendered() {} };

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
    url: "/api/pdf?path=manual.pdf",
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
  assert.equal(owner.url, null);
  assert.equal(owner.revision, null);
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
