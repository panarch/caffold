const MARKED_IMPORT = "https://esm.sh/marked@15.0.12";

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

let parserPromise;

class CaffoldTaskMarkdown extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-width: 0;
          color: inherit;
          font: inherit;
          line-height: inherit;
        }

        .markdown-body {
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .markdown-body > :first-child {
          margin-top: 0;
        }

        .markdown-body > :last-child {
          margin-bottom: 0;
        }

        p,
        ul,
        ol,
        blockquote,
        pre,
        .markdown-table-scroll {
          margin: 0 0 10px;
        }

        h1,
        h2,
        h3,
        h4,
        h5,
        h6 {
          margin: 20px 0 8px;
          font-weight: 600;
          line-height: calc(var(--task-detail-line-height) + 1px);
        }

        h1 {
          font-size: calc(var(--task-detail-font-size) + 4px);
        }

        h2 {
          font-size: calc(var(--task-detail-font-size) + 3px);
        }

        h3 {
          font-size: calc(var(--task-detail-font-size) + 2px);
        }

        h4,
        h5,
        h6 {
          font-size: calc(var(--task-detail-font-size) + 1px);
        }

        a {
          color: var(--accent);
          text-underline-offset: 2px;
        }

        code {
          padding: 1px 4px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--code-gutter);
          color: var(--code-text);
          font-family: var(--font-mono);
          font-size: calc(var(--task-detail-font-size) - 1px);
        }

        pre {
          max-width: 100%;
          overflow: auto;
          padding: 11px 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--code-bg);
          font-size: var(--code-viewer-font-size);
          line-height: 1.55;
          white-space: pre;
          overscroll-behavior-x: contain;
        }

        pre code {
          padding: 0;
          border: 0;
          background: transparent;
          font-size: inherit;
        }

        blockquote {
          padding-left: 12px;
          border-left: 3px solid var(--border);
          color: var(--muted);
        }

        ul,
        ol {
          padding-left: 24px;
        }

        li + li {
          margin-top: 3px;
        }

        .markdown-table-scroll {
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-x: contain;
        }

        table {
          width: max-content;
          min-width: 100%;
          border-collapse: collapse;
        }

        th,
        td {
          padding: 4px 7px;
          border: 1px solid var(--border);
          overflow-wrap: normal;
          text-align: left;
          vertical-align: top;
          white-space: nowrap;
        }

        hr {
          height: 1px;
          margin: 16px 0;
          border: 0;
          background: var(--border);
        }

        input[type="checkbox"] {
          margin: 0 5px 0 0;
          vertical-align: middle;
        }

        .markdown-fallback {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          overflow-wrap: anywhere;
          font: inherit;
          line-height: inherit;
          white-space: pre-wrap;
        }
      </style>
      <article class="markdown-body"></article>
    `;
  }

  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    const markdown = this.textContent ?? "";
    this.replaceChildren();
    this.setMarkdown(markdown);
  }

  setMarkdown(markdown) {
    this.markdown = `${markdown ?? ""}`;
    const renderToken = Symbol("task-markdown");
    this.renderToken = renderToken;
    this.renderPlainText();
    this.renderMarkdown(renderToken);
  }

  renderPlainText() {
    const fallback = document.createElement("pre");
    fallback.className = "markdown-fallback";
    fallback.textContent = this.markdown;
    this.body().replaceChildren(fallback);
    this.dataset.renderState = "plain";
  }

  async renderMarkdown(renderToken) {
    try {
      const parser = await loadParser();
      if (this.renderToken !== renderToken) {
        return;
      }

      const source = this.markdown.replace(/^[\u200B-\u200F\uFEFF]/, "");
      const parse = parser.parse?.bind(parser) ?? parser;
      const html = await parse(source, { gfm: true, breaks: false });
      if (this.renderToken !== renderToken) {
        return;
      }

      const template = document.createElement("template");
      template.innerHTML = `${html ?? ""}`;
      sanitizeChildren(template.content);
      wrapTables(template.content);
      const scrollContext = captureScrollContext(this);
      this.body().replaceChildren(template.content.cloneNode(true));
      this.dataset.renderState = "markdown";
      dispatchRendered(this, scrollContext);
    } catch {
      parserPromise = null;
      if (this.renderToken === renderToken) {
        this.dataset.renderState = "plain";
      }
    }
  }

  body() {
    return this.shadowRoot.querySelector(".markdown-body");
  }
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
      : new Set();

  for (const attribute of [...element.attributes]) {
    if (!allowed.has(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeLink(element) {
  const href = element.getAttribute("href") ?? "";
  if (!isSafeUrl(href)) {
    element.removeAttribute("href");
    element.replaceWith(...element.childNodes);
    return;
  }

  element.target = "_blank";
  element.rel = "noreferrer";
}

function isSafeUrl(value) {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return true;
  }

  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function wrapTables(parent) {
  for (const table of [...parent.querySelectorAll("table")]) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.append(table);
  }
}

function captureScrollContext(element) {
  const scroller = element.closest(".task-conversation-scroll");
  if (!scroller || scroller.clientHeight === 0) {
    return null;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return {
    atBottom: maxScrollTop - scroller.scrollTop <= 2,
    aboveViewport: elementRect.bottom <= scrollerRect.top,
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop,
  };
}

function dispatchRendered(element, scrollContext) {
  const scroller = element.closest(".task-conversation-scroll");
  element.dispatchEvent(
    new CustomEvent("caffold:task-markdown-rendered", {
      bubbles: true,
      detail: {
        ...scrollContext,
        scrollHeight: scrollContext?.scrollHeight ?? null,
        nextScrollHeight: scroller?.scrollHeight ?? null,
      },
    }),
  );
}

customElements.define("caffold-task-markdown", CaffoldTaskMarkdown);
