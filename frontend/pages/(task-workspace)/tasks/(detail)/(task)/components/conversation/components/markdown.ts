import { html, LitElement, type PropertyValues } from "lit";
import {
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  type LinkActionHintBinding,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
} from "#app/action-hint-scope.ts";
import { ACTION_HINT_ACTION, type ActionHintPull } from "#app/action-hints.ts";
import type { TaskFileLink } from "#app/api.ts";
import { parseLinkRoute, routeUrl } from "#app/navigation-routes.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { CaffoldTaskMarkdownCodeBlock } from "./markdown/components/code-block.ts";

const MARKED_IMPORT = "https://esm.sh/marked@15.0.12";

type RenderState = "loading" | "plain" | "markdown";

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

interface CodeBlockSource {
  code: Element;
  label: string;
}

// Where the conversation stood before Markdown changed an entry's height, so
// it can keep its reader's place once the entry is drawn.
interface ScrollContext {
  atBottom: boolean;
  aboveViewport: boolean;
  scrollHeight: number;
  scrollTop: number;
}

// What drawn Markdown tells the conversation holding it: where the
// conversation stood before, or `null` when it was not on screen, and how tall
// it is after.
export interface MarkdownRenderedDetail {
  before: ScrollContext | null;
  nextScrollHeight: number | null;
}

type ParseMarkdown = (
  source: string,
  options: { gfm: boolean; breaks: boolean },
) => string | Promise<string>;

// marked's module export is the parser, which also carries `parse`.
type MarkedParser = ParseMarkdown & { parse?: ParseMarkdown };

let parserPromise: Promise<MarkedParser> | null = null;

// What an agent wrote, drawn from its Markdown. The Task's file references
// become links into the Task's files, and with `code-block-controls` each
// fenced block gets its name and actions.
export class CaffoldTaskMarkdown extends LitElement {
  static properties = {
    markdown: { attribute: false },
    threadId: {
      attribute: "thread-id",
      converter: (value: string | null) => value ?? "",
    },
    fileLinks: { attribute: false, hasChanged: changedFileLinks },
    codeBlockControls: { type: Boolean, attribute: "code-block-controls" },
    renderState: { state: true },
    renderedContent: { state: true },
  };

  declare markdown: string;
  declare threadId: string;
  declare fileLinks: TaskFileLink[];
  declare codeBlockControls: boolean;
  declare renderState: RenderState;
  declare private renderedContent: DocumentFragment | null;
  private renderToken: symbol | null = null;
  private actionHintLinks: LinkRecord[] = [];
  private scrollSurfaceRecords: ScrollSurfaceRecord[] = [];
  private scrollCodeBlocks: CaffoldTaskMarkdownCodeBlock[] = [];
  private readonly bodyElement = new DrawnRef<HTMLElement>(this);

  constructor() {
    super();
    this.markdown = "";
    this.threadId = "";
    this.fileLinks = [];
    this.codeBlockControls = false;
    this.renderState = "loading";
    this.renderedContent = null;
  }

  createRenderRoot() {
    return this;
  }

