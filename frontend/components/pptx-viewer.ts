import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import type { ActionHintPull } from "../action-hints.js";
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
import "./pptx-viewer/components/document.js";

import styles from "./pptx-viewer.css.js";

@customElement("caffold-pptx-viewer")
class CaffoldPptxViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;
  // Where the next file handed over opens; a newer copy opens where this one
  // was read.
  @property({ attribute: false })
  accessor position: PageAnchor | null = null;
  // The size the slides are drawn at, which the deck scales its slides to in
  // the room this viewer gives it.
  @property({ attribute: false })
  accessor zoom: ViewerZoom = { fit: "width" };
  @state()
  private accessor room: ZoomSize | null = null;

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly shown = new ShownZoom(this);
  private readonly document = new DrawnRef<
    HTMLElementTagNameMap["caffold-pptx-document"]
  >(this);
  // Where the deck was last read while it was drawn. A viewer taken off the
  // page reads 0, so it is kept as the person scrolls.
  private readingAnchor: PageAnchor | null = null;
  // Where it was read before its zoom changed, to return to once the slides
  // have their new size, and the scale they had then.
  private zoomPlace: ZoomPlace | null = null;
  private zoomedFrom: number | null = null;
  private roomObserver: ResizeObserver | null = null;
  private deckObserver: ResizeObserver | null = null;

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
    this.setAttribute("aria-label", "PowerPoint preview");
    this.roomObserver = new ResizeObserver(() => {
      this.room = zoomRoom(this);
    });
    this.roomObserver.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.roomObserver?.disconnect();
    this.roomObserver = null;
    this.deckObserver?.disconnect();
    this.deckObserver = null;
  }

  override render() {
    return html`<div
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical", "horizontal"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="pptx-viewer-body"
    ><caffold-pptx-document
      class="pptx-viewer-document"
      ${drawn(this.document)}
      .scrollContainer=${this}
      .file=${this.file}
      .zoom=${this.zoom}
      .room=${this.room}
      @caffold:pptx-document-state=${this.onDocumentState}
    ></caffold-pptx-document></div>`;
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("file") && this.file && !this.file.newerCopy) {
      this.readingAnchor = this.position;
    }
    if (
      changed.has("zoom") &&
      !changed.has("file") &&
      this.dataset.renderState === "pptx"
    ) {
      this.zoomPlace = readZoomPlace(this, this.pages());
      this.zoomedFrom = this.document.value?.slideScale() ?? null;
    }
  }

  // The renderer refits the slides in a frame of its own after their
  // container changes width, and the deck grows or shrinks with them; that is
  // when the place read before a change of zoom can be found again.
  override updated(changed: PropertyValues) {
    const deck = this.document.value;
    if (deck && !this.deckObserver) {
      this.deckObserver = new ResizeObserver(() => this.followSlides());
      this.deckObserver.observe(deck);
    }
    if (changed.has("zoom")) {
      void this.dropUnmovedPlace();
    }
  }

  scrollSurfaceScope({
    label = "PowerPoint preview",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      {
        ...emptyActionHintScope(),
        mutationRoots: [this, this.renderRoot],
        scrollRoots: [this],
      },
      this.document.value?.actionHintScope({
        ...pull,
        clipRoots: [this, ...(pull.clipRoots ?? [])],
      }),
    );
  }

  readingPosition() {
    return this.readingAnchor;
  }

  // The deck says it is drawn once every slide has its place, which is when
  // the place it was read can be found again; the renderer then draws the
  // slides near it.
  private onDocumentState(
    event: HTMLElementEventMap["caffold:pptx-document-state"],
  ) {
    this.dataset.renderState = event.detail;
    if (event.detail !== "pptx") {
      this.shown.forget();
      return;
    }
    if (this.readingAnchor) {
      scrollToPageAnchor(this, this.pages(), this.readingAnchor);
    }
    this.reportShownZoom();
  }

  private followSlides() {
    const place = this.zoomPlace;
    this.zoomPlace = null;
    if (place && this.dataset.renderState === "pptx") {
      returnToZoomPlace(this, this.pages(), place);
    }
    this.reportShownZoom();
  }

  // A zoom that leaves the slides their scale moves nothing, so there is no
  // place to return to.
  private async dropUnmovedPlace() {
    const from = this.zoomedFrom;
    await this.document.value?.updateComplete;
    if (this.document.value?.slideScale() === from) {
      this.zoomPlace = null;
    }
  }

  private recordReading() {
    if (this.dataset.renderState === "pptx" && this.isConnected) {
      this.readingAnchor =
        readPageAnchor(this, this.pages()) ?? this.readingAnchor;
    }
  }

  private reportShownZoom() {
    if (this.dataset.renderState === "pptx") {
      this.shown.report(this.document.value?.slideScale() ?? null);
    }
  }

  private pages() {
    return this.document.value?.pages() ?? [];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-pptx-viewer": CaffoldPptxViewer;
  }
}
