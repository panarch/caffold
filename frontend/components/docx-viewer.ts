import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.js";
import "./docx-viewer/components/document.js";

import styles from "./docx-viewer.css.js";

@customElement("caffold-docx-viewer")
class CaffoldDocxViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);

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
      .file=${this.file}
      @caffold:docx-document-state=${this.onDocumentState}
    ></caffold-docx-document></div>`;
  }

  scrollSurfaceScope({
    label = "Word document preview",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  private onDocumentState(
    event: HTMLElementEventMap["caffold:docx-document-state"],
  ) {
    this.dataset.renderState = event.detail;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-docx-viewer": CaffoldDocxViewer;
  }
}
