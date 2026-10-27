import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.js";
import "./loading-text.js";
import { CaffoldElement } from "../caffold-element.js";

import styles from "./docx-viewer.css.js";

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

// The library's own rules come first in the shadow root; these follow them to
// replace its grey backdrop and shadowed pages with the viewer's surface.
const DOCUMENT_STYLES = `
  .docx-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 0;
    background: transparent;
  }

  .docx-wrapper > section.docx {
    margin: 0;
    border: 1px solid var(--border);
    box-shadow: none;
  }

  .docx-viewer-embedded-html {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px dashed #b3b3b3;
    color: #595959;
    font-family: var(--font-ui);
    font-size: var(--interface-meta-font-size);
    line-height: var(--interface-line-height);
  }
`;

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

interface PageRecord {
  element: HTMLElement;
  width: number;
}

type RenderState = "empty" | "loading" | "error" | "docx";

let libraryPromise: Promise<DocxPreview> | undefined;

@customElement("caffold-docx-viewer")
class CaffoldDocxViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor file: DocumentPreviewFile | null = null;
  @state()
  private accessor renderState: RenderState = "empty";
  @state()
  private accessor mount: HTMLElement | null = null;

  static override styles = styles;

  private generation = 0;
  private pages: PageRecord[] | null = null;
  private widthObserver: ResizeObserver | null = null;

  private readonly surfaces = new ScrollSurfaces(this);

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Word document preview");
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
        ? this.mount
        : message
          ? html`<p class="docx-viewer-message">${message}</p>`
          : nothing;
    return html`<div
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="docx-viewer-body"
    >${content}</div>`;
  }

  // A file handed over again before it is drawn replaces the one before it.
  override willUpdate(changed: PropertyValues) {
    if (changed.has("file") && this.file) {
      this.release();
      this.renderState = "loading";
      void this.open(this.generation, this.file.file);
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
  }

  scrollSurfaceScope({
    label = "Word document preview",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
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
      await this.mountDocument(generation, nodes);
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

  private async mountDocument(generation: number, nodes: Node[]) {
    const content = window.document.createDocumentFragment();
    content.append(...nodes);
    withholdActiveContent(content);
    dropEmptyPages(content);
    const style = window.document.createElement("style");
    style.textContent = DOCUMENT_STYLES;

    // The document's styles apply only inside this root, and the app's
    // stylesheet does not reach the document.
    const mount = window.document.createElement("div");
    mount.className = "docx-viewer-document";
    const root = mount.attachShadow({ mode: "open" });
    root.append(content, style);
    this.mount = mount;
    this.renderState = "docx";
    await this.updateComplete;
    if (!this.isCurrent(generation)) {
      return;
    }

    this.pages = Array.from(
      root.querySelectorAll<HTMLElement>("section.docx"),
      (element) => ({ element, width: 0 }),
    );
    // Fitted at once, so the document is never shown at a width it overflows;
    // the observer refits it when the viewer's width changes.
    this.fitPages(generation);
    this.widthObserver = new ResizeObserver(() => this.fitPages(generation));
    this.widthObserver.observe(mount);
  }

  // A page is laid out at the width its document declares, which CSS cannot
  // scale to the space it is given, so a narrower viewer zooms each page down
  // by its own width. A wider viewer leaves the page at its own size.
  private fitPages(generation: number) {
    if (!this.isCurrent(generation)) {
      return;
    }
    const available = this.mount?.clientWidth ?? 0;
    if (!available) {
      return;
    }
    for (const page of this.pages ?? []) {
      // Measured once, before any zoom applies.
      page.width ||= page.element.offsetWidth;
      page.element.style.zoom =
        page.width > available ? `${available / page.width}` : "";
    }
  }

  private release() {
    this.generation += 1;
    this.widthObserver?.disconnect();
    this.widthObserver = null;
    this.mount = null;
    this.pages = null;
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
  interface HTMLElementTagNameMap {
    "caffold-docx-viewer": CaffoldDocxViewer;
  }
}
