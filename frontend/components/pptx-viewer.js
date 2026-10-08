import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
} from "../action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";
import "./loading-text.js";

const PPTX_RENDERER_VERSION = "1.3.0";
const PPTX_RENDERER_IMPORT =
  `https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@${PPTX_RENDERER_VERSION}` +
  "/dist/aiden0z-pptx-renderer.browser.es.js";

const MEDIA_NOTICE = "Media is not played in this preview.";

// The renderer styles each slide inline; these replace its shadowed, 20px-apart
// slides with pages framed and spaced like the other document viewers'.
const DOCUMENT_STYLES = `
  .pptx-viewer-slides {
    margin-inline: auto;
  }

  [data-slide-index] {
    margin-bottom: 1rem !important;
  }

  [data-slide-index]:last-child {
    margin-bottom: 0 !important;
  }

  [data-slide-index] > div {
    box-shadow: 0 0 0 1px var(--border) !important;
  }

  .pptx-viewer-media-poster {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .pptx-viewer-media-notice {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0.5rem 0.75rem;
    box-sizing: border-box;
    border: 1px dashed #b3b3b3;
    color: #595959;
    font-family: var(--font-ui);
    font-size: var(--interface-meta-font-size);
    line-height: var(--interface-line-height);
    text-align: center;
  }
`;

let libraryPromise;

class CaffoldPptxViewer extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "PowerPoint preview");
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
    label = "PowerPoint preview",
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

  // The links of the slides drawn now: anchors out of the deck, and the links
  // the renderer draws without an href, to another slide or on a whole shape.
  actionHintScope({
    scopeId = "",
    linkActionId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const root = this.mount?.shadowRoot;
    if (
      !scopeId ||
      !linkActionId ||
      !root ||
      !this.isConnected ||
      this.hidden ||
      this.dataset.renderState !== "pptx"
    ) {
      return emptyActionHintScope();
    }
    const targets = [];
    for (const slide of root.querySelectorAll("[data-slide-index]")) {
      const links = slide.querySelectorAll('a[href], [role="link"]');
      for (const [ordinal, control] of [...links].entries()) {
        const label = control.localName === "a"
          ? linkActionHintLabel(control)
          : scriptedLinkLabel(control);
        if (!label || !hasActionHintLayoutBox(control)) {
          continue;
        }
        targets.push(linkActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:slide:${slide.dataset.slideIndex}:link:${ordinal}`,
          actionId: linkActionId,
          label,
          control,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.dataset.renderState === "pptx" &&
            root.contains(control) &&
            hasActionHintLayoutBox(control),
        }));
      }
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this, root],
      scrollRoots: [this],
    };
  }

  async open(generation, url) {
    const reading = new AbortController();
    this.reading = reading;
    try {
      const [library, bytes] = await Promise.all([
        loadLibrary(),
        readDocument(url, reading.signal),
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }
      // Media and slide contents are unpacked when a slide is drawn.
      const files = await library.parseZipLazyMedia(bytes, library.RECOMMENDED_ZIP_LIMITS);
      if (!this.isCurrent(generation)) {
        return;
      }
      const presentation = library.buildPresentation(files, { lazySlides: true });
      const container = this.mountDocument();
      // `contain` scales a slide to its container's width, so a container no
      // wider than the slide keeps a wide panel from enlarging it.
      container.style.maxWidth = `${presentation.width}px`;
      const viewer = new library.PptxViewer(container, {
        fitMode: "contain",
        // The viewer is the scrollport, so slides near it are the ones drawn.
        scrollContainer: this,
        pdfjs: false,
      });
      this.viewer = viewer;
      viewer.load(presentation);
      await viewer.renderList({ windowed: true });
      if (!this.isCurrent(generation)) {
        return;
      }
      this.dataset.renderState = "pptx";
    } catch {
      if (this.isCurrent(generation)) {
        this.viewer?.destroy();
        this.viewer = null;
        this.showMessage("error", "This document could not be displayed.");
      }
    } finally {
      if (this.reading === reading) {
        this.reading = null;
      }
    }
  }

  // The deck's slides live in a shadow root of their own. Media and links on
  // whole shapes are prepared as the renderer adds them, which can be after a
  // slide is drawn, and before the page paints.
  mountDocument() {
    const mount = window.document.createElement("div");
    mount.className = "pptx-viewer-document";
    const root = mount.attachShadow({ mode: "open" });
    const style = window.document.createElement("style");
    style.textContent = DOCUMENT_STYLES;
    const container = window.document.createElement("div");
    container.className = "pptx-viewer-slides";
    root.append(style, container);
    this.slideObserver = new MutationObserver(() => {
      withholdMedia(container);
      exposeShapeLinks(container);
    });
    this.slideObserver.observe(container, { childList: true, subtree: true });
    this.body().replaceChildren(mount);
    this.mount = mount;
    return container;
  }

  release() {
    this.generation = (this.generation ?? 0) + 1;
    this.url = null;
    this.revision = null;
    this.reading?.abort();
    this.reading = null;
    this.slideObserver?.disconnect();
    this.slideObserver = null;
    this.viewer?.destroy();
    this.viewer = null;
    this.mount = null;
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
    this.innerHTML = '<div class="pptx-viewer-body"></div>';
  }

  showMessage(renderState, message) {
    const body = this.body();
    this.dataset.renderState = renderState;
    body.replaceChildren();
    const paragraph = window.document.createElement("p");
    paragraph.className = "pptx-viewer-message";
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
    return this.querySelector(":scope > .pptx-viewer-body");
  }
}

// The renderer titles a link without an href by the deck's tooltip, or else
// "Go to slide N" for a link to another slide and the address for a link out
// of the deck.
function scriptedLinkLabel(control) {
  const title = control.getAttribute("title")?.trim() ?? "";
  const text = control.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const slide = title.match(/^Go to slide (\d+)$/)?.[1];
  if (slide) {
    return text ? `Go to ${text} (slide ${slide})` : title;
  }
  if (/^(?:https?|mailto):/i.test(title)) {
    return `Open ${text || title}`;
  }
  return text ? `Go to ${text}` : title;
}

// The renderer makes a whole shape or picture a link with a pointer cursor, a
// title, and a click handler, but leaves it out of the keyboard's reach.
function exposeShapeLinks(container) {
  for (const shape of container.querySelectorAll("[title]:not(a, [role])")) {
    if (shape.style.cursor !== "pointer") {
      continue;
    }
    shape.setAttribute("role", "link");
    shape.tabIndex = 0;
    shape.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        shape.click();
      }
    });
  }
}

// A video shows its poster and an audio clip the picture the deck gives it;
// neither plays.
function withholdMedia(container) {
  for (const media of container.querySelectorAll("video, audio")) {
    const poster = media.localName === "video" ? media.getAttribute("poster") : "";
    if (poster) {
      const image = window.document.createElement("img");
      image.className = "pptx-viewer-media-poster";
      image.alt = "";
      image.src = poster;
      media.replaceWith(image);
    } else if (media.parentElement?.querySelector(":scope > img")) {
      media.remove();
    } else {
      const notice = window.document.createElement("p");
      notice.className = "pptx-viewer-media-notice";
      notice.textContent = MEDIA_NOTICE;
      media.replaceWith(notice);
    }
  }
}

async function readDocument(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`document request failed with ${response.status}`);
  }
  return response.arrayBuffer();
}

function loadLibrary() {
  libraryPromise ??= import(PPTX_RENDERER_IMPORT);
  return libraryPromise;
}

customElements.define("caffold-pptx-viewer", CaffoldPptxViewer);
