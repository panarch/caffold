import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../scroll-scope.js";

const MARKED_IMPORT = "https://esm.sh/marked@15.0.12";

let parserPromise;

class CaffoldMarkdownPreview extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Markdown preview");
    if (this.markdown !== undefined && this.dataset.renderState === "loading") {
      this.startRender();
    }
  }

  disconnectedCallback() {
    this.renderToken = null;
  }

  ensureRendered() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.innerHTML = '<article class="markdown-preview-body"></article>';
  }

  setMarkdown(markdown, options = {}) {
    this.ensureRendered();
    const scroll = options.preserveScroll
      ? this.getScrollState()
      : options.scroll ?? null;
    this.markdown = `${markdown ?? ""}`;
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
  } = {}) {
    this.ensureRendered();
    if (!scopeId || !label || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this;
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          hasScrollLayoutBox(this) &&
          hasVerticalScrollOverflow(this),
      }],
      mutationRoots: [this],
      resizeElements: [this],
      scrollRoots: [this],
    };
  }

  renderPending() {
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
      const content = await markdownContent(this.markdown);
      if (!this.acceptRender(renderToken)) {
        return;
      }
      this.body().replaceChildren(content);
      this.dataset.renderState = "markdown";
      this.pendingScroll = null;
      restoreScroll(this, scroll);
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

if (!customElements.get("caffold-markdown-preview")) {
  customElements.define("caffold-markdown-preview", CaffoldMarkdownPreview);
}

async function markdownContent(markdown) {
  const parser = await loadParser();
  const source = `${markdown ?? ""}`.replace(/^[\u200B-\u200F\uFEFF]/, "");
  const parse = parser.parse?.bind(parser) ?? parser;
  const html = await parse(source, { gfm: true, breaks: false });
  const template = document.createElement("template");
  template.innerHTML = `${html ?? ""}`;
  sanitizeChildren(template.content);
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

function sanitizeChildren(parent) {
  for (const element of [...parent.children]) {
    const tagName = element.localName;
    if (FORBIDDEN_ELEMENTS.has(tagName)) {
      element.remove();
      continue;
    }
    if (tagName === "img") {
      element.replaceWith(imagePlaceholder(element));
      continue;
    }

    sanitizeChildren(element);
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
