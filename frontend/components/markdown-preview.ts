import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  type LinkActionHintBinding,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
} from "../action-hint-scope.js";
import { imageUrl } from "../api.js";
import { fetchInChunks } from "../chunked-fetch.ts";
import { parseLinkRoute } from "../navigation-routes.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "../scroll-scope.js";
import "./loading-text.ts";

const MARKED_IMPORT = "https://esm.sh/marked@15.0.12";

// An image starts fetching when it comes this close to view, as a
// conversation thumbnail does. `scrollMargin` is newer than TypeScript's DOM
// types.
const NEARBY_MARGIN = "2500px 0px";
const NEARBY_IMAGES: IntersectionObserverInit & { scrollMargin: string } = {
  rootMargin: NEARBY_MARGIN,
  scrollMargin: NEARBY_MARGIN,
};

// The natural size of each workspace image drawn lately, shared by every
// preview in the page. Drawing the same Markdown again holds each image's
// place at that size before its file arrives, so the restored reading position
// stays put.
const drawnImageSizes = new Map<string, { width: number; height: number }>();
const DRAWN_IMAGE_SIZE_LIMIT = 500;

type RenderState = "loading" | "plain" | "markdown";

// The Markdown file's folder and the Task root, both from the workspace root.
export interface MarkdownImages {
  folder?: string;
  root?: string;
}

export interface ScrollPosition {
  top: number;
  left: number;
}

interface LinkRecord {
  control: HTMLAnchorElement;
  ordinal: number;
  binding: LinkActionHintBinding;
}

interface ScrollSurfaceRecord {
  kind: "code" | "table";
  ordinal: number;
  label: string;
  scrollport: HTMLElement;
}

interface FetchedImage {
  fetching: AbortController;
  objectUrl: string;
}

type ParseMarkdown = (
  source: string,
  options: Record<string, unknown>,
) => string | Promise<string>;

// marked's module export is the parser, which also carries `parse`.
type MarkedParser = ParseMarkdown & { parse?: ParseMarkdown };

let parserPromise: Promise<MarkedParser> | null = null;

export class CaffoldMarkdownPreview extends LitElement {
  static properties = {
    renderState: { state: true },
    markdown: { state: true },
    renderedContent: { state: true },
  };

  declare private renderState: RenderState | null;
  declare private markdown: string | undefined;
  declare private renderedContent: DocumentFragment | null;
  private images: MarkdownImages | null = null;
  private pendingScroll: ScrollPosition | null = null;
  private renderToken: symbol | null = null;
  private actionHintLinks: LinkRecord[] = [];
  private scrollSurfaceRecords: ScrollSurfaceRecord[] = [];
  private fetchedImages = new Map<HTMLElement, FetchedImage>();
  private imageObserver: IntersectionObserver | null = null;

