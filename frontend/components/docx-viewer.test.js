import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./docx-viewer.js");
const docxViewer = registry.element("caffold-docx-viewer").prototype;
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
      dataset: { renderState: "docx" },
      ensureRendered() {},
      showMessage(renderState) {
        this.dataset.renderState = renderState;
      },
      release() {
        docxViewer.release.call(this);
      },
      open(generation, requested) {
        opened.push(requested);
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

test("keeps the open document while its file is unchanged", () => {
  const { owner, opened } = loadedViewer("/api/docx?path=report.docx");

  docxViewer.setSource.call(owner, {
    url: "/api/docx?path=report.docx",
    revision: 1700,
  });

  assert.deepEqual(opened, []);
  assert.equal(owner.dataset.renderState, "docx");
});

test("reopens the document when the file changed on disk", () => {
  const { owner, opened } = loadedViewer("/api/docx?path=report.docx");

  docxViewer.setSource.call(owner, {
    url: "/api/docx?path=report.docx",
    revision: 1800,
  });

  assert.deepEqual(opened, ["/api/docx?path=report.docx"]);
  assert.equal(owner.dataset.renderState, "loading");
  assert.equal(owner.revision, 1800);
});

test("reopens the document when another file is selected", () => {
  const { owner, opened } = loadedViewer("/api/docx?path=report.docx");

  docxViewer.setSource.call(owner, {
    url: "/api/docx?path=minutes.docx",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/docx?path=minutes.docx"]);
});

test("reads the file again once its modification time becomes known", () => {
  const { owner, opened } = loadedViewer("/api/docx?path=report.docx", null);

  docxViewer.setSource.call(owner, {
    url: "/api/docx?path=report.docx",
    revision: 1800,
  });

  assert.deepEqual(opened, ["/api/docx?path=report.docx"]);
});

test("retries the same source after a failed load", () => {
  const { owner, opened } = loadedViewer("/api/docx?path=report.docx");
  owner.dataset.renderState = "error";

  docxViewer.setSource.call(owner, {
    url: "/api/docx?path=report.docx",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/docx?path=report.docx"]);
});

test("publishes only the vertical axis of a page fitted to its width", () => {
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    getClientRects: () => [{}],
  };

  const scope = docxViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer:docx",
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

  assert.deepEqual(docxViewer.scrollSurfaceScope.call(owner, {}).surfaces, []);
});

test("stops reading and fitting the document when released", () => {
  const events = [];
  const owner = {
    generation: 2,
    url: "/api/docx?path=report.docx",
    revision: 1700,
    reading: { abort: () => events.push("abort") },
    widthObserver: { disconnect: () => events.push("disconnect") },
    mount: {},
    pages: [page(794)],
  };

  docxViewer.release.call(owner);

  assert.deepEqual(events, ["abort", "disconnect"]);
  assert.equal(owner.generation, 3);
  assert.equal(owner.url, null);
  assert.equal(owner.revision, null);
  assert.equal(owner.reading, null);
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
