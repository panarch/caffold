import type { HwpDocument } from "@rhwp/core";
import { html, type PropertyValues } from "lit";
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

import styles from "./hwp-viewer.css.js";

const RHWP_VERSION = "0.9.1";
const RHWP_IMPORT = `https://cdn.jsdelivr.net/npm/@rhwp/core@${RHWP_VERSION}/rhwp.js`;
const PREVIEW_LABEL = "Hangul document preview";
const NEARBY_PAGE_MARGIN = "100% 0px";
const MAX_RENDER_PIXEL_RATIO = 2;

type Rhwp = typeof import("@rhwp/core");
type RenderState = "empty" | "loading" | "error" | "hwp";

interface PageRecord {
  index: number;
  width: number;
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

  @state()
  private accessor renderState: RenderState = "empty";

  @state()
  private accessor pages: PageRecord[] = [];

  private activeFile: DocumentPreviewFile | null = null;
  private openedDocument: HwpDocument | null = null;
  private generation = 0;
  private readingAnchor: PageAnchor | null = null;
  private layoutWidth = 0;
  private readonly nearbyPages = new Set<PageRecord>();
  private pageObserver: IntersectionObserver | null = null;
  private widthObserver: ResizeObserver | null = null;
  private readonly surfaces = new ScrollSurfaces(this);

  constructor() {
    super();
    this.addEventListener(
      "scroll",
      () => {
        if (this.renderState === "hwp") {
          this.readingAnchor =
            readPageAnchor(this, this.pageElements()) ?? this.readingAnchor;
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
  }

  override render() {
    const message =
      this.renderState === "loading"
        ? html`<caffold-loading-text>Loading Hangul document...</caffold-loading-text>`
        : this.renderState === "error"
          ? "This Hangul document could not be displayed."
          : null;
    return html`<div
      class="hwp-viewer-body"
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical"],
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
    this.restoreReadingPosition();
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
    this.widthObserver = new ResizeObserver(() => {
      if (this.isCurrent(generation) && this.clientWidth !== this.layoutWidth) {
        this.layoutWidth = this.clientWidth;
        this.restoreReadingPosition();
        this.drawNearbyPages();
      }
    });
    this.widthObserver.observe(this);
  }

  private drawNearbyPages() {
    const opened = this.openedDocument;
    if (!opened) {
      return;
    }
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      MAX_RENDER_PIXEL_RATIO,
    );
    try {
      for (const page of this.nearbyPages) {
        const width = page.element.clientWidth;
        if (!width || width === page.renderedWidth) {
          continue;
        }
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

  private fail() {
    this.release();
    this.renderState = "error";
  }

  private release() {
    this.generation += 1;
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

function pageRecord(opened: HwpDocument, index: number): PageRecord {
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
  element.style.aspectRatio = `${width} / ${height}`;
  return { index, width, element, renderedWidth: 0 };
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
