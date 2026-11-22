import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.js";
import { DrawnRef, drawn } from "./drawn-refs.js";
import {
  type PageAnchor,
  readPageAnchor,
  scrollToPageAnchor,
} from "./page-anchor.js";
import {
  readZoomPlace,
  returnToZoomPlace,
  ShownZoom,
  type ViewerZoom,
  type ZoomPlace,
  type ZoomSize,
  zoomRoom,
} from "./viewer-zoom.js";
import "./docx-viewer/components/document.js";

import styles from "./docx-viewer.css.js";

@customElement("caffold-docx-viewer")
class CaffoldDocxViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;
  // Where the next file handed over opens; a newer copy opens where this one
  // was read.
  @property({ attribute: false })
  accessor position: PageAnchor | null = null;
  // The size the pages are drawn at, which the document zooms each page to in
  // the room this viewer gives it.
  @property({ attribute: false })
  accessor zoom: ViewerZoom = { fit: "width" };
  @state()
  private accessor room: ZoomSize | null = null;

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly shown = new ShownZoom(this);
  private readonly document = new DrawnRef<
    HTMLElementTagNameMap["caffold-docx-document"]
  >(this);
  // Where the document was last read while it was drawn. A viewer taken off
  // the page reads 0, so it is kept as the person scrolls.
  private readingAnchor: PageAnchor | null = null;
  // Where it was read before its zoom changed, to return to once the document
  // has zoomed its pages.
  private zoomPlace: ZoomPlace | null = null;
  private roomObserver: ResizeObserver | null = null;

  constructor() {
    super();
    this.addEventListener(
      "scroll",
      () => {
        this.recordReading();
        this.reportShownZoom();
      },
      { passive: true },
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Word document preview");
    this.roomObserver = new ResizeObserver(() => {
      this.room = zoomRoom(this);
    });
    this.roomObserver.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.roomObserver?.disconnect();
    this.roomObserver = null;
  }

  override render() {
    return html`<div
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical", "horizontal"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="docx-viewer-body"
    ><caffold-docx-document
      class="docx-viewer-document"
      ${drawn(this.document)}
      .file=${this.file}
      .zoom=${this.zoom}
      .room=${this.room}
      @caffold:docx-document-state=${this.onDocumentState}
    ></caffold-docx-document></div>`;
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("file") && this.file && !this.file.newerCopy) {
      this.readingAnchor = this.position;
    }
    if (
      changed.has("zoom") &&
      !changed.has("file") &&
      this.dataset.renderState === "docx"
    ) {
      this.zoomPlace = readZoomPlace(this, this.pages());
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("zoom") || changed.has("room")) {
      void this.followZoomedPages();
    }
  }

  scrollSurfaceScope({
    label = "Word document preview",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  readingPosition() {
    return this.readingAnchor;
  }

  // The document says it is drawn once its pages are zoomed, which is when
  // the place it was read can be found again.
  private onDocumentState(
    event: HTMLElementEventMap["caffold:docx-document-state"],
  ) {
    this.dataset.renderState = event.detail;
    if (event.detail !== "docx") {
      this.shown.forget();
      return;
    }
    if (this.readingAnchor) {
      scrollToPageAnchor(this, this.pages(), this.readingAnchor);
    }
    this.reportShownZoom();
  }

  // The document zooms its pages as it updates for the new zoom or room.
  private async followZoomedPages() {
    await this.document.value?.updateComplete;
    const place = this.zoomPlace;
    this.zoomPlace = null;
    if (place) {
      returnToZoomPlace(this, this.pages(), place);
    }
    this.reportShownZoom();
  }

  private recordReading() {
    if (this.dataset.renderState === "docx" && this.isConnected) {
      this.readingAnchor =
        readPageAnchor(this, this.pages()) ?? this.readingAnchor;
    }
  }

  // The zoom of the page at the top.
  private reportShownZoom() {
    if (this.dataset.renderState !== "docx") {
      return;
    }
    const anchor = readPageAnchor(this, this.pages());
    this.shown.report(
      this.document.value?.pageScale(anchor?.page ?? 0) ?? null,
    );
  }

  private pages() {
    return this.document.value?.pages() ?? [];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-docx-viewer": CaffoldDocxViewer;
  }
}
