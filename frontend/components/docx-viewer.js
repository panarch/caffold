import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";
import "./loading-text.js";

const DOCX_PREVIEW_VERSION = "0.4.1";
const DOCX_PREVIEW_IMPORT =
  `https://cdn.jsdelivr.net/npm/docx-preview@${DOCX_PREVIEW_VERSION}/+esm`;

// A document's text uses the fonts installed on the device rather than the ones
// it embeds. Pictures as data URLs leave no object URLs behind when a document
// is replaced. Pages split where Word last broke them as well as at the
// document's own breaks, though never inside a table.
const RENDER_OPTIONS = {
  ignoreFonts: true,
  useBase64URL: true,
  ignoreLastRenderedPageBreak: false,
};

const EMBEDDED_HTML_NOTICE = "Embedded HTML content is not shown in this preview.";

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

let libraryPromise;

class CaffoldDocxViewer extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Word document preview");
  }

  disconnectedCallback() {
    this.release();
  }

  setSource(source = {}) {
    this.ensureRendered();
    const url = `${source.url ?? ""}`;
    const revision = source.revision ?? null;
    // A rebuilt header or resized pane shows the same file; only another file
    // or a newer modification time is a reason to read it again.
    if (
      this.url === url &&
      this.revision === revision &&
      this.dataset.renderState !== "error"
    ) {
      return;
    }
    this.release();
    this.url = url;
    this.revision = revision;
    this.showMessage("loading", "Loading document...");
    void this.open(this.generation, url);
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Word document preview",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    this.ensureRendered();
    if (!scopeId || !label || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport: this,
        axes: ["vertical"],
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          hasScrollLayoutBox(this),
      }],
      mutationRoots: [this],
      resizeElements: [this],
      scrollRoots: [this],
    };
  }

  async open(generation, url) {
    const reading = new AbortController();
    this.reading = reading;
    try {
      const [docx, bytes] = await Promise.all([
        loadLibrary(),
        readDocument(url, reading.signal),
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }
      const wordDocument = await docx.parseAsync(bytes, RENDER_OPTIONS);
      const nodes = await docx.renderDocument(wordDocument, RENDER_OPTIONS);
      if (!this.isCurrent(generation)) {
        return;
      }
      this.mountDocument(generation, nodes);
    } catch {
      if (this.isCurrent(generation)) {
        this.showMessage("error", "This document could not be displayed.");
      }
    } finally {
      if (this.reading === reading) {
        this.reading = null;
      }
    }
  }

  mountDocument(generation, nodes) {
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
    mount.attachShadow({ mode: "open" }).append(content, style);
    this.body().replaceChildren(mount);

    this.mount = mount;
    this.pages = Array.from(
      mount.shadowRoot.querySelectorAll("section.docx"),
      (element) => ({ element, width: 0 }),
    );
    // Fitted at once, so the document is never shown at a width it overflows;
    // the observer refits it when the viewer's width changes.
    this.fitPages(generation);
    this.dataset.renderState = "docx";
    this.widthObserver = new ResizeObserver(() => this.fitPages(generation));
    this.widthObserver.observe(mount);
  }

  // A page is laid out at the width its document declares, which CSS cannot
  // scale to the space it is given, so a narrower viewer zooms each page down
  // by its own width. A wider viewer leaves the page at its own size.
  fitPages(generation) {
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
      page.element.style.zoom = page.width > available
        ? `${available / page.width}`
        : "";
    }
  }

  release() {
    this.generation = (this.generation ?? 0) + 1;
    this.url = null;
    this.revision = null;
    this.reading?.abort();
    this.reading = null;
    this.widthObserver?.disconnect();
    this.widthObserver = null;
    this.mount = null;
    this.pages = null;
  }

  isCurrent(generation) {
    return this.isConnected && this.generation === generation;
  }

  ensureRendered() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.generation = 0;
    this.dataset.renderState = "empty";
    this.innerHTML = '<div class="docx-viewer-body"></div>';
  }

  showMessage(renderState, message) {
    const body = this.body();
    this.dataset.renderState = renderState;
    body.replaceChildren();
    const paragraph = window.document.createElement("p");
    paragraph.className = "docx-viewer-message";
    if (renderState === "loading") {
      const loadingText = window.document.createElement("caffold-loading-text");
      loadingText.textContent = message;
      paragraph.append(loadingText);
    } else {
      paragraph.textContent = message;
    }
    body.append(paragraph);
  }

  body() {
    return this.querySelector(":scope > .docx-viewer-body");
  }
}

// The preview shows the document and nothing it would run or open. The
// library draws embedded HTML into an iframe of the app's own origin, and an
// iframe still outside the page has loaded nothing yet, so each one is
// replaced before the document is attached. Links keep their text.
function withholdActiveContent(content) {
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
function dropEmptyPages(content) {
  const [, ...followingPages] = content.querySelectorAll("section.docx");
  for (const page of followingPages) {
    const bodies = [...page.querySelectorAll(":scope > article")];
    if (!bodies.some(hasVisibleContent)) {
      page.remove();
    }
  }
}

function hasVisibleContent(element) {
  return element.textContent.trim() !== "" ||
    element.querySelector("img, svg, table") !== null;
}

async function readDocument(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`document request failed with ${response.status}`);
  }
  return response.arrayBuffer();
}

function loadLibrary() {
  libraryPromise ??= import(DOCX_PREVIEW_IMPORT);
  return libraryPromise;
}

customElements.define("caffold-docx-viewer", CaffoldDocxViewer);