  constructor() {
    super();
    this.renderState = null;
    this.renderedContent = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Markdown preview");
    this.performUpdate();
    if (this.markdown !== undefined && this.renderState === "loading") {
      this.startRender();
    } else if (this.renderState === "markdown") {
      this.watchImages();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.renderToken = null;
    this.releaseImages();
  }

  render() {
    const content =
      this.renderState === "markdown"
        ? this.renderedContent
        : this.renderState === "plain"
          ? html`<pre class="markdown-preview-fallback">${this.markdown}</pre>`
          : this.renderState === "loading"
            ? html`<span
                class="markdown-preview-loading"
                role="status"
              >Rendering Markdown...</span>`
            : nothing;
    return html`<article class="markdown-preview-body">${content}</article>`;
  }

  updated(changed: PropertyValues) {
    if (changed.has("renderState") && this.renderState) {
      this.dataset.renderState = this.renderState;
    }
  }

  // `images` names the Markdown file's folder and the Task root, both from
  // the workspace root, for the owner whose Markdown is a file there. Without
  // it every image stays its description.
  setMarkdown(
    markdown: string | null | undefined,
    options: {
      preserveScroll?: boolean;
      scroll?: ScrollPosition | null;
      images?: MarkdownImages | null;
    } = {},
  ) {
    const scroll = options.preserveScroll
      ? this.getScrollState()
      : (options.scroll ?? null);
    this.markdown = `${markdown ?? ""}`;
    this.images = options.images ?? null;
    this.pendingScroll = scroll;
    this.renderPending();
    this.startRender();
  }

  getScrollState() {
    return { top: this.scrollTop, left: this.scrollLeft };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Markdown preview",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (!scopeId || !label || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const ownScope: ScrollSurfaceScope = {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport: this,
          axes: ["vertical", "horizontal"],
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
    const body = this.body();
    const nestedScopes = (this.scrollSurfaceRecords ?? []).map(
      (record): ScrollSurfaceScope => {
        const nested = record.scrollport;
        return {
          blocked: false,
          surfaces: [
            {
              id: `${scopeId}:${record.kind}:${record.ordinal}`,
              label: `${label} ${record.label}`,
              scrollport: nested,
              axes: ["horizontal"],
              clipRoots: [this, body, nested, ...clipRoots].filter(
                (root): root is Element => Boolean(root),
              ),
              isEligible: () =>
                this.isConnected &&
                !this.hidden &&
                isCurrent() &&
                this.renderState === "markdown" &&
                this.body() === body &&
                Boolean(this.scrollSurfaceRecords?.includes(record)) &&
                Boolean(body?.contains(nested)) &&
                hasScrollLayoutBox(this) &&
                hasScrollLayoutBox(nested),
            },
          ],
          mutationRoots: [this],
          resizeElements: [this, nested],
          scrollRoots: [this, nested],
        };
      },
    );
    return mergeScrollSurfaceScopes(ownScope, ...nestedScopes);
  }

  actionHintScope({
    scopeId = "",
    linkActionId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    linkActionId?: string;
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const body = this.body();
    if (
      !scopeId ||
      !linkActionId ||
      !body ||
      !this.isConnected ||
      this.hidden ||
      this.renderState !== "markdown"
    ) {
      return emptyActionHintScope();
    }
    const tableScrollRoots: Element[] = [];
    const targets = (this.actionHintLinks ?? []).flatMap((record) => {
      const { binding, control, ordinal } = record;
      const label = linkActionHintLabel(control);
      if (
        !label ||
        !matchesLinkActionHintBinding(control, binding) ||
        !body.contains(control) ||
        !hasActionHintLayoutBox(control)
      ) {
        return [];
      }
      const tableScrollRoot = control.closest(".markdown-preview-table-scroll");
      if (tableScrollRoot && body.contains(tableScrollRoot)) {
        tableScrollRoots.push(tableScrollRoot);
      }
      return [
        linkActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:link:${ordinal}`,
          actionId: linkActionId,
          label,
          control,
          clipRoots: [this, body, tableScrollRoot, ...clipRoots].filter(
            (root): root is Element => Boolean(root),
          ),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.renderState === "markdown" &&
            this.body() === body &&
            Boolean(this.actionHintLinks?.includes(record)) &&
            body.contains(control) &&
            matchesLinkActionHintBinding(control, binding) &&
            Boolean(linkActionHintLabel(control)) &&
            hasActionHintLayoutBox(control),
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [this, ...new Set(tableScrollRoots)],
    };
  }

  // A released image loses its copy and goes back to loading, so the preview
  // fetches it again if it is shown again.
  private releaseImages() {
    this.imageObserver?.disconnect();
    for (const [slot, record] of this.fetchedImages ?? []) {
      record.fetching.abort();
      if (record.objectUrl) {
        URL.revokeObjectURL(record.objectUrl);
      }
      const image = slot.querySelector<HTMLImageElement>(":scope > img");
      image?.removeAttribute("src");
      if (image) {
        image.hidden = true;
      }
      const loading = slot.querySelector<HTMLElement>(
        ":scope > caffold-loading-text",
      );
      if (loading) {
        loading.hidden = false;
      }
    }
    this.fetchedImages?.clear();
  }

  private watchImages() {
    const slots =
      this.body()?.querySelectorAll<HTMLElement>(".markdown-preview-image") ??
      [];
    if (!slots.length) {
      return;
    }
    this.imageObserver ??= new IntersectionObserver(
      (entries) => this.fetchNearbyImages(entries),
      NEARBY_IMAGES,
    );
    for (const slot of slots) {
      this.imageObserver.observe(slot);
    }
  }

  private fetchNearbyImages(entries: IntersectionObserverEntry[]) {
    for (const { target, isIntersecting } of entries) {
      const slot = target as HTMLElement;
      if (!isIntersecting || this.fetchedImages.has(slot)) {
        continue;
      }
      this.imageObserver?.unobserve(slot);
      const fetching = new AbortController();
      const record: FetchedImage = { fetching, objectUrl: "" };
      this.fetchedImages.set(slot, record);
      const current = () => this.fetchedImages.get(slot) === record;
      const image = slot.querySelector<HTMLImageElement>(":scope > img");
      const path = slot.dataset.imagePath ?? "";
      fetchInChunks(imageUrl(path), { signal: fetching.signal }).then(
        ({ file }) => {
          if (!current() || !image) {
            return;
          }
          record.objectUrl = URL.createObjectURL(file);
          image.addEventListener(
            "load",
            () => {
              if (current()) {
                rememberDrawnSize(path, image);
                image.hidden = false;
                const loading = slot.querySelector<HTMLElement>(
                  ":scope > caffold-loading-text",
                );
                if (loading) {
                  loading.hidden = true;
                }
                delete slot.dataset.reserved;
              }
            },
            { once: true },
          );
          image.addEventListener(
            "error",
            () => {
              if (current()) {
                this.dropImage(slot);
              }
            },
            { once: true },
          );
          image.src = record.objectUrl;
        },
        (error) => {
          if (current() && (error as Error | null)?.name !== "AbortError") {
            this.dropImage(slot);
          }
        },
      );
    }
  }

  // An image Caffold could not read or draw reads as its description, as an
  // image the preview does not fetch does.
  private dropImage(slot: HTMLElement) {
    const record = this.fetchedImages.get(slot);
    if (record?.objectUrl) {
      URL.revokeObjectURL(record.objectUrl);
    }
    this.fetchedImages.delete(slot);
    slot.replaceWith(imagePlaceholder(slot.querySelector(":scope > img")));
  }

  private renderPending() {
    this.releaseImages();
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.renderedContent = null;
    this.renderState = "loading";
    this.performUpdate();
  }

  private renderPlainText(renderToken: symbol, scroll: ScrollPosition | null) {
    if (!this.acceptRender(renderToken)) {
      return;
    }
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.renderState = "plain";
    this.performUpdate();
    this.pendingScroll = null;
    restoreScroll(this, scroll);
  }

  private startRender() {
    const renderToken = Symbol("review-markdown-preview");
    this.renderToken = renderToken;
    void this.renderMarkdown(renderToken, this.pendingScroll);
  }

  private async renderMarkdown(
    renderToken: symbol,
    scroll: ScrollPosition | null,
  ) {
    try {
      const content = await markdownContent(this.markdown, this.images);
      if (!this.acceptRender(renderToken)) {
        return;
      }
      this.renderedContent = content;
      this.renderState = "markdown";
      this.performUpdate();
      const body = this.body();
      this.actionHintLinks = body ? collectActionHintLinks(body) : [];
      this.scrollSurfaceRecords = body ? collectScrollSurfaceRecords(body) : [];
      this.pendingScroll = null;
      restoreScroll(this, scroll);
      this.watchImages();
    } catch {
      parserPromise = null;
      this.renderPlainText(renderToken, scroll);
    }
  }

  private acceptRender(renderToken: symbol) {
    return (
      this.renderToken === renderToken && Boolean(this.body()?.isConnected)
    );
  }

  private body() {
    return this.querySelector<HTMLElement>(":scope > .markdown-preview-body");
  }
}

function collectActionHintLinks(root: Element): LinkRecord[] {
  return Array.from(
    root.querySelectorAll<HTMLAnchorElement>("a[href]"),
  ).flatMap((control, index) => {
    const binding = captureLinkActionHintBinding(control);
    return binding.href &&
      !binding.href.startsWith("#") &&
      linkActionHintLabel(control)
      ? [{ control, ordinal: index + 1, binding }]
      : [];
  });
}

function collectScrollSurfaceRecords(root: Element): ScrollSurfaceRecord[] {
  const ordinals = new Map<string, number>();
  return Array.from(
    root.querySelectorAll<HTMLElement>("pre, .markdown-preview-table-scroll"),
  ).map((scrollport) => {
    const kind = scrollport.localName === "pre" ? "code" : "table";
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    return {
      kind,
      ordinal,
      label:
        kind === "code" ? `code block ${ordinal}` : `Markdown table ${ordinal}`,
      scrollport,
    };
  });
}

customElements.define("caffold-markdown-preview", CaffoldMarkdownPreview);

async function markdownContent(
  markdown: string | undefined,
  images: MarkdownImages | null,
) {
  const parser = await loadParser();
  const source = `${markdown ?? ""}`.replace(/^[\u200B-\u200F\uFEFF]/, "");
  const parse = parser.parse?.bind(parser) ?? parser;
  const markup = await parse(source, { gfm: true, breaks: false });
  const template = document.createElement("template");
  template.innerHTML = `${markup ?? ""}`;
  sanitizeChildren(template.content, images);
  wrapTables(template.content);
  return template.content;
}

function loadParser() {
  parserPromise ??= import(MARKED_IMPORT).then(
    (module) => module.marked ?? module.default ?? module,
  );
  return parserPromise;
}

function sanitizeChildren(
  parent: Element | DocumentFragment,
  images: MarkdownImages | null,
) {
  for (const element of [...parent.children]) {
    const tagName = element.localName;
    if (FORBIDDEN_ELEMENTS.has(tagName)) {
      element.remove();
      continue;
    }
    if (tagName === "img") {
      const path = images
        ? localImagePath(element.getAttribute("src"), images)
        : "";
      element.replaceWith(
        path ? imageSlot(element, path) : imagePlaceholder(element),
      );
      continue;
    }

    sanitizeChildren(element, images);
    if (!ALLOWED_ELEMENTS.has(tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    if (tagName === "input" && !sanitizeInput(element as HTMLInputElement)) {
      element.remove();
      continue;
    }

    sanitizeAttributes(element);
    if (tagName === "a") {
      sanitizeLink(element as HTMLAnchorElement);
    }
  }
}

function imagePlaceholder(image: Element | null) {
  const placeholder = document.createElement("span");
  placeholder.className = "markdown-preview-image-placeholder";
  const alt = `${image?.getAttribute("alt") ?? ""}`.trim();
  placeholder.textContent = alt ? `[Image: ${alt}]` : "[Image]";
  return placeholder;
}

// The workspace path an image address names, read as a repository reads its
// Markdown: beside the file, or from the Task root when the address starts
// with "/". An address with a scheme or a host, or one that climbs above the
// workspace root, names no file Caffold serves.
function localImagePath(
  source: string | null,
  { folder = "", root = "" }: MarkdownImages,
) {
  const address = `${source ?? ""}`.trim().split(/[?#]/, 1)[0];
  if (
    !address ||
    address.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(address)
  ) {
    return "";
  }
  let path: string;
  try {
    path = decodeURIComponent(address);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const part of `${path.startsWith("/") ? root : folder}/${path}`.split(
    "/",
  )) {
    if (part === "..") {
      if (!parts.length) {
        return "";
      }
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

// A fresh picture with only what describes and sizes it, kept hidden behind
// its loading phrase until its file is fetched. A size known before then
// holds the picture's place.
function imageSlot(source: Element, path: string) {
  const slot = document.createElement("span");
  slot.className = "markdown-preview-image";
  slot.dataset.imagePath = path;
  const image = document.createElement("img");
  for (const name of ["alt", "title"]) {
    const value = source.getAttribute(name);
    if (value !== null) {
      image.setAttribute(name, value);
    }
  }
  for (const name of ["width", "height"]) {
    const value = `${source.getAttribute(name) ?? ""}`.trim();
    if (/^\d+$/.test(value) && Number(value) > 0) {
      image.setAttribute(name, value);
    }
  }
  const drawn = drawnImageSizes.get(path);
  const width = Number(image.getAttribute("width")) || drawn?.width;
  const ratio = drawn
    ? `${drawn.width} / ${drawn.height}`
    : image.hasAttribute("height") &&
      `${width} / ${image.getAttribute("height")}`;
  if (width && ratio) {
    slot.dataset.reserved = "";
    slot.style.setProperty("--markdown-image-width", `${width}px`);
    slot.style.setProperty("--markdown-image-ratio", ratio);
  }
  image.hidden = true;
  const loading = document.createElement("caffold-loading-text");
  loading.textContent = "Loading image...";
  slot.append(image, loading);
  return slot;
}

function rememberDrawnSize(path: string, image: HTMLImageElement) {
  if (!image.naturalWidth || !image.naturalHeight) {
    return;
  }
  drawnImageSizes.delete(path);
  drawnImageSizes.set(path, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  if (drawnImageSizes.size > DRAWN_IMAGE_SIZE_LIMIT) {
    const oldest = drawnImageSizes.keys().next().value;
    if (oldest !== undefined) {
      drawnImageSizes.delete(oldest);
    }
  }
}

function sanitizeInput(element: HTMLInputElement) {
  if (element.getAttribute("type") !== "checkbox") {
    return false;
  }
  element.disabled = true;
  return true;
}

function sanitizeAttributes(element: Element) {
  const allowed =
    element.localName === "a"
      ? new Set(["href", "title"])
      : element.localName === "input"
        ? new Set(["checked", "disabled", "type"])
        : element.localName === "ol" &&
            /^-?[0-9]+$/.test(element.getAttribute("start") ?? "")
          ? new Set(["start"])
          : new Set<string>();

  for (const attribute of [...element.attributes]) {
    if (!allowed.has(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeLink(element: HTMLAnchorElement) {
  const href = `${element.getAttribute("href") ?? ""}`.trim();
  if (parseLinkRoute(href)?.kind === "notes") {
    return;
  }
  if (!isExternalUrl(href)) {
    element.replaceWith(...element.childNodes);
    return;
  }
  element.target = "_blank";
  element.rel = "noreferrer";
}

function isExternalUrl(value: string) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function wrapTables(parent: DocumentFragment) {
  for (const table of [...parent.querySelectorAll("table")]) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-preview-table-scroll";
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.append(table);
  }
}

function restoreScroll(scroller: Element, scroll: ScrollPosition | null) {
  if (!scroll) {
    return;
  }
  scroller.scrollTop = scroll.top;
  scroller.scrollLeft = scroll.left;
}

const ALLOWED_ELEMENTS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const FORBIDDEN_ELEMENTS = new Set([
  "base",
  "button",
  "embed",
  "form",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "select",
  "style",
  "textarea",
]);
