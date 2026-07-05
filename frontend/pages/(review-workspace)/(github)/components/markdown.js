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

const URL_ATTRIBUTES = new Set(["href", "src"]);

class CaffoldGithubMarkdown extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-width: 0;
          min-height: 0;
          height: auto;
          overflow: visible;
          overscroll-behavior: auto;
          padding: 16px;
          color: var(--text);
          font-size: 0.875rem;
          line-height: 1.5;
        }

        :host(.github-issue-body) {
          height: 100%;
          overflow: auto;
          overscroll-behavior: contain;
        }

        .markdown-body {
          width: 100%;
          max-width: var(--github-markdown-content-width, 980px);
          margin-inline: auto;
          min-width: 0;
          overflow-wrap: break-word;
        }

        .markdown-body > :first-child {
          margin-top: 0;
        }

        p,
        ul,
        ol,
        blockquote,
        pre,
        .markdown-table-scroll {
          margin: 0 0 1rem;
        }

        h1,
        h2,
        h3,
        h4,
        h5,
        h6 {
          margin: 1.5rem 0 1rem;
          font-weight: 600;
          line-height: 1.25;
        }

        h1 {
          font-size: 1.75rem;
        }

        h2 {
          font-size: 1.35rem;
        }

        h3 {
          font-size: 1.1rem;
        }

        h4,
        h5,
        h6 {
          font-size: 1rem;
        }

        h1,
        h2 {
          padding-bottom: 0.35rem;
          border-bottom: 1px solid var(--border);
        }

        a {
          color: var(--accent);
        }

        code {
          padding: 0.15rem 0.35rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--code-gutter);
          color: var(--code-text);
          font-family: var(--font-mono);
          font-size: 0.78rem;
        }

        pre {
          overflow: auto;
          padding: 0.85rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--code-bg);
        }

        pre code {
          padding: 0;
          border: 0;
          background: transparent;
          font-size: inherit;
        }

        blockquote {
          padding-left: 1rem;
          border-left: 3px solid var(--border);
          color: var(--muted);
        }

        ul,
        ol {
          padding-left: 1.75rem;
        }

        li + li {
          margin-top: 0.25rem;
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
          padding: 0.3rem 0.45rem;
          border: 1px solid var(--border);
          overflow-wrap: normal;
          vertical-align: top;
          white-space: nowrap;
        }

        img {
          max-width: 100%;
          height: auto;
        }

        hr {
          height: 4px;
          margin: 1.5rem 0;
          border: 0;
          background: var(--border);
        }

        input[type="checkbox"] {
          margin: 0 0.35rem 0 0;
          vertical-align: middle;
        }

        .markdown-body > :last-child {
          margin-bottom: 0;
        }
      </style>
      <article class="markdown-body"></article>
    `;
  }

  setHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    sanitizeChildren(template.content);
    wrapTables(template.content);
    this.shadowRoot
      .querySelector(".markdown-body")
      .replaceChildren(template.content.cloneNode(true));
  }
}

function sanitizeChildren(parent) {
  for (const element of [...parent.children]) {
    const tagName = element.localName;
    if (FORBIDDEN_ELEMENTS.has(tagName)) {
      element.remove();
      continue;
    }

    if (tagName === "input" && !sanitizeInput(element)) {
      element.remove();
      continue;
    }

    sanitizeAttributes(element);
    sanitizeChildren(element);
    sanitizeElementAfterChildren(element);
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
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "style" || name === "srcset" || name === "xlink:href") {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }

  if (element.localName === "img") {
    element.loading = "lazy";
  }
}

function sanitizeElementAfterChildren(element) {
  if (element.localName !== "a") {
    return;
  }

  if (!element.hasAttribute("href")) {
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
    if (table.parentElement?.classList.contains("markdown-table-scroll")) {
      continue;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.append(table);
  }
}

customElements.define("caffold-github-markdown", CaffoldGithubMarkdown);
