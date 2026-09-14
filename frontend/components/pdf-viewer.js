import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";

const PDFJS_VERSION = "6.3.289";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const PDFJS_IMPORT = `${PDFJS_BASE}/build/pdf.min.mjs`;

// A phone would otherwise allocate a canvas proportional to its full device
// pixel ratio for every visible page.
const MAX_RENDER_PIXEL_RATIO = 2;
const NEARBY_PAGE_MARGIN = "200% 0px";

let libraryPromise;

class CaffoldPdfViewer extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "PDF preview");
  }

  disconnectedCallback() {
    this.release();
  }

  setSource(source = {}) {
    this.ensureRendered();
    const url = `${source.url ?? ""}`;
    const revision = source.revision ?? null;
    // A rebuilt header or resized pane re-renders the same file; only another
    // file or a newer modification time is a reason to read it again.
    if (
      this.url === url &&
      this.revision === revision &&
      this.dataset.renderState !== "error"
    ) {
      return;
    }
    this.release();
    this.url = url;
    this.revision = revision;
    this.showMessage("loading", "Loading PDF...");
    void this.open(this.generation, url);
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "PDF preview",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    this.ensureRendered();
    if (!scopeId || !label || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport: this,
        axes: ["vertical"],
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          hasScrollLayoutBox(this),
      }],
      mutationRoots: [this],
      resizeElements: [this],
      scrollRoots: [this],
    };
  }

  async open(generation, url) {
    try {
      const pdfjs = await loadLibrary();
      if (!this.isCurrent(generation)) {
        return;
      }
      // Each of these defaults to null, and a document that needs one fails
      // rather than degrading: predefined CJK encodings, unembedded standard
      // fonts, JPEG 2000 images, and CMYK colour respectively.
      const task = pdfjs.getDocument({
        url,
        cMapUrl: `${PDFJS_BASE}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
        wasmUrl: `${PDFJS_BASE}/wasm/`,
        iccUrl: `${PDFJS_BASE}/iccs/`,
      });
      // Ownership is taken before the first await, so a release during the read
      // tears the task down instead of leaving it attached to a stale viewer.
      if (!this.isCurrent(generation)) {
        destroyLoadingTask(task);
        return;
      }
      this.loadingTask = task;
      await this.mountPages(generation, await task.promise);
    } catch {
      if (this.isCurrent(generation)) {
        this.showMessage("error", "This PDF could not be displayed.");
      }
    }
  }

  async mountPages(generation, document) {
    const pages = await Promise.all(
      Array.from({ length: document.numPages }, (_, index) =>
        document.getPage(index + 1)),
    );
    if (!this.isCurrent(generation)) {
      return;
    }

    const body = this.body();
    body.replaceChildren();
    this.pages = pages.map((page, index) => {
      // The page box carries the document's own geometry the way an image
      // carries its intrinsic size; CSS still decides how it is placed and
      // constrained.
      const viewport = page.getViewport({ scale: 1 });
      const element = window.document.createElement("div");
      element.className = "pdf-viewer-page";
      element.dataset.pdfPage = `${index + 1}`;
      element.style.setProperty("--pdf-page-width", `${Math.round(viewport.width)}px`);
      element.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      body.append(element);
      return { page, viewport, element, renderedWidth: 0, task: null };
    });
    this.dataset.renderState = "pdf";

    this.visiblePages = new Set();
    this.pageObserver = new IntersectionObserver(
      (entries) => this.observePages(generation, entries),
      { root: this, rootMargin: NEARBY_PAGE_MARGIN },
    );
    for (const record of this.pages) {
      this.pageObserver.observe(record.element);
    }
    this.widthObserver = new ResizeObserver(() => this.redrawVisiblePages(generation));
    this.widthObserver.observe(this);
  }

  observePages(generation, entries) {
    if (!this.isCurrent(generation)) {
      return;
    }
    for (const entry of entries) {
      const record = this.pages?.find((page) => page.element === entry.target);
      if (!record) {
        continue;
      }
      if (entry.isIntersecting) {
        this.visiblePages?.add(record);
        void this.drawPage(generation, record);
      } else {
        this.visiblePages?.delete(record);
      }
    }
  }

  redrawVisiblePages(generation) {
    if (!this.isCurrent(generation)) {
      return;
    }
    for (const record of this.visiblePages ?? []) {
      void this.drawPage(generation, record);
    }
  }

  async drawPage(generation, record) {
    const width = record.element.clientWidth;
    if (!width || record.renderedWidth === width) {
      return;
    }
    record.task?.cancel();
    record.renderedWidth = width;

    const ratio = Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO);
    const viewport = record.page.getViewport({
      scale: (width * ratio) / record.viewport.width,
    });
    const canvas = window.document.createElement("canvas");
    canvas.className = "pdf-viewer-canvas";
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    const task = record.page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
    });
    record.task = task;
    try {
      await task.promise;
    } catch {
      // A cancelled render leaves the page eligible for the next width.
      if (record.task === task) {
        record.renderedWidth = 0;
        record.task = null;
      }
      return;
    }
    if (!this.isCurrent(generation) || record.task !== task) {
      return;
    }
    record.task = null;
    record.element.replaceChildren(canvas);
  }

  release() {
    this.generation = (this.generation ?? 0) + 1;
    this.url = null;
    this.revision = null;
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    this.widthObserver?.disconnect();
    this.widthObserver = null;
    this.visiblePages = null;
    for (const record of this.pages ?? []) {
      record.task?.cancel();
      record.task = null;
    }
    this.pages = null;
    const loadingTask = this.loadingTask;
    this.loadingTask = null;
    destroyLoadingTask(loadingTask);
  }

  isCurrent(generation) {
    return this.isConnected && this.generation === generation;
  }

  ensureRendered() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.generation = 0;
    this.dataset.renderState = "empty";
    this.innerHTML = '<div class="pdf-viewer-body"></div>';
  }

  showMessage(renderState, message) {
    const body = this.body();
    this.dataset.renderState = renderState;
    body.replaceChildren();
    const paragraph = window.document.createElement("p");
    paragraph.className = "pdf-viewer-message";
    paragraph.textContent = message;
    body.append(paragraph);
  }

  body() {
    return this.querySelector(":scope > .pdf-viewer-body");
  }
}

// The loading task owns the worker and the document it produced; the document
// proxy itself exposes no teardown.
function destroyLoadingTask(task) {
  if (!task) {
    return;
  }
  task.destroy().catch(() => {
    // A document torn down mid-render rejects its outstanding work.
  });
}

function loadLibrary() {
  libraryPromise ??= import(PDFJS_IMPORT).then((module) => {
    // pdf.js wraps a cross-origin worker source in a blob module itself, so the
    // CDN path can be handed over unchanged.
    module.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
    return module;
  });
  return libraryPromise;
}

customElements.define("caffold-pdf-viewer", CaffoldPdfViewer);
