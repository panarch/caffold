import { html, LitElement, nothing, type PropertyValues } from "lit";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.ts";
import type { DocumentPreviewFile } from "./dom.ts";
import "./loading-text.ts";

const PDFJS_VERSION = "6.3.289";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const PDFJS_IMPORT = `${PDFJS_BASE}/build/pdf.min.mjs`;

// A phone would otherwise allocate a canvas proportional to its full device
// pixel ratio for every visible page.
const MAX_RENDER_PIXEL_RATIO = 2;
const NEARBY_PAGE_MARGIN = "200% 0px";

// The parts of pdf.js the viewer uses.
interface PdfViewport {
  width: number;
  height: number;
}

interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

interface PdfPage {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: {
    canvasContext: CanvasRenderingContext2D | null;
    viewport: PdfViewport;
  }): PdfRenderTask;
}

interface PdfDocument {
  numPages: number;
  getPage(number: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJs {
  getDocument(options: Record<string, unknown>): PdfLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
}

interface PageRecord {
  page: PdfPage;
  viewport: PdfViewport;
  element: HTMLElement;
  renderedWidth: number;
  task: PdfRenderTask | null;
}

type RenderState = "empty" | "loading" | "error" | "pdf";

let libraryPromise: Promise<PdfJs> | undefined;

class CaffoldPdfViewer extends LitElement {
  static properties = {
    file: { attribute: false },
    renderState: { state: true },
    pages: { state: true },
  };

  declare file: DocumentPreviewFile | null;
  declare private renderState: RenderState;
  declare private pages: PageRecord[] | null;
  private generation = 0;
  private visiblePages: Set<PageRecord> | null = null;
  private pageObserver: IntersectionObserver | null = null;
  private widthObserver: ResizeObserver | null = null;
  private loadingTask: PdfLoadingTask | null = null;

  constructor() {
    super();
    this.file = null;
    this.renderState = "empty";
    this.pages = null;
  }

  private readonly surfaces = new ScrollSurfaces(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "PDF preview");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.release();
  }

  render() {
    const message =
      this.renderState === "loading"
        ? html`<caffold-loading-text>Loading PDF...</caffold-loading-text>`
        : this.renderState === "error"
          ? "This PDF could not be displayed."
          : "";
    const content =
      this.renderState === "pdf"
        ? this.pages?.map((record) => record.element)
        : message
          ? html`<p class="pdf-viewer-message">${message}</p>`
          : nothing;
    return html`<div
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="pdf-viewer-body"
    >${content}</div>`;
  }

  // A file handed over again before it is drawn replaces the one before it.
  willUpdate(changed: PropertyValues) {
    if (changed.has("file") && this.file) {
      this.release();
      this.renderState = "loading";
      void this.open(this.generation, this.file.file);
    }
  }

  updated(changed: PropertyValues) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
  }

  scrollSurfaceScope({
    label = "PDF preview",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  private async open(generation: number, file: Blob | Promise<Blob>) {
    try {
      const [pdfjs, data] = await Promise.all([loadLibrary(), readBytes(file)]);
      if (!this.isCurrent(generation)) {
        return;
      }
      // Each of these defaults to null, and a document that needs one fails
      // rather than degrading: predefined CJK encodings, unembedded standard
      // fonts, JPEG 2000 images, and CMYK colour respectively.
      const task = pdfjs.getDocument({
        data,
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
    } catch (error) {
      // A fetch let go of is followed by another file or by nothing at all.
      if (
        this.isCurrent(generation) &&
        (error as Error | null)?.name !== "AbortError"
      ) {
        this.renderState = "error";
      }
    }
  }

  private async mountPages(generation: number, document: PdfDocument) {
    const pages = await Promise.all(
      Array.from({ length: document.numPages }, (_, index) =>
        document.getPage(index + 1),
      ),
    );
    if (!this.isCurrent(generation)) {
      return;
    }

    const records: PageRecord[] = pages.map((page, index) => {
      // The page box carries the document's own geometry the way an image
      // carries its intrinsic size; CSS still decides how it is placed and
      // constrained.
      const viewport = page.getViewport({ scale: 1 });
      const element = window.document.createElement("div");
      element.className = "pdf-viewer-page";
      element.dataset.pdfPage = `${index + 1}`;
      element.style.setProperty(
        "--pdf-page-width",
        `${Math.round(viewport.width)}px`,
      );
      element.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      return { page, viewport, element, renderedWidth: 0, task: null };
    });
    this.pages = records;
    this.renderState = "pdf";
    await this.updateComplete;
    if (!this.isCurrent(generation)) {
      return;
    }

    this.visiblePages = new Set();
    this.pageObserver = new IntersectionObserver(
      (entries) => this.observePages(generation, entries),
      { root: this, rootMargin: NEARBY_PAGE_MARGIN },
    );
    for (const record of records) {
      this.pageObserver.observe(record.element);
    }
    this.widthObserver = new ResizeObserver(() =>
      this.redrawVisiblePages(generation),
    );
    this.widthObserver.observe(this);
  }

  private observePages(
    generation: number,
    entries: Array<
      Pick<IntersectionObserverEntry, "target" | "isIntersecting">
    >,
  ) {
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

  private redrawVisiblePages(generation: number) {
    if (!this.isCurrent(generation)) {
      return;
    }
    for (const record of this.visiblePages ?? []) {
      void this.drawPage(generation, record);
    }
  }

  private async drawPage(generation: number, record: PageRecord) {
    const width = record.element.clientWidth;
    if (!width || record.renderedWidth === width) {
      return;
    }
    record.task?.cancel();
    record.renderedWidth = width;

    const ratio = Math.min(
      window.devicePixelRatio || 1,
      MAX_RENDER_PIXEL_RATIO,
    );
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

  private release() {
    this.generation += 1;
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

  private isCurrent(generation: number) {
    return this.isConnected && this.generation === generation;
  }
}

// The loading task owns the worker and the document it produced; the document
// proxy itself exposes no teardown.
function destroyLoadingTask(task: PdfLoadingTask | null) {
  if (!task) {
    return;
  }
  task.destroy().catch(() => {
    // A document torn down mid-render rejects its outstanding work.
  });
}

// pdf.js is handed the bytes rather than the address, so the document arrives
// in cells like every other file a viewer shows.
async function readBytes(file: Blob | Promise<Blob>) {
  return new Uint8Array(await (await file).arrayBuffer());
}

function loadLibrary() {
  libraryPromise ??= import(PDFJS_IMPORT).then((module: PdfJs) => {
    // pdf.js wraps a cross-origin worker source in a blob module itself, so the
    // CDN path can be handed over unchanged.
    module.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
    return module;
  });
  return libraryPromise;
}

customElements.define("caffold-pdf-viewer", CaffoldPdfViewer);
