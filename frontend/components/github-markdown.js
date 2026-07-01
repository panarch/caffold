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

class CodgerGithubMarkdown extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-width: 0;
          min-height: 0;
          height: 100%;
          overflow: auto;
          overscroll-behavior: contain;
          padding: 12px;
          color: var(--text);
          font-size: 0.8rem;
          line-height: 1.45;
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
        table {
          margin: 0 0 0.75rem;
        }

        h1,
        h2,
        h3,
        h4,
        h5,
        h6 {
          margin: 1rem 0 0.45rem;
          font-size: 0.9rem;
          line-height: 1.2;
        }

        h1,
        h2 {
          padding-bottom: 0.25rem;
          border-bottom: 1px solid var(--border);
        }

        a {
          color: var(--accent);
        }

        code {
          padding: 0.05rem 0.25rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--code-gutter);
          color: var(--code-text);
          font-family: var(--font-mono);
          font-size: 0.78rem;
        }

        pre {
          overflow: auto;
          padding: 0.65rem;
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
          padding-left: 0.75rem;
          border-left: 3px solid var(--border);
          color: var(--muted);
        }

        ul,
        ol {
          padding-left: 1.35rem;
        }

        table {
          display: block;
          width: max-content;
          max-width: 100%;
          overflow: auto;
          border-collapse: collapse;
        }

        th,
        td {
          padding: 0.3rem 0.45rem;
          border: 1px solid var(--border);
        }

        img {
          max-width: 100%;
          height: auto;
        }

        hr {
          border: 0;
          border-top: 1px solid var(--border);
        }

        input[type="checkbox"] {
          margin: 0 0.35rem 0 0;
          vertical-align: middle;
        }
      </style>
      <article class="markdown-body"></article>
    `;
  }

  setHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    sanitizeChildren(template.content);
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

customElements.define("codger-github-markdown", CodgerGithubMarkdown);
