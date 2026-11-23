import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  type LinkActionHintBinding,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION, type ActionHintPull } from "#app/action-hints.js";
import type { TaskFileLink } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { parseLinkRoute, routeUrl } from "#app/navigation-routes.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
import { closestAcrossShadowRoots } from "#app/shadow-roots.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { CaffoldTaskCodeBlock } from "#tasks/(detail)/(task)/components/code-block.js";

import styles from "./markdown.css.js";

const WORDS_IMPORT =
  "https://cdn.jsdelivr.net/npm/@pierre/words@0.3.0/dist/no-math.js";

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

// The part of Words this element uses: a session handed the whole text at each
// change, which answers with the blocks finished since its last answer and the
// end that can still change.
interface Words {
  createHtmlSession(): WordsSession;
}

interface WordsSession {
  render(source: string, options: typeof SESSION_OPTIONS): WordsUpdate;
}

interface WordsUpdate {
  stable: string;
  addition: string;
  pending: string;
  reset: boolean;
  revision: number;
}

// The Markdown on screen: the session revision it shows and the blocks of its
// unfinished end, each with the HTML it was drawn from. Finished blocks never
// change, so only these are compared with the next answer.
interface DrawnMarkdown {
  body: HTMLElement;
  revision: number;
  tail: DrawnBlock[];
}

interface DrawnBlock {
  html: string;
  nodes: ChildNode[];
  // The code block of a fence still open, which takes the fence's further code.
  writing: CaffoldTaskCodeBlock | null;
}

let wordsPromise: Promise<Words> | null = null;
// Words once loaded, so Markdown draws in the update that changed it.
let words: Words | null = null;

// What an agent wrote, drawn from its Markdown. The Task's file references
// become links into the Task's files, and with `code-block-controls` each
// fenced block gets its name and actions.
@customElement("caffold-task-markdown")
export class CaffoldTaskMarkdown extends CaffoldElement {
  @property({ attribute: false })
  accessor markdown = "";
  @property({
    attribute: "thread-id",
    converter: (value: string | null) => value ?? "",
  })
  accessor threadId = "";
  @property({ attribute: false, hasChanged: changedFileLinks })
  accessor fileLinks: TaskFileLink[] = [];
  @property({ type: Boolean, attribute: "code-block-controls" })
  accessor codeBlockControls = false;
  @state()
  accessor renderState: RenderState = "loading";

  static override styles = styles;

  private loadToken: symbol | null = null;
  // What the next update draws: the text's change, or every block, since each
  // block's links and code blocks follow the other three properties.
  private pendingDraw: "none" | "text" | "all" = "none";
  private session: WordsSession | null = null;
  private drawnMarkdown: DrawnMarkdown | null = null;
  private readonly fenceLabels = new WeakMap<Element, string>();
  private actionHintLinks: LinkRecord[] = [];
  private scrollSurfaceRecords: ScrollSurfaceRecord[] = [];
  private scrollCodeBlocks: CaffoldTaskCodeBlock[] = [];
  private readonly bodyElement = new DrawnRef<HTMLElement>(this);

  override willUpdate(changed: PropertyValues<this>) {
    const drawsAll =
      changed.has("threadId") ||
      changed.has("fileLinks") ||
      changed.has("codeBlockControls");
    if (!drawsAll && !changed.has("markdown")) {
      return;
    }
    this.pendingDraw = drawsAll || this.pendingDraw === "all" ? "all" : "text";
    if (words) {
      this.renderState = "markdown";
    } else if (this.renderState !== "loading" || !this.loadToken) {
      this.startLoading();
    }
  }

  override render() {
    // `draw` places the Markdown in this body, out of the template's reach.
    if (this.renderState === "markdown") {
      return html`<article
        ${drawn(this.bodyElement)}
        class="markdown-body"
      ></article>`;
    }
    const status =
      this.renderState === "plain"
        ? html`<pre class="markdown-fallback">${this.markdown}</pre>`
        : html`<span
            class="markdown-loading"
            role="status"
          >Rendering Markdown...</span>`;
    return html`<article
      ${drawn(this.bodyElement)}
      class="markdown-body"
    >${status}</article>`;
  }

