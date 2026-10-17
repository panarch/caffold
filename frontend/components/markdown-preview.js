import {
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
} from "../action-hint-scope.js";
import { imageUrl } from "../api.js";
import { fetchInChunks } from "../chunked-fetch.js";
import { parseLinkRoute } from "../navigation-routes.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../scroll-scope.js";
import "./loading-text.js";

const MARKED_IMPORT = "https://esm.sh/marked@15.0.12";

// An image starts fetching when it comes this close to view, as a
// conversation thumbnail does.
const NEARBY_MARGIN = "2500px 0px";

// The natural size of each workspace image drawn lately, shared by every
// preview in the page. Drawing the same Markdown again holds each image's
// place at that size before its file arrives, so the restored reading position
// stays put.
const drawnImageSizes = new Map();
const DRAWN_IMAGE_SIZE_LIMIT = 500;

let parserPromise;

class CaffoldMarkdownPreview extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Markdown preview");
    if (this.markdown !== undefined && this.dataset.renderState === "loading") {
      this.startRender();
    } else if (this.dataset.renderState === "markdown") {
      this.watchImages();
    }
  }

  disconnectedCallback() {
    this.renderToken = null;
    this.releaseImages();
  }

  ensureRendered() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.fetchedImages = new Map();
    this.innerHTML = '<article class="markdown-preview-body"></article>';
  }

  // `images` names the Markdown file's folder and the Task root, both from
  // the workspace root, for the owner whose Markdown is a file there. Without
  // it every image stays its description.
  setMarkdown(markdown, options = {}) {
    this.ensureRendered();
    const scroll = options.preserveScroll
      ? this.getScrollState()
      : options.scroll ?? null;
    this.markdown = `${markdown ?? ""}`;
    this.images = options.images ?? null;
    this.pendingScroll = scroll;
    this.renderPending();
    this.startRender();
  }

  // A released image loses its copy and goes back to loading, so the preview
  // fetches it again if it is shown again.
  releaseImages() {
    this.imageObserver?.disconnect();
    for (const [slot, record] of this.fetchedImages ?? []) {
      record.fetching.abort();
      if (record.objectUrl) {
        URL.revokeObjectURL(record.objectUrl);
      }
      const image = slot.querySelector(":scope > img");
      image?.removeAttribute("src");
      if (image) {
        image.hidden = true;
      }
      const loading = slot.querySelector(":scope > caffold-loading-text");
      if (loading) {
        loading.hidden = false;
      }
    }
    this.fetchedImages?.clear();
  }

  watchImages() {
    const slots = this.body()?.querySelectorAll(".markdown-preview-image") ?? [];
    if (!slots.length) {
      return;
    }
    this.imageObserver ??= new IntersectionObserver(
      (entries) => this.fetchNearbyImages(entries),
      { rootMargin: NEARBY_MARGIN, scrollMargin: NEARBY_MARGIN },
    );
    for (const slot of slots) {
      this.imageObserver.observe(slot);
    }
  }

  fetchNearbyImages(entries) {
    for (const { target: slot, isIntersecting } of entries) {
      if (!isIntersecting || this.fetchedImages.has(slot)) {
        continue;
      }
      this.imageObserver.unobserve(slot);
      const fetching = new AbortController();
      const record = { fetching, objectUrl: "" };
      this.fetchedImages.set(slot, record);
      const current = () => this.fetchedImages.get(slot) === record;
      const image = slot.querySelector(":scope > img");
      fetchInChunks(imageUrl(slot.dataset.imagePath), {
        signal: fetching.signal,
      }).then(
        ({ file }) => {
          if (!current()) {
            return;
          }
          record.objectUrl = URL.createObjectURL(file);
          image.addEventListener("load", () => {
            if (current()) {
              rememberDrawnSize(slot.dataset.imagePath, image);
              image.hidden = false;
              slot.querySelector(":scope > caffold-loading-text").hidden = true;
              delete slot.dataset.reserved;
            }
          }, { once: true });
          image.addEventListener("error", () => {
            if (current()) {
              this.dropImage(slot);
            }
          }, { once: true });
          image.src = record.objectUrl;
        },
        (error) => {
          if (current() && error?.name !== "AbortError") {
            this.dropImage(slot);
          }
        },
      );
    }
  }

  // An image Caffold could not read or draw reads as its description, as an
  // image the preview does not fetch does.
  dropImage(slot) {
    const record = this.fetchedImages.get(slot);
    if (record?.objectUrl) {
      URL.revokeObjectURL(record.objectUrl);
    }
    this.fetchedImages.delete(slot);
    slot.replaceWith(imagePlaceholder(slot.querySelector(":scope > img")));
  }

  getScrollState() {
    return { top: this.scrollTop, left: this.scrollLeft };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Markdown preview",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    this.ensureRendered();
    if (!scopeId || !label || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this;
    const ownScope = {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        axes: ["vertical", "horizontal"],
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
    const body = this.body();
    const nestedScopes = (this.scrollSurfaceRecords ?? []).map((record) => {
      const nested = record.scrollport;
      return {
        blocked: false,
        surfaces: [{
          id: `${scopeId}:${record.kind}:${record.ordinal}`,
          label: `${label} ${record.label}`,
          scrollport: nested,
          axes: ["horizontal"],
          clipRoots: [this, body, nested, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.dataset.renderState === "markdown" &&
            this.body() === body &&
            this.scrollSurfaceRecords?.includes(record) &&
            body?.contains(nested) &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(nested),
        }],
        mutationRoots: [this],
        resizeElements: [this, nested],
        scrollRoots: [this, nested],
      };
    });
    return mergeScrollSurfaceScopes(ownScope, ...nestedScopes);
  }

  actionHintScope({
    scopeId = "",
    linkActionId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    this.ensureRendered();
    const body = this.body();
    if (
      !scopeId ||
      !linkActionId ||
      !body ||
      !this.isConnected ||
      this.hidden ||
      this.dataset.renderState !== "markdown"
    ) {
      return emptyActionHintScope();
    }
    const tableScrollRoots = [];
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
      const tableScrollRoot = control.closest(
        ".markdown-preview-table-scroll",
      );
      if (tableScrollRoot && body.contains(tableScrollRoot)) {
        tableScrollRoots.push(tableScrollRoot);
      }
      return [linkActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:link:${ordinal}`,
        actionId: linkActionId,
        label,
        control,
        clipRoots: [
          this,
          body,
          tableScrollRoot,
          ...clipRoots,
        ].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.dataset.renderState === "markdown" &&
          this.body() === body &&
          this.actionHintLinks?.includes(record) &&
          body.contains(control) &&
          matchesLinkActionHintBinding(control, binding) &&
          Boolean(linkActionHintLabel(control)) &&
          hasActionHintLayoutBox(control),
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [this, ...new Set(tableScrollRoots)],
    };
  }

  renderPending() {
    this.releaseImages();
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    const pending = document.createElement("span");
    pending.className = "markdown-preview-loading";
    pending.setAttribute("role", "status");
    pending.textContent = "Rendering Markdown...";
    this.body().replaceChildren(pending);
    this.dataset.renderState = "loading";
  }

  renderPlainText(renderToken, scroll) {
    if (!this.acceptRender(renderToken)) {
      return;
    }
    const fallback = document.createElement("pre");
    fallback.className = "markdown-preview-fallback";
    fallback.textContent = this.markdown;
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.body().replaceChildren(fallback);
    this.dataset.renderState = "plain";
    this.pendingScroll = null;
    restoreScroll(this, scroll);
  }

  startRender() {
    const renderToken = Symbol("review-markdown-preview");
    this.renderToken = renderToken;
    void this.renderMarkdown(renderToken, this.pendingScroll);
  }

  async renderMarkdown(renderToken, scroll) {
    try {
      const content = await markdownContent(this.markdown, this.images);
      if (!this.acceptRender(renderToken)) {
        return;
      }
      const body = this.body();
      body.replaceChildren(content);
      this.actionHintLinks = collectActionHintLinks(body);
      this.scrollSurfaceRecords = collectScrollSurfaceRecords(body);
      this.dataset.renderState = "markdown";
      this.pendingScroll = null;
      restoreScroll(this, scroll);
      this.watchImages();
    } catch {
      parserPromise = null;
      this.renderPlainText(renderToken, scroll);
    }
  }

  acceptRender(renderToken) {
    return this.renderToken === renderToken && this.body()?.isConnected;
  }

  body() {
    return this.querySelector(":scope > .markdown-preview-body");
  }
}

function collectActionHintLinks(root) {
  return Array.from(root.querySelectorAll("a[href]")).flatMap(
    (control, index) => {
      const binding = captureLinkActionHintBinding(control);
      return binding.href &&
          !binding.href.startsWith("#") &&
          linkActionHintLabel(control)
        ? [{ control, ordinal: index + 1, binding }]
        : [];
    },
  );
}

function collectScrollSurfaceRecords(root) {
  const ordinals = new Map();
  return Array.from(
    root.querySelectorAll("pre, .markdown-preview-table-scroll"),
  ).map((scrollport) => {
    const kind = scrollport.localName === "pre" ? "code" : "table";
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    return {
      kind,
      ordinal,
      label: kind === "code"
        ? `code block ${ordinal}`
        : `Markdown table ${ordinal}`,
      scrollport,
    };
  });
}

if (!customElements.get("caffold-markdown-preview")) {
  customElements.define("caffold-markdown-preview", CaffoldMarkdownPreview);
}

async function markdownContent(markdown, images) {
  const parser = await loadParser();
  const source = `${markdown ?? ""}`.replace(/^[\u200B-\u200F\uFEFF]/, "");
  const parse = parser.parse?.bind(parser) ?? parser;
  const html = await parse(source, { gfm: true, breaks: false });
  const template = document.createElement("template");
  template.innerHTML = `${html ?? ""}`;
  sanitizeChildren(template.content, images);
  wrapTables(template.content);
  return template.content;
}

function loadParser() {
  if (!parserPromise) {
    parserPromise = import(MARKED_IMPORT).then(
      (module) => module.marked ?? module.default ?? module,
    );
  }
  return parserPromise;
}

function sanitizeChildren(parent, images) {
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
    if (tagName === "input" && !sanitizeInput(element)) {
      element.remove();
      continue;
    }

    sanitizeAttributes(element);
    if (tagName === "a") {
      sanitizeLink(element);
    }
  }
}

function imagePlaceholder(image) {
  const placeholder = document.createElement("span");
  placeholder.className = "markdown-preview-image-placeholder";
  const alt = `${image.getAttribute("alt") ?? ""}`.trim();
  placeholder.textContent = alt ? `[Image: ${alt}]` : "[Image]";
  return placeholder;
}

// The workspace path an image address names, read as a repository reads its
// Markdown: beside the file, or from the Task root when the address starts
// with "/". An address with a scheme or a host, or one that climbs above the
// workspace root, names no file Caffold serves.
function localImagePath(source, { folder = "", root = "" }) {
  const address = `${source ?? ""}`.trim().split(/[?#]/, 1)[0];
  if (!address || address.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(address)) {
    return "";
  }
  let path;
  try {
    path = decodeURIComponent(address);
  } catch {
    return "";
  }
  const parts = [];
  for (const part of `${path.startsWith("/") ? root : folder}/${path}`.split("/")) {
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
function imageSlot(source, path) {
  const slot = document.createElement("span");
  slot.className = "markdown-preview-image";
  slot.dataset.imagePath = path;
  const image = document.createElement("img");
  for (const name of ["alt", "title"]) {
    if (source.hasAttribute(name)) {
      image.setAttribute(name, source.getAttribute(name));
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
    : image.hasAttribute("height") && `${width} / ${image.getAttribute("height")}`;
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

function rememberDrawnSize(path, image) {
  if (!image.naturalWidth || !image.naturalHeight) {
    return;
  }
  drawnImageSizes.delete(path);
  drawnImageSizes.set(path, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  if (drawnImageSizes.size > DRAWN_IMAGE_SIZE_LIMIT) {
    drawnImageSizes.delete(drawnImageSizes.keys().next().value);
  }
}

function sanitizeInput(element) {
  if (element.getAttribute("type") !== "checkbox") {
    return false;
  }
  element.disabled = true;
  return true;
}

function sanitizeAttributes(element) {
  const allowed = element.localName === "a"
    ? new Set(["href", "title"])
    : element.localName === "input"
      ? new Set(["checked", "disabled", "type"])
      : element.localName === "ol" && /^-?[0-9]+$/.test(element.getAttribute("start") ?? "")
        ? new Set(["start"])
        : new Set();

  for (const attribute of [...element.attributes]) {
    if (!allowed.has(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeLink(element) {
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

function isExternalUrl(value) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function wrapTables(parent) {
  for (const table of [...parent.querySelectorAll("table")]) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-preview-table-scroll";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.append(table);
  }
}

function restoreScroll(scroller, scroll) {
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
