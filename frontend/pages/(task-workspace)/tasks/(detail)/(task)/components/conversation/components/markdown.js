import { routeUrl } from "../../../../../../../../navigation-routes.js";
import "./markdown/components/code-block.js";
import {
  ACTION_HINT_ACTION,
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
} from "../../../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../../../../../../../../scroll-scope.js";

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

const VALID_INTEGER = /^-?[0-9]+$/;

let parserPromise;

class CaffoldTaskMarkdown extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    const markdown = this.markdown ?? this.textContent ?? "";
    const body = document.createElement("article");
    body.className = "markdown-body";
    this.replaceChildren(body);
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    this.initialized = true;
    this.setMarkdown(markdown);
  }

  setMarkdown(markdown) {
    this.markdown = `${markdown ?? ""}`;
    if (!this.initialized) {
      return;
    }
    const renderToken = Symbol("task-markdown");
    this.renderToken = renderToken;
    this.renderPending();
    void this.renderMarkdown(renderToken);
  }

  renderPending() {
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    const pending = document.createElement("span");
    pending.className = "markdown-loading";
    pending.setAttribute("role", "status");
    pending.textContent = "Rendering Markdown...";
    this.body().replaceChildren(pending);
    this.dataset.renderState = "loading";
  }

  renderPlainText() {
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    const scrollContext = captureScrollContext(this);
    const fallback = document.createElement("pre");
    fallback.className = "markdown-fallback";
    fallback.textContent = this.markdown;
    this.body().replaceChildren(fallback);
    this.dataset.renderState = "plain";
    dispatchRendered(this, scrollContext);
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
      const codeBlocks = collectCodeBlocks(template.content);
      const internalLinks = applyLocalFileLinks(
        template.content,
        this.getAttribute("thread-id") ?? "",
        parsedFileLinks(this.getAttribute("file-links")),
      );
      sanitizeChildren(template.content, internalLinks);
      decorateCodeElements(template.content);
      wrapTables(template.content);
      mountCodeBlocks(
        template.content,
        this.hasAttribute("code-block-controls") ? codeBlocks : [],
        (mutation) => this.mutateLayout(mutation),
      );
      const scrollContext = captureScrollContext(this);
      const body = this.body();
      body.replaceChildren(template.content);
      this.actionHintLinks = collectActionHintLinks(body);
      this.scrollSurfaceRecords = collectNativeScrollSurfaceRecords(
        body,
        codeBlocks,
      );
      this.scrollCodeBlocks = Array.from(
        body.querySelectorAll("caffold-task-markdown-code-block"),
      );
      this.dataset.renderState = "markdown";
      dispatchRendered(this, scrollContext);
    } catch {
      parserPromise = null;
      if (this.renderToken === renderToken) {
        this.renderPlainText();
      }
    }
  }

  body() {
    return this.querySelector(":scope > .markdown-body");
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    if (
      !scopeId ||
      !this.isConnected ||
      this.hidden ||
      this.dataset.renderState !== "markdown"
    ) {
      return emptyActionHintScope();
    }
    const body = this.body();
    if (!body) {
      return emptyActionHintScope();
    }
    const blocks = Array.from(
      body.querySelectorAll("caffold-task-markdown-code-block"),
    );
    const tableScrollRoots = [];
    const linkTargets = (this.actionHintLinks ?? []).flatMap((record) => {
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
          this.dataset.renderState === "markdown" &&
          this.body() === body &&
          this.actionHintLinks?.includes(record) &&
          body.contains(control) &&
          matchesLinkActionHintBinding(control, binding) &&
          Boolean(linkActionHintLabel(control)) &&
          hasActionHintLayoutBox(control),
      })];
    });
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: linkTargets,
        mutationRoots: [this],
        scrollRoots: [...new Set(tableScrollRoots)],
      },
      ...blocks.map((block, index) => block.actionHintScope?.({
        scopeId: `${scopeId}:code-block:${index + 1}`,
        clipRoots: [this, body, ...clipRoots].filter(Boolean),
      })),
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const body = this.body();
    if (
      !scopeId ||
      !body ||
      !this.isConnected ||
      this.hidden ||
      this.dataset.renderState !== "markdown"
    ) {
      return emptyScrollSurfaceScope();
    }
    const current = () =>
      this.isConnected &&
      !this.hidden &&
      isCurrent() &&
      this.dataset.renderState === "markdown" &&
      this.body() === body;
    const nativeScopes = (this.scrollSurfaceRecords ?? []).map((record) => ({
      blocked: false,
      surfaces: [{
        id: `${scopeId}:${record.kind}:${record.ordinal}`,
        label: record.label,
        scrollport: record.scrollport,
        axes: ["horizontal"],
        clipRoots: [this, body, record.scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          current() &&
          this.scrollSurfaceRecords?.includes(record) &&
          body.contains(record.scrollport) &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(record.scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, record.scrollport],
      scrollRoots: [record.scrollport],
    }));
    const blocks = this.scrollCodeBlocks ?? [];
    const blockScopes = blocks.map((block, index) =>
      block.scrollSurfaceScope?.({
        scopeId: `${scopeId}:code-block:${index + 1}`,
        label: `${block.label || "Plain text"} code block ${index + 1}`,
        clipRoots: [this, body, ...clipRoots].filter(Boolean),
        isCurrent: () =>
          current() &&
          this.scrollCodeBlocks?.includes(block) &&
          body.contains(block),
      })
    );
    return mergeScrollSurfaceScopes(...nativeScopes, ...blockScopes);
  }

  mutateLayout(mutation) {
    const scrollContext = captureScrollContext(this);
    mutation();
    dispatchRendered(this, scrollContext);
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

function collectNativeScrollSurfaceRecords(root, codeBlocks) {
  const labels = new Map(codeBlocks.map(({ code, label }) => [
    code.parentElement,
    label,
  ]));
  const ordinals = new Map();
  return Array.from(
    root.querySelectorAll("pre, .markdown-table-scroll"),
  ).flatMap((scrollport) => {
    if (scrollport.closest("caffold-task-markdown-code-block")) {
      return [];
    }
    const kind = scrollport.localName === "pre" ? "code" : "table";
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    return [{
      kind,
      ordinal,
      label: kind === "code"
        ? `${labels.get(scrollport) || "Plain text"} code block ${ordinal}`
        : `Markdown table ${ordinal}`,
      scrollport,
    }];
  });
}

function loadParser() {
  if (!parserPromise) {
    parserPromise = import(MARKED_IMPORT).then(
      (module) => module.marked ?? module.default ?? module,
    );
  }
  return parserPromise;
}

function sanitizeChildren(parent, internalLinks = new Set()) {
  for (const element of [...parent.children]) {
    const tagName = element.localName;
    if (FORBIDDEN_ELEMENTS.has(tagName)) {
      element.remove();
      continue;
    }

    sanitizeChildren(element, internalLinks);
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
      sanitizeLink(element, internalLinks.has(element));
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
      : element.localName === "ol" && VALID_INTEGER.test(element.getAttribute("start") ?? "")
        ? new Set(["start"])
        : new Set();

  for (const attribute of [...element.attributes]) {
    if (!allowed.has(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeLink(element, internal = false) {
  const href = element.getAttribute("href") ?? "";
  if (!isSafeUrl(href)) {
    element.removeAttribute("href");
    element.replaceWith(...element.childNodes);
    return;
  }

  if (internal) {
    element.removeAttribute("target");
    element.removeAttribute("rel");
    return;
  }

  element.target = "_blank";
  element.rel = "noreferrer";
}

function applyLocalFileLinks(parent, threadId, resolvedLinks) {
  const normalizedThreadId = `${threadId ?? ""}`.trim();
  if (!normalizedThreadId) {
    return new Set();
  }
  const candidates = [...parent.querySelectorAll("a[href]")]
    .map((element) => ({ element, target: element.getAttribute("href") ?? "" }))
    .filter(({ target }) => isLocalFileCandidate(target));
  if (!candidates.length) {
    return new Set();
  }

  const resultByTarget = new Map(
    resolvedLinks.map((result) => [result.target, result]),
  );
  const internalLinks = new Set();
  for (const { element, target } of candidates) {
    const result = resultByTarget.get(target);
    if (!result?.taskRelativePath) {
      element.removeAttribute("href");
      continue;
    }
    element.setAttribute(
      "href",
      routeUrl({
        kind: "tasks",
        threadId: normalizedThreadId,
        review: true,
        reviewScope: "working",
        reviewNavigator: "files",
        reviewViewer: "source",
        path: result.taskRelativePath,
        line: result.line ?? null,
        baseRef: "",
      }),
    );
    internalLinks.add(element);
  }
  return internalLinks;
}

function parsedFileLinks(value) {
  if (!value) {
    return [];
  }
  try {
    const links = JSON.parse(value);
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

function isLocalFileCandidate(value) {
  const target = `${value ?? ""}`.trim();
  if (!target || target.startsWith("#") || isCaffoldApplicationPath(target)) {
    return false;
  }
  try {
    const url = new URL(target);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return false;
    }
  } catch {
    // Relative filesystem paths are not standalone URLs.
  }
  return true;
}

function isCaffoldApplicationPath(value) {
  if (!value.startsWith("/")) {
    return false;
  }
  const path = value.split(/[?#]/, 1)[0];
  return (
    path === "/" ||
    path === "/tasks" ||
    path.startsWith("/tasks/") ||
    path === "/settings" ||
    path.startsWith("/settings/") ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/assets" ||
    path.startsWith("/assets/") ||
    path === "/service-worker.js"
  );
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

function decorateCodeElements(parent) {
  for (const pre of parent.querySelectorAll("pre")) {
    pre.classList.add("markdown-pre");
  }
  for (const code of parent.querySelectorAll("code")) {
    code.classList.add(
      code.parentElement?.localName === "pre"
        ? "markdown-block-code"
        : "markdown-inline-code",
    );
  }
}

function collectCodeBlocks(parent) {
  return [...parent.querySelectorAll("pre > code")].map((code) => {
    // Marked carries the fence label in a language-* class that sanitization removes.
    const fenceClass = [...code.classList].find((value) =>
      value.startsWith("language-"),
    );
    return {
      code,
      label: fenceClass?.slice("language-".length) || "Plain text",
    };
  });
}

function mountCodeBlocks(parent, candidates, preserveLayout) {
  for (const { code, label } of candidates) {
    const pre = code.parentElement;
    if (
      code.getRootNode() !== parent ||
      pre?.localName !== "pre" ||
      !pre.parentNode
    ) {
      continue;
    }

    pre.classList.remove("markdown-pre");
    code.classList.remove("markdown-block-code");
    const block = document.createElement("caffold-task-markdown-code-block");
    pre.parentNode.insertBefore(block, pre);
    block.setContent(pre, { label, preserveLayout });
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