  override updated(changed: PropertyValues<this>) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
    if (this.renderState === "markdown" && this.pendingDraw !== "none") {
      const all = this.pendingDraw === "all";
      this.pendingDraw = "none";
      this.draw(all);
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] }: ActionHintPull = {}) {
    const body = this.body;
    if (this.renderState !== "markdown" || !body) {
      return emptyActionHintScope();
    }
    const blocks = Array.from(body.querySelectorAll("caffold-task-code-block"));
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
        mutationRoots: [this, this.renderRoot],
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
                mutationRoots: [this, this.renderRoot],
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

  // Waits for Words the first time. Until it arrives the Markdown is loading,
  // and if it cannot be loaded the text shows as it is written.
  private startLoading() {
    const loadToken = Symbol("task-markdown");
    this.loadToken = loadToken;
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    this.renderState = "loading";
    loadWords().then(
      () => {
        if (this.loadToken !== loadToken) {
          return;
        }
        this.loadToken = null;
        this.renderState = "markdown";
        this.pendingDraw = "all";
        this.performUpdate();
      },
      () => {
        wordsPromise = null;
        if (this.loadToken !== loadToken) {
          return;
        }
        this.loadToken = null;
        this.renderPlainText();
      },
    );
  }

  // Draws Words' answer for the current text. The blocks it has finished stay
  // as drawn; the end still being written is compared and drawn again.
  private draw(all: boolean) {
    const body = this.body;
    if (!body || !words) {
      return;
    }
    this.session ??= words.createHtmlSession();
    const update = this.session.render(
      this.markdown.replace(/^[\u200B-\u200F\uFEFF]/, ""),
      SESSION_OPTIONS,
    );
    const previous =
      !all && this.drawnMarkdown?.body === body ? this.drawnMarkdown : null;
    if (previous?.revision === update.revision) {
      return;
    }
    const tail =
      previous && !update.reset && update.revision === previous.revision + 1
        ? previous.tail
        : null;
    const scrollContext = captureScrollContext(this);
    if (!tail) {
      body.replaceChildren();
    }
    const finished = wordsBlocks(tail ? update.addition : update.stable);
    const blocks = this.drawBlocks(body, tail ?? [], [
      ...finished,
      ...wordsBlocks(update.pending),
    ]);
    this.drawnMarkdown = {
      body,
      revision: update.revision,
      tail: blocks.slice(finished.length),
    };
    this.actionHintLinks = collectActionHintLinks(body);
    this.scrollSurfaceRecords = collectNativeScrollSurfaceRecords(
      body,
      this.fenceLabels,
    );
    this.scrollCodeBlocks = [
      ...body.querySelectorAll<CaffoldTaskCodeBlock>("caffold-task-code-block"),
    ];
    dispatchRendered(this, scrollContext);
  }

  // Keeps the leading blocks whose HTML is unchanged, lets the code block of a
  // fence still open take that fence's further code, and draws the rest anew.
  private drawBlocks(body: HTMLElement, tail: DrawnBlock[], next: ChildNode[]) {
    const blocks: DrawnBlock[] = [];
    while (
      blocks.length < tail.length &&
      blocks.length < next.length &&
      tail[blocks.length].html === blockHtml(next[blocks.length])
    ) {
      blocks.push(tail[blocks.length]);
    }
    const continued =
      blocks.length < tail.length && blocks.length < next.length
        ? this.continueCodeBlock(tail[blocks.length], next[blocks.length])
        : null;
    if (continued) {
      blocks.push(continued);
    }
    for (const block of tail.slice(blocks.length)) {
      for (const node of block.nodes) {
        node.remove();
      }
    }
    for (const raw of next.slice(blocks.length)) {
      blocks.push(this.drawBlock(body, raw));
    }
    return blocks;
  }

  private continueCodeBlock(block: DrawnBlock, raw: ChildNode) {
    const code = raw instanceof HTMLPreElement ? raw.firstElementChild : null;
    if (!block.writing || !code || code.localName !== "code") {
      return null;
    }
    const label = fenceLabel(code);
    if (label !== block.writing.label) {
      return null;
    }
    block.writing.setContent(code.textContent ?? "", {
      label,
      preserveLayout: (mutation) => this.mutateLayout(mutation),
    });
    return {
      html: blockHtml(raw),
      nodes: block.nodes,
      writing: isOpenFence(raw) ? block.writing : null,
    };
  }

  // One block of Words HTML, given the Task's file links, sanitized, and with
  // each fenced block drawn by a code block when the controls are on.
  private drawBlock(body: HTMLElement, raw: ChildNode): DrawnBlock {
    const html = blockHtml(raw);
    const open = isOpenFence(raw);
    const fragment = document.createDocumentFragment();
    fragment.append(raw);
    const codeBlocks = collectCodeBlocks(fragment);
    const internalLinks = applyLocalFileLinks(
      fragment,
      this.threadId,
      this.fileLinks,
    );
    sanitizeChildren(fragment, internalLinks);
    decorateCodeElements(fragment);
    wrapTables(fragment);
    for (const { code, label } of codeBlocks) {
      if (code.parentElement) {
        this.fenceLabels.set(code.parentElement, label);
      }
    }
    const mounted = mountCodeBlocks(
      fragment,
      this.codeBlockControls ? codeBlocks : [],
    );
    const nodes = [...fragment.childNodes];
    body.append(fragment);
    // A block draws into a shadow root, which it can only make once it is in
    // this document.
    for (const { block, text, label } of mounted) {
      block.setContent(text, {
        label,
        preserveLayout: (mutation) => this.mutateLayout(mutation),
      });
    }
    return { html, nodes, writing: open ? (mounted[0]?.block ?? null) : null };
  }

  private renderPlainText() {
    this.actionHintLinks = [];
    this.scrollSurfaceRecords = [];
    this.scrollCodeBlocks = [];
    this.drawnMarkdown = null;
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
  labels: WeakMap<Element, string>,
): ScrollSurfaceRecord[] {
  const ordinals = new Map<string, number>();
  return Array.from(
    root.querySelectorAll<HTMLElement>("pre, .markdown-table-scroll"),
  ).flatMap((scrollport) => {
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

function loadWords() {
  wordsPromise ??= import(WORDS_IMPORT).then((module: Words) => {
    words = module;
    return module;
  });
  return wordsPromise;
}

// The top-level blocks of HTML Words wrote, leaving out the line breaks
// between them.
function wordsBlocks(wordsHtml: string) {
  const template = document.createElement("template");
  template.innerHTML = wordsHtml;
  return [...template.content.childNodes].filter(
    (node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim(),
  );
}

function blockHtml(block: ChildNode) {
  return block instanceof Element ? block.outerHTML : (block.textContent ?? "");
}

function isOpenFence(block: ChildNode) {
  return (
    block instanceof HTMLPreElement &&
    block.hasAttribute("data-markdown-incomplete")
  );
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
  return [...parent.querySelectorAll("pre > code")].map((code) => ({
    code,
    label: fenceLabel(code),
  }));
}

// Words carries the fence label in a language-* class that sanitization removes.
function fenceLabel(code: Element) {
  const fenceClass = [...code.classList].find((value) =>
    value.startsWith("language-"),
  );
  return fenceClass?.slice("language-".length) || "Plain text";
}

// Each fenced block gets a code block in its `<pre>`'s place, which draws the
// fence's code once it is in the document.
function mountCodeBlocks(
  parent: DocumentFragment,
  candidates: CodeBlockSource[],
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

    const block = new CaffoldTaskCodeBlock();
    pre.replaceWith(block);
    return [{ block, text: code.textContent ?? "", label }];
  });
}

function captureScrollContext(element: Element): ScrollContext | null {
  const scroller = closestAcrossShadowRoots(
    element,
    ".task-conversation-scroll",
  );
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
  const scroller = closestAcrossShadowRoots(
    element,
    ".task-conversation-scroll",
  );
  element.dispatchEvent(
    new CustomEvent<MarkdownRenderedDetail>("caffold:task-markdown-rendered", {
      bubbles: true,
      composed: true,
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

// The raw HTML Words keeps for `sanitizeChildren`: the elements it allows, with
// the attributes `sanitizeAttributes` keeps, and elements it unwraps, whose
// text would otherwise go with them.
const RAW_HTML_TO_SANITIZE: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    [
      ...ALLOWED_ELEMENTS,
      ..."abbr article b caption center col colgroup dd details div dl dt fieldset figcaption figure i ins kbd label legend mark picture s section small source span sub summary sup tfoot u".split(
        " ",
      ),
    ].map((tag) => [tag, []]),
  ),
  a: ["href", "title"],
  input: ["checked", "disabled", "type"],
  ol: ["start"],
};

// Unfinished emphasis, code, and links at the end still being written draw as
// if closed, and stay so when the text ends before they close.
const SESSION_OPTIONS = {
  cjk: true,
  incomplete: true,
  allowedHtml: RAW_HTML_TO_SANITIZE,
};

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-markdown": CaffoldTaskMarkdown;
  }

  interface HTMLElementEventMap {
    "caffold:task-markdown-rendered": CustomEvent<MarkdownRenderedDetail>;
  }
}
