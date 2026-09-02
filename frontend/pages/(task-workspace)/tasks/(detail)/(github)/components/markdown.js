import {
  ACTION_HINT_ACTION,
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
} from "../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../../../../../../scroll-scope.js";

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
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
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
          font-size: var(--conversation-font-size);
          line-height: var(--conversation-line-height);
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
          font-size: 1.75em;
        }

        h2 {
          font-size: 1.35em;
        }

        h3 {
          font-size: 1.1em;
        }

        h4,
        h5,
        h6 {
          font-size: 1em;
        }

        h1,
        h2 {
          padding-bottom: 0.35rem;
          border-bottom: 1px solid var(--border);
        }

        a {
          color: var(--link-fg);
        }

        code {
          padding: 0.15rem 0.35rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--code-gutter);
          color: var(--code-text);
          font-family: var(--font-code);
          font-size: var(--code-font-size);
          line-height: var(--code-line-height);
        }

        pre {
          overflow: auto;
          padding: 0.85rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--code-bg);
          font-size: var(--code-font-size);
          line-height: var(--code-line-height);
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
    const body = this.shadowRoot.querySelector(".markdown-body");
    body.replaceChildren(template.content.cloneNode(true));
    this.actionHintLinks = collectActionHintLinks(body);
    this.scrollSurfaceRecords = collectScrollSurfaceRecords(body);
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const body = this.shadowRoot.querySelector(".markdown-body");
    if (!scopeId || !body || !this.isConnected || this.hidden) {
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
      const tableScrollRoot = control.closest(".markdown-table-scroll");
      if (tableScrollRoot && body.contains(tableScrollRoot)) {
        tableScrollRoots.push(tableScrollRoot);
      }
      return [linkActionHintTarget({
        id: `${scopeId}:link:${ordinal}`,
        actionId: ACTION_HINT_ACTION.LINK_OPEN,
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
          this.shadowRoot.querySelector(".markdown-body") === body &&
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
      mutationRoots: [this, this.shadowRoot],
      scrollRoots: [this, ...new Set(tableScrollRoots)],
    };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Issue description",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
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
      mutationRoots: [this, this.shadowRoot],
      resizeElements: [this],
      scrollRoots: [this],
    };
    const body = this.shadowRoot.querySelector(".markdown-body");
    const nestedScopes = (this.scrollSurfaceRecords ?? []).map((record) => ({
      blocked: false,
      surfaces: [{
        id: `${scopeId}:${record.kind}:${record.ordinal}`,
        label: `${label} ${record.label}`,
        scrollport: record.scrollport,
        axes: ["horizontal"],
        clipRoots: [this, body, record.scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.shadowRoot.querySelector(".markdown-body") === body &&
          this.scrollSurfaceRecords?.includes(record) &&
          body?.contains(record.scrollport) &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(record.scrollport),
      }],
      mutationRoots: [this, this.shadowRoot],
      resizeElements: [this, record.scrollport],
      scrollRoots: [this, record.scrollport],
    }));
    return mergeScrollSurfaceScopes(ownScope, ...nestedScopes);
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
  return Array.from(root.querySelectorAll("pre, .markdown-table-scroll")).map(
    (scrollport) => {
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
    },
  );
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
