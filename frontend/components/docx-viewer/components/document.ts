import {
  type CSSResultGroup,
  html,
  LitElement,
  nothing,
  type PropertyValues,
} from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { DocumentPreviewFile } from "../../dom.js";
import "../../loading-text.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  type ViewerZoom,
  type ZoomSize,
  zoomScale,
} from "../../viewer-zoom.js";

import styles from "./document.css.js";

const DOCX_PREVIEW_VERSION = "0.4.1";
const DOCX_PREVIEW_IMPORT = `https://cdn.jsdelivr.net/npm/docx-preview@${DOCX_PREVIEW_VERSION}/+esm`;

// A document's text uses the fonts installed on the device rather than the ones
// it embeds. Pictures as data URLs leave no object URLs behind when a document
// is replaced. Pages split where Word last broke them as well as at the
// document's own breaks, though never inside a table.
const RENDER_OPTIONS = {
  ignoreFonts: true,
  useBase64URL: true,
  ignoreLastRenderedPageBreak: false,
};

const EMBEDDED_HTML_NOTICE =
  "Embedded HTML content is not shown in this preview.";

// The parts of docx-preview the viewer uses.
interface DocxPreview {
  parseAsync(
    bytes: ArrayBuffer,
    options: typeof RENDER_OPTIONS,
  ): Promise<unknown>;
  renderDocument(
    document: unknown,
    options: typeof RENDER_OPTIONS,
  ): Promise<Node[]>;
}

// A page's own size, measured before any zoom applies, and the zoom it is
// drawn at.
interface PageRecord {
  element: HTMLElement;
  width: number;
  height: number;
  scale: number;
}

type DocumentRenderState = "empty" | "loading" | "error" | "docx";

let libraryPromise: Promise<DocxPreview> | undefined;

@customElement("caffold-docx-document")
class CaffoldDocxDocument extends CaffoldElement {
  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;
  // The size the pages are drawn at, in the room the viewer gives them.
  @property({ attribute: false })
  accessor zoom: ViewerZoom = { fit: "width" };
  @property({ attribute: false })
  accessor room: ZoomSize | null = null;
  @state()
  private accessor renderState: DocumentRenderState = "empty";
  @state()
  private accessor content: DocumentFragment | null = null;

  static override styles = styles;

  // Office documents keep their own CSS defaults. Register this root through
  // CaffoldElement, but do not apply the app's control and box-sizing resets.
  protected static override finalizeStyles(styles?: CSSResultGroup) {
    return LitElement.finalizeStyles(styles ?? []);
  }

