import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import type { ActionHintPull } from "../action-hints.js";
import { CaffoldElement } from "../caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.js";
import { DrawnRef, drawn } from "./drawn-refs.js";
import "./pptx-viewer/components/document.js";

import styles from "./pptx-viewer.css.js";

@customElement("caffold-pptx-viewer")
class CaffoldPptxViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly document = new DrawnRef<
    HTMLElementTagNameMap["caffold-pptx-document"]
  >(this);

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "PowerPoint preview");
  }

  override render() {
    return html`<div
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="pptx-viewer-body"
    ><caffold-pptx-document
      class="pptx-viewer-document"
      ${drawn(this.document)}
      .scrollContainer=${this}
      .file=${this.file}
      @caffold:pptx-document-state=${this.onDocumentState}
    ></caffold-pptx-document></div>`;
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

  private onDocumentState(
    event: HTMLElementEventMap["caffold:pptx-document-state"],
  ) {
    this.dataset.renderState = event.detail;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-pptx-viewer": CaffoldPptxViewer;
  }
}
