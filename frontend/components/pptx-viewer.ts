import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
} from "../action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "../scroll-scope.js";
import type { DocumentPreviewFile } from "./dom.ts";
import "./loading-text.ts";

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

// The parts of the PowerPoint renderer the viewer uses.
interface PptxViewer {
  load(presentation: unknown): void;
  renderList(options: { windowed: boolean }): Promise<void>;
  destroy(): void;
}

interface PptxRenderer {
  RECOMMENDED_ZIP_LIMITS: unknown;
  parseZipLazyMedia(bytes: ArrayBuffer, limits: unknown): Promise<unknown>;
  buildPresentation(
    files: unknown,
    options: { lazySlides: boolean },
  ): { width: number };
  PptxViewer: new (
    container: HTMLElement,
    options: {
      fitMode: string;
      scrollContainer: HTMLElement;
      pdfjs: boolean;
    },
  ) => PptxViewer;
}

type RenderState = "empty" | "loading" | "error" | "pptx";

let libraryPromise: Promise<PptxRenderer> | undefined;

class CaffoldPptxViewer extends LitElement {
  static properties = {
    file: { attribute: false },
    renderState: { state: true },
    mount: { state: true },
  };

  declare file: DocumentPreviewFile | null;
  declare private renderState: RenderState;
  declare private mount: HTMLElement | null;
  private generation = 0;
  private slideObserver: MutationObserver | null = null;
  private viewer: PptxViewer | null = null;

  constructor() {
    super();
    this.file = null;
    this.renderState = "empty";
    this.mount = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "PowerPoint preview");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.release();
  }

  // The deck is drawn into its mount while it still says it is loading.
  render() {
    const message =
      this.renderState === "loading"
        ? html`<caffold-loading-text>Loading document...</caffold-loading-text>`
        : this.renderState === "error"
          ? "This document could not be displayed."
          : "";
    const content = this.mount
      ? this.mount
      : message
        ? html`<p class="pptx-viewer-message">${message}</p>`
        : nothing;
    return html`<div class="pptx-viewer-body">${content}</div>`;
  }

  // A file handed over again before it is drawn replaces the one before it.
  willUpdate(changed: PropertyValues) {
    if (changed.has("file") && this.file) {
      this.release();
      this.renderState = "loading";
      void this.open(this.generation, this.file.file);
    }
  }

  updated(changed: PropertyValues) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "PowerPoint preview",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (!scopeId || !label || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
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
        },
      ],
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
  }: ActionHintScopeOptions & {
    linkActionId?: string;
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const root = this.mount?.shadowRoot;
    if (
      !scopeId ||
      !linkActionId ||
      !root ||
      !this.isConnected ||
      this.hidden ||
      this.renderState !== "pptx"
    ) {
      return emptyActionHintScope();
    }
    const targets = [];
    for (const slide of root.querySelectorAll<HTMLElement>(
      "[data-slide-index]",
    )) {
      const links = slide.querySelectorAll<HTMLElement>(
        'a[href], [role="link"]',
      );
      for (const [ordinal, control] of [...links].entries()) {
        const label =
          control.localName === "a"
            ? linkActionHintLabel(control)
            : scriptedLinkLabel(control);
        if (!label || !hasActionHintLayoutBox(control)) {
          continue;
        }
        targets.push(
          linkActionHintTarget({
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
              this.renderState === "pptx" &&
              root.contains(control) &&
              hasActionHintLayoutBox(control),
          }),
        );
      }
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this, root],
      scrollRoots: [this],
    };
  }

  private async open(generation: number, file: Blob | Promise<Blob>) {
    try {
      const [library, bytes] = await Promise.all([
        loadLibrary(),
        readBytes(file),
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }
      // Media and slide contents are unpacked when a slide is drawn.
      const files = await library.parseZipLazyMedia(
        bytes,
        library.RECOMMENDED_ZIP_LIMITS,
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      const presentation = library.buildPresentation(files, {
        lazySlides: true,
      });
      const container = this.mountDocument();
      await this.updateComplete;
      if (!this.isCurrent(generation)) {
        return;
      }
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
      this.renderState = "pptx";
    } catch (error) {
      // A fetch let go of is followed by another file or by nothing at all.
      if (
        this.isCurrent(generation) &&
        (error as Error | null)?.name !== "AbortError"
      ) {
        this.viewer?.destroy();
        this.viewer = null;
        this.mount = null;
        this.renderState = "error";
      }
    }
  }

  // The deck's slides live in a shadow root of their own. Media and links on
  // whole shapes are prepared as the renderer adds them, which can be after a
  // slide is drawn, and before the page paints.
  private mountDocument() {
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
    this.mount = mount;
    return container;
  }

  private release() {
    this.generation += 1;
    this.slideObserver?.disconnect();
    this.slideObserver = null;
    this.viewer?.destroy();
    this.viewer = null;
    this.mount = null;
  }

  private isCurrent(generation: number) {
    return this.isConnected && this.generation === generation;
  }
}

// The renderer titles a link without an href by the deck's tooltip, or else
// "Go to slide N" for a link to another slide and the address for a link out
// of the deck.
function scriptedLinkLabel(control: Element) {
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
function exposeShapeLinks(container: HTMLElement) {
  for (const shape of container.querySelectorAll<HTMLElement>(
    "[title]:not(a, [role])",
  )) {
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
function withholdMedia(container: HTMLElement) {
  for (const media of container.querySelectorAll("video, audio")) {
    const poster =
      media.localName === "video" ? media.getAttribute("poster") : "";
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

async function readBytes(file: Blob | Promise<Blob>) {
  return (await file).arrayBuffer();
}

function loadLibrary() {
  libraryPromise ??= import(PPTX_RENDERER_IMPORT);
  return libraryPromise;
}

customElements.define("caffold-pptx-viewer", CaffoldPptxViewer);
