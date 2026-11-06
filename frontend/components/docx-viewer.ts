import { html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.js";
import { DrawnRef, drawn } from "./drawn-refs.js";
import {
  type PageAnchor,
  readPageAnchor,
  scrollToPageAnchor,
} from "./page-anchor.js";
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

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly document = new DrawnRef<
    HTMLElementTagNameMap["caffold-docx-document"]
  >(this);
  // Where the document was last read while it was drawn. A viewer taken off
  // the page reads 0, so it is kept as the person scrolls.
  private readingAnchor: PageAnchor | null = null;

  constructor() {
    super();
    this.addEventListener("scroll", () => this.recordReading(), {
      passive: true,
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Word document preview");
  }

  override render() {
    return html`<div
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="docx-viewer-body"
    ><caffold-docx-document
      class="docx-viewer-document"
      ${drawn(this.document)}
      .file=${this.file}
      @caffold:docx-document-state=${this.onDocumentState}
    ></caffold-docx-document></div>`;
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("file") && this.file && !this.file.newerCopy) {
      this.readingAnchor = this.position;
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

  // The document says it is drawn once its pages are fitted, which is when
  // the place it was read can be found again.
  private onDocumentState(
    event: HTMLElementEventMap["caffold:docx-document-state"],
  ) {
    this.dataset.renderState = event.detail;
    if (event.detail === "docx" && this.readingAnchor) {
      scrollToPageAnchor(this, this.pages(), this.readingAnchor);
    }
  }

  private recordReading() {
    if (this.dataset.renderState === "docx" && this.isConnected) {
      this.readingAnchor =
        readPageAnchor(this, this.pages()) ?? this.readingAnchor;
    }
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
