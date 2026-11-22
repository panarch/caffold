import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.js";
import "./loading-text.js";
import {
  type PageAnchor,
  readPageAnchor,
  scrollToPageAnchor,
} from "./page-anchor.js";
import {
  canvasPixelRatio,
  readZoomPlace,
  returnToZoomPlace,
  ShownZoom,
  type ViewerZoom,
  type ZoomPlace,
} from "./viewer-zoom.js";

import styles from "./hwp-viewer.css.js";

const RHWP_VERSION = "0.9.1";
const RHWP_IMPORT = `https://cdn.jsdelivr.net/npm/@rhwp/core@${RHWP_VERSION}/rhwp.js`;
const PREVIEW_LABEL = "Hangul document preview";
const NEARBY_PAGE_MARGIN = "100% 0px";

// Production builds omit the npm package. These types describe the CDN API
// used by the viewer.
interface RhwpDocument {
  pageCount(): number;
  getPageInfo(page: number): string;
  renderPageToCanvas(
    page: number,
    canvas: HTMLCanvasElement,
    scale: number,
  ): void;
  free(): void;
}

interface Rhwp {
  default(): Promise<unknown>;
  HwpDocument: new (bytes: Uint8Array) => RhwpDocument;
}

type RenderState = "empty" | "loading" | "error" | "hwp";

interface PageRecord {
  index: number;
  width: number;
  height: number;
  element: HTMLElement;
  renderedWidth: number;
}

let libraryPromise: Promise<Rhwp> | undefined;

@customElement("caffold-hwp-viewer")
class CaffoldHwpViewer extends CaffoldElement {
  static override styles = styles;

  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;

  @property({ attribute: false })
  accessor position: PageAnchor | null = null;

  // The size the pages are drawn at. CSS sizes each page's box from it; while
  // the person holds the zoom slider, a page keeps the picture it has,
  // stretched to its box, and is drawn again once they let go.
  @property({ attribute: false })
  accessor zoom: ViewerZoom = { fit: "width" };

  @property({ attribute: false })
  accessor zoomDragging = false;

  @state()
  private accessor renderState: RenderState = "empty";

  @state()
  private accessor pages: PageRecord[] = [];

  private activeFile: DocumentPreviewFile | null = null;
  private openedDocument: RhwpDocument | null = null;
  private generation = 0;
  private readingAnchor: PageAnchor | null = null;
  // Where it was read before its zoom changed, to return to at the new size.
  private zoomPlace: ZoomPlace | null = null;
  private layoutWidth = 0;
  private layoutHeight = 0;
  private readonly nearbyPages = new Set<PageRecord>();
  private pageObserver: IntersectionObserver | null = null;
  private widthObserver: ResizeObserver | null = null;
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly shown = new ShownZoom(this);