  private generation = 0;
  private pageRecords: PageRecord[] | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this.requestUpdate("file", null);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.release();
  }

  override render() {
    const message =
      this.renderState === "loading"
        ? html`<caffold-loading-text>Loading document...</caffold-loading-text>`
        : this.renderState === "error"
          ? "This document could not be displayed."
          : "";
    const content =
      this.renderState === "docx"
        ? this.content
        : message
          ? html`<p class="docx-viewer-message">${message}</p>`
          : nothing;
    return content;
  }

  // A file handed over again before it is drawn replaces the one before it.
  override willUpdate(changed: PropertyValues) {
    if (changed.has("file")) {
      this.release();
      if (this.file && this.isConnected) {
        this.renderState = "loading";
        void this.open(this.generation, this.file.file);
      }
    }
  }

  // A drawn document is zoomed before it says it is drawn, so its pages
  // already have the size they are read at; it is zoomed again whenever its
  // zoom or its room changes.
  override updated(changed: PropertyValues) {
    if (changed.has("renderState")) {
      if (this.renderState === "docx") {
        this.measurePages();
      }
      this.dataset.renderState = this.renderState;
      this.dispatchEvent(
        new CustomEvent<DocumentRenderState>("caffold:docx-document-state", {
          detail: this.renderState,
        }),
      );
    } else if (changed.has("zoom") || changed.has("room")) {
      this.zoomPages();
    }
  }

  // The document's pages in order, once it is drawn.
  pages() {
    return (this.pageRecords ?? []).map((page) => page.element);
  }

  // The zoom the page at `index` is drawn at, once it is drawn.
  pageScale(index: number) {
    return this.pageRecords?.[index]?.scale ?? null;
  }

  private async open(generation: number, file: Blob | Promise<Blob>) {
    try {
      const [docx, bytes] = await Promise.all([loadLibrary(), readBytes(file)]);
      if (!this.isCurrent(generation)) {
        return;
      }
      const wordDocument = await docx.parseAsync(bytes, RENDER_OPTIONS);
      const nodes = await docx.renderDocument(wordDocument, RENDER_OPTIONS);
      if (!this.isCurrent(generation)) {
        return;
      }
      this.mountDocument(nodes);
    } catch (error) {
      // A fetch let go of is followed by another file or by nothing at all.
      if (
        this.isCurrent(generation) &&
        (error as Error | null)?.name !== "AbortError"
      ) {
        this.release();
        this.renderState = "error";
      }
    }
  }

  private mountDocument(nodes: Node[]) {
    const content = window.document.createDocumentFragment();
    content.append(...nodes);
    withholdActiveContent(content);
    dropEmptyPages(content);

    this.content = content;
    this.renderState = "docx";
  }

  // Each page's own size is measured once, before any zoom applies, and the
  // pages are zoomed at once, so the document is never shown at a size its
  // zoom does not give it.
  private measurePages() {
    this.pageRecords = Array.from(
      this.renderRoot.querySelectorAll<HTMLElement>("section.docx"),
      (element) => ({
        element,
        width: element.offsetWidth,
        height: element.offsetHeight,
        scale: 1,
      }),
    );
    this.zoomPages();
  }

  // A page is laid out at the size its document declares, which CSS cannot
  // scale, so each page is zoomed from here: for a fit, by its own size
  // against the room, never past its own size; for a percent, by that share.
  private zoomPages() {
    const room = this.room ?? {
      width: this.clientWidth,
      height: Number.POSITIVE_INFINITY,
    };
    if (!room.width) {
      return;
    }
    for (const page of this.pageRecords ?? []) {
      if (!page.width || !page.height) {
        continue;
      }
      page.scale = zoomScale(this.zoom, page, room);
      page.element.style.zoom = page.scale === 1 ? "" : `${page.scale}`;
    }
  }

  private release() {
    this.generation += 1;
    this.renderState = "empty";
    this.content = null;
    this.pageRecords = null;
  }

  private isCurrent(generation: number) {
    return this.isConnected && this.generation === generation;
  }
}

// The preview shows the document and nothing it would run or open. The
// library draws embedded HTML into an iframe of the app's own origin, and an
// iframe still outside the page has loaded nothing yet, so each one is
// replaced before the document is attached. Links keep their text.
function withholdActiveContent(content: DocumentFragment) {
  for (const frame of content.querySelectorAll("iframe")) {
    const notice = window.document.createElement("p");
    notice.className = "docx-viewer-embedded-html";
    notice.textContent = EMBEDDED_HTML_NOTICE;
    frame.replaceWith(notice);
  }
  for (const link of content.querySelectorAll("a")) {
    link.replaceWith(...link.childNodes);
  }
}

// Word marks the first line of every page it laid out, including a page that
// the document's own page break already started, and the library splits at both
// and leaves an empty page between them. A page after the first with nothing in
// its body is not shown; a document that starts with a page break keeps its
// empty first page.
function dropEmptyPages(content: DocumentFragment) {
  const [, ...followingPages] = content.querySelectorAll("section.docx");
  for (const page of followingPages) {
    const bodies = [...page.querySelectorAll(":scope > article")];
    if (!bodies.some(hasVisibleContent)) {
      page.remove();
    }
  }
}

function hasVisibleContent(element: Element) {
  return (
    (element.textContent ?? "").trim() !== "" ||
    element.querySelector("img, svg, table") !== null
  );
}

async function readBytes(file: Blob | Promise<Blob>) {
  return (await file).arrayBuffer();
}

function loadLibrary() {
  libraryPromise ??= import(DOCX_PREVIEW_IMPORT);
  return libraryPromise;
}

declare global {
  interface HTMLElementEventMap {
    "caffold:docx-document-state": CustomEvent<DocumentRenderState>;
  }

  interface HTMLElementTagNameMap {
    "caffold-docx-document": CaffoldDocxDocument;
  }
}