  // Parsing reads all four, so a change to any of them reads the Markdown
  // again, and the same values leave it as drawn.
  willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("markdown") ||
      changed.has("threadId") ||
      changed.has("fileLinks") ||
      changed.has("codeBlockControls")
    ) {
      this.startRender();
    }
  }

  render() {
    const content =
      this.renderState === "markdown"
        ? this.renderedContent
        : this.renderState === "plain"
          ? html`<pre class="markdown-fallback">${this.markdown}</pre>`
          : html`<span
              class="markdown-loading"
              role="status"
            >Rendering Markdown...</span>`;
    return html`<article
      ${drawn(this.bodyElement)}
      class="markdown-body"
    >${content}</article>`;
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] }: ActionHintPull = {}) {
    const body = this.body;
    if (this.renderState !== "markdown" || !body) {
      return emptyActionHintScope();
    }
    const blocks = Array.from(
      body.querySelectorAll<CaffoldTaskMarkdownCodeBlock>(
        "caffold-task-markdown-code-block",
      ),
    );
    const tableScrollRoots: Element[] = [];
    const linkTargets = this.actionHintLinks.flatMap(
      ({ binding, control, ordinal }) => {
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
        return [
          linkActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:link:${ordinal}`,
            actionId: ACTION_HINT_ACTION.LINK_OPEN,
            label,
            control,
            clipRoots: [this, body, tableScrollRoot, ...clipRoots].filter(
              (root): root is Element => Boolean(root),
            ),
          }),
        ];
      },
    );
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: linkTargets,
        mutationRoots: [this],
        scrollRoots: [...new Set(tableScrollRoots)],
      },
      ...blocks.map((block, index) =>
        block.actionHintScope({
          scopeId: `${scopeId}:code-block:${index + 1}`,
          clipRoots: [this, body, ...clipRoots],
        }),
      ),
    );
  }

  scrollSurfaceScope({ scopeId = "", clipRoots = [] }: ScrollSurfacePull = {}) {
    const body = this.body;
    if (this.renderState !== "markdown" || !body) {
      return emptyScrollSurfaceScope();
    }
    const nativeScopes = this.scrollSurfaceRecords.flatMap(
      (record): ScrollSurfaceScope[] =>
        body.contains(record.scrollport) &&
        hasScrollLayoutBox(this) &&
        hasScrollLayoutBox(record.scrollport)
          ? [
              {
                blocked: false,
                surfaces: [
                  {
                    id: `${scopeId}:${record.kind}:${record.ordinal}`,
                    label: record.label,
                    scrollport: record.scrollport,
                    axes: ["horizontal"],
                    clipRoots: [this, body, record.scrollport, ...clipRoots],
                  },
                ],
                mutationRoots: [this],
                resizeElements: [this, record.scrollport],
                scrollRoots: [record.scrollport],
              },
            ]
          : [],
    );
    const blockScopes = this.scrollCodeBlocks
      .filter((block) => body.contains(block))
      .map((block, index) =>
        block.scrollSurfaceScope({
          scopeId: `${scopeId}:code-block:${index + 1}`,
          label: `${block.label || "Plain text"} code block ${index + 1}`,
          clipRoots: [this, body, ...clipRoots],
        }),
      );
    return mergeScrollSurfaceScopes(...nativeScopes, ...blockScopes);
  }

  private startRender() {
    const renderToken = Symbol("task-markdown");
    this.renderToken = renderToken;
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    this.renderedContent = null;
    this.renderState = "loading";
    void this.renderMarkdown(renderToken);
  }

  private async renderMarkdown(renderToken: symbol) {
    try {
      const parser = await loadParser();
      if (this.renderToken !== renderToken) {
        return;
      }

      const source = this.markdown.replace(/^[\u200B-\u200F\uFEFF]/, "");
      const parse = parser.parse?.bind(parser) ?? parser;
      const markup = await parse(source, { gfm: true, breaks: false });
      if (this.renderToken !== renderToken) {
        return;
      }

      const template = document.createElement("template");
      template.innerHTML = `${markup ?? ""}`;
      const codeBlocks = collectCodeBlocks(template.content);
      const internalLinks = applyLocalFileLinks(
        template.content,
        this.threadId,
        this.fileLinks,
      );
      sanitizeChildren(template.content, internalLinks);
      decorateCodeElements(template.content);
      wrapTables(template.content);
      const blocks = mountCodeBlocks(
        template.content,
        this.codeBlockControls ? codeBlocks : [],
        (mutation) => this.mutateLayout(mutation),
      );
      const scrollContext = captureScrollContext(this);
      this.renderedContent = template.content;
      this.renderState = "markdown";
      this.performUpdate();
      const body = this.body;
      if (!body) {
        return;
      }
      this.actionHintLinks = collectActionHintLinks(body);
      this.scrollSurfaceRecords = collectNativeScrollSurfaceRecords(
        body,
        codeBlocks,
      );
      this.scrollCodeBlocks = blocks;
      dispatchRendered(this, scrollContext);
    } catch {
      parserPromise = null;
      if (this.renderToken === renderToken) {
        this.renderPlainText();
      }
    }
  }

  private renderPlainText() {
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    const scrollContext = captureScrollContext(this);
    this.renderState = "plain";
    this.performUpdate();
    dispatchRendered(this, scrollContext);
  }

  private mutateLayout(mutation: () => void) {
    const scrollContext = captureScrollContext(this);
    mutation();
    dispatchRendered(this, scrollContext);
  }

  private get body() {
    return this.bodyElement.value;
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

function collectNativeScrollSurfaceRecords(
  root: Element,
  codeBlocks: CodeBlockSource[],
): ScrollSurfaceRecord[] {
  const labels = new Map(
    codeBlocks.map(({ code, label }) => [code.parentElement, label]),
  );
  const ordinals = new Map<string, number>();
  return Array.from(
    root.querySelectorAll<HTMLElement>("pre, .markdown-table-scroll"),
  ).flatMap((scrollport) => {
    if (scrollport.closest("caffold-task-markdown-code-block")) {
      return [];
    }
    const kind = scrollport.localName === "pre" ? "code" : "table";
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    return [
      {
        kind,
        ordinal,
        label:
          kind === "code"
            ? `${labels.get(scrollport) || "Plain text"} code block ${ordinal}`
            : `Markdown table ${ordinal}`,
        scrollport,
      },
    ];
  });
}

function loadParser() {
  parserPromise ??= import(MARKED_IMPORT).then(
    (module) => module.marked ?? module.default ?? module,
  );
  return parserPromise;
}

function sanitizeChildren(
  parent: Element | DocumentFragment,
  internalLinks = new Set<Element>(),
) {
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

function sanitizeInput(element: Element) {
  if (
    !(element instanceof HTMLInputElement) ||
    element.getAttribute("type") !== "checkbox"
  ) {
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
            VALID_INTEGER.test(element.getAttribute("start") ?? "")
          ? new Set(["start"])
          : new Set<string>();

  for (const attribute of [...element.attributes]) {
    if (!allowed.has(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeLink(element: Element, internal = false) {
  const href = element.getAttribute("href") ?? "";
  if (!isSafeUrl(href)) {
    element.removeAttribute("href");
    element.replaceWith(...element.childNodes);
    return;
  }

  if (internal || parseLinkRoute(href)?.kind === "notes") {
    element.removeAttribute("target");
    element.removeAttribute("rel");
    return;
  }

  element.setAttribute("target", "_blank");
  element.setAttribute("rel", "noreferrer");
}

function applyLocalFileLinks(
  parent: DocumentFragment,
  threadId: string,
  resolvedLinks: TaskFileLink[],
) {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return new Set<Element>();
  }
  const candidates = [...parent.querySelectorAll("a[href]")]
    .map((element) => ({ element, target: element.getAttribute("href") ?? "" }))
    .filter(({ target }) => isLocalFileCandidate(target));
  if (!candidates.length) {
    return new Set<Element>();
  }

  const resultByTarget = new Map(
    resolvedLinks.map((result) => [result.target, result]),
  );
  const internalLinks = new Set<Element>();
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

function isLocalFileCandidate(value: string) {
  const target = value.trim();
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

function isCaffoldApplicationPath(value: string) {
  if (!value.startsWith("/")) {
    return false;
  }
  const path = value.split(/[?#]/, 1)[0];
  return (
    path === "/" ||
    path === "/tasks" ||
    path.startsWith("/tasks/") ||
    path === "/notes" ||
    path.startsWith("/notes/") ||
    path === "/settings" ||
    path.startsWith("/settings/") ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/assets" ||
    path.startsWith("/assets/") ||
    path === "/service-worker.js"
  );
}

function isSafeUrl(value: string) {
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

function wrapTables(parent: DocumentFragment) {
  for (const table of [...parent.querySelectorAll("table")]) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.append(table);
  }
}

function decorateCodeElements(parent: DocumentFragment) {
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

function collectCodeBlocks(parent: DocumentFragment): CodeBlockSource[] {
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

// Each fenced block takes its `<pre>` into a code block in the `<pre>`'s place.
function mountCodeBlocks(
  parent: DocumentFragment,
  candidates: CodeBlockSource[],
  preserveLayout: (mutation: () => void) => void,
) {
  return candidates.flatMap(({ code, label }) => {
    const pre = code.parentElement;
    if (
      code.getRootNode() !== parent ||
      !(pre instanceof HTMLPreElement) ||
      !pre.parentNode
    ) {
      return [];
    }

    pre.classList.remove("markdown-pre");
    code.classList.remove("markdown-block-code");
    const block = new CaffoldTaskMarkdownCodeBlock();
    pre.parentNode.insertBefore(block, pre);
    block.setContent(pre, { label, preserveLayout });
    return [block];
  });
}

function captureScrollContext(element: Element): ScrollContext | null {
  const scroller = element.closest(".task-conversation-scroll");
  if (!scroller || scroller.clientHeight === 0) {
    return null;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const maxScrollTop = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight,
  );
  return {
    atBottom: maxScrollTop - scroller.scrollTop <= 2,
    aboveViewport: elementRect.bottom <= scrollerRect.top,
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop,
  };
}

function dispatchRendered(element: Element, before: ScrollContext | null) {
  const scroller = element.closest(".task-conversation-scroll");
  element.dispatchEvent(
    new CustomEvent<MarkdownRenderedDetail>("caffold:task-markdown-rendered", {
      bubbles: true,
      detail: { before, nextScrollHeight: scroller?.scrollHeight ?? null },
    }),
  );
}

function changedFileLinks(next: TaskFileLink[], previous?: TaskFileLink[]) {
  return JSON.stringify(next ?? []) !== JSON.stringify(previous ?? []);
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

const VALID_INTEGER = /^-?[0-9]+$/;

customElements.define("caffold-task-markdown", CaffoldTaskMarkdown);