  constructor() {
    super();
    this.addEventListener(
      "scroll",
      () => {
        if (this.renderState === "hwp") {
          this.readingAnchor =
            readPageAnchor(this, this.pageElements()) ?? this.readingAnchor;
          this.reportShownZoom();
        }
      },
      { passive: true },
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", PREVIEW_LABEL);
    this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.release();
    this.activeFile = null;
  }

  override willUpdate(changed: PropertyValues) {
    if (
      changed.has("zoom") &&
      !changed.has("file") &&
      this.renderState === "hwp"
    ) {
      this.zoomPlace = readZoomPlace(this, this.pageElements());
    }
    const file = this.file;
    if (!this.isConnected || file === this.activeFile) {
      return;
    }
    this.release();
    this.activeFile = file;
    this.renderState = file ? "loading" : "empty";
    if (file) {
      if (changed.has("file") && !file.newerCopy) {
        this.readingAnchor = this.position;
      }
      void this.open(this.generation, file.file);
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
    const place = this.zoomPlace;
    if (place) {
      this.zoomPlace = null;
      returnToZoomPlace(this, this.pageElements(), place);
      this.reportShownZoom();
    }
    if (
      (changed.has("zoom") || changed.has("zoomDragging")) &&
      !this.zoomDragging
    ) {
      this.drawNearbyPages();
    }
  }

  override render() {
    const message =
      this.renderState === "loading"
        ? html`<caffold-loading-text>Loading Hangul document...</caffold-loading-text>`
        : this.renderState === "error"
          ? "This Hangul document could not be displayed."
          : null;
    const zoom = this.zoom;
    return html`<div
      class="hwp-viewer-body"
      data-zoom=${"fit" in zoom ? zoom.fit : "percent"}
      style=${"percent" in zoom ? `--hwp-zoom-scale: ${zoom.percent / 100}` : nothing}
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical", "horizontal"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
    >${message ? html`<p class="hwp-viewer-message">${message}</p>` : this.pageElements()}</div>`;
  }

  scrollSurfaceScope({
    label = PREVIEW_LABEL,
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  readingPosition() {
    return this.readingAnchor;
  }

  private async open(generation: number, file: Blob | Promise<Blob>) {
    try {
      const [rhwp, data] = await Promise.all([
        loadLibrary(),
        Promise.resolve(file).then((blob) => blob.arrayBuffer()),
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }

      const opened = new rhwp.HwpDocument(new Uint8Array(data));
      this.openedDocument = opened;
      this.pages = Array.from({ length: opened.pageCount() }, (_, index) =>
        pageRecord(opened, index),
      );
      if (!this.pages.length) {
        this.fail();
        return;
      }
      this.renderState = "hwp";
      await this.updateComplete;
      if (this.isCurrent(generation)) {
        this.observeLayout(generation);
      }
    } catch (error) {
      if (
        this.isCurrent(generation) &&
        (error as Error | null)?.name !== "AbortError"
      ) {
        this.fail();
      }
    }
  }

  private observeLayout(generation: number) {
    this.layoutWidth = this.clientWidth;
    this.layoutHeight = this.clientHeight;
    this.restoreReadingPosition();
    this.reportShownZoom();
    this.pageObserver = new IntersectionObserver(
      (entries) => {
        if (!this.isCurrent(generation)) {
          return;
        }
        for (const entry of entries) {
          const index =
            Number((entry.target as HTMLElement).dataset.hwpPage) - 1;
          const page = this.pages[index];
          if (entry.isIntersecting) {
            this.nearbyPages.add(page);
          } else {
            this.nearbyPages.delete(page);
            page.element.replaceChildren();
            page.renderedWidth = 0;
          }
        }
        this.drawNearbyPages();
      },
      { root: this, rootMargin: NEARBY_PAGE_MARGIN },
    );
    for (const page of this.pages) {
      this.pageObserver.observe(page.element);
    }
    // A fit follows the room the viewer has: its width, and for Fit page its
    // height.
    this.widthObserver = new ResizeObserver(() => {
      if (
        this.isCurrent(generation) &&
        (this.clientWidth !== this.layoutWidth ||
          this.clientHeight !== this.layoutHeight)
      ) {
        this.layoutWidth = this.clientWidth;
        this.layoutHeight = this.clientHeight;
        this.restoreReadingPosition();
        this.drawNearbyPages();
        this.reportShownZoom();
      }
    });
    this.widthObserver.observe(this);
  }

  // Drawing is synchronous, so nothing is drawn while the person holds the
  // zoom slider.
  private drawNearbyPages() {
    const opened = this.openedDocument;
    if (!opened || this.zoomDragging) {
      return;
    }
    try {
      for (const page of this.nearbyPages) {
        const width = page.element.clientWidth;
        if (!width || width === page.renderedWidth) {
          continue;
        }
        const ratio = canvasPixelRatio(
          width,
          (width * page.height) / page.width,
          window.devicePixelRatio,
        );
        const canvas = document.createElement("canvas");
        canvas.className = "hwp-viewer-canvas";
        opened.renderPageToCanvas(
          page.index,
          canvas,
          (width * ratio) / page.width,
        );
        page.element.replaceChildren(canvas);
        page.renderedWidth = width;
      }
    } catch {
      this.fail();
    }
  }

  private restoreReadingPosition() {
    if (this.readingAnchor && this.clientWidth > 0) {
      scrollToPageAnchor(this, this.pageElements(), this.readingAnchor);
    }
  }

  private pageElements() {
    return this.pages.map((page) => page.element);
  }

  // The scale of the page at the top, of the size the document gives it.
  private reportShownZoom() {
    if (this.renderState !== "hwp" || !this.pages.length) {
      return;
    }
    const anchor = readPageAnchor(this, this.pageElements());
    const page = this.pages[anchor?.page ?? 0];
    const width = page.element.getBoundingClientRect().width;
    if (width > 0) {
      this.shown.report(width / page.width);
    }
  }

  private fail() {
    this.release();
    this.renderState = "error";
  }

  private release() {
    this.generation += 1;
    this.shown.forget();
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    this.widthObserver?.disconnect();
    this.widthObserver = null;
    this.nearbyPages.clear();
    this.pages = [];
    this.openedDocument?.free();
    this.openedDocument = null;
  }

  private isCurrent(generation: number) {
    return this.isConnected && this.generation === generation;
  }
}

function pageRecord(opened: RhwpDocument, index: number): PageRecord {
  const { width, height } = JSON.parse(opened.getPageInfo(index)) as {
    width: number;
    height: number;
  };
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error("Invalid Hangul document page size");
  }
  const element = document.createElement("div");
  element.className = "hwp-viewer-page";
  element.dataset.hwpPage = String(index + 1);
  element.style.setProperty("--hwp-page-width", `${width}px`);
  element.style.setProperty("--hwp-page-aspect", `${width / height}`);
  element.style.aspectRatio = `${width} / ${height}`;
  return { index, width, height, element, renderedWidth: 0 };
}

function loadLibrary() {
  libraryPromise ??= import(RHWP_IMPORT)
    .then(async (module: Rhwp) => {
      // RHWP's typesetting asks the browser to measure text in its fonts.
      const context = document.createElement("canvas").getContext("2d");
      if (!context) {
        throw new Error("Canvas 2D is unavailable");
      }
      const host: typeof globalThis & {
        measureTextWidth?: (font: string, text: string) => number;
      } = globalThis;
      host.measureTextWidth = (font, text) => {
        context.font = font;
        return context.measureText(text).width;
      };
      await module.default();
      return module;
    })
    .catch((error) => {
      libraryPromise = undefined;
      throw error;
    });
  return libraryPromise;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-hwp-viewer": CaffoldHwpViewer;
  }
}
