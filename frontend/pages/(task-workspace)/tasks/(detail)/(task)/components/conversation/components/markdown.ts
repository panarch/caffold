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

interface ProcessedBlock {
  html: string;
  open: boolean;
  nodes: ChildNode[];
  mounted: { block: CaffoldTaskCodeBlock; text: string; label: string }[];
}

// What a run of nodes shows: text joined across the pieces appended to it, and
// elements as they are.
type Visible = { text: string; nodes: ChildNode[] } | { element: Element };

// The code and name each code block of a processed block is about to draw.
type NextCode = Map<Element, { text: string; label: string }>;

// How long added text takes to fade in: the length of `markdown-arriving` in
// markdown.css, and of the slide that follows it to the bottom.
export const ARRIVING_MS = 180;

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
  private scrollContextBeforeDraw: ScrollContext | null = null;
  private session: WordsSession | null = null;
  private drawnMarkdown: DrawnMarkdown | null = null;
  private readonly fenceLabels = new WeakMap<Element, string>();
  // What is still fading in, oldest first. Its mark comes off when the fade
  // ends, so moving or showing the Markdown again does not fade it twice.
  private readonly arriving: { node: Element; until: number }[] = [];
  private arrivingTimer: number | undefined;
  private actionHintLinks: LinkRecord[] = [];
  private scrollSurfaceRecords: ScrollSurfaceRecord[] = [];
  private scrollCodeBlocks: CaffoldTaskCodeBlock[] = [];
  private readonly bodyElement = new DrawnRef<HTMLElement>(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.settleArriving(true);
  }

  override willUpdate(changed: PropertyValues<this>) {
    const drawsAll =
      changed.has("threadId") ||
      changed.has("fileLinks") ||
      changed.has("codeBlockControls");
    if (drawsAll || changed.has("markdown")) {
      this.pendingDraw =
        drawsAll || this.pendingDraw === "all" ? "all" : "text";
      if (words) {
        this.renderState = "markdown";
      } else if (this.renderState !== "loading" || !this.loadToken) {
        this.startLoading();
      }
    }
    // Read before the template changes: Markdown taking over takes the
    // loading notice or the plain text away before `draw` runs.
    this.scrollContextBeforeDraw =
      this.renderState === "markdown" && this.pendingDraw !== "none"
        ? captureScrollContext(this)
        : null;
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
      this.draw(all, this.scrollContextBeforeDraw);
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
  private draw(all: boolean, before: ScrollContext | null) {
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
    if (!tail) {
      body.replaceChildren();
    }
    const finished = wordsBlocks(tail ? update.addition : update.stable);
    // Only text arriving in a stream fades in, not Markdown drawn whole.
    const blocks = this.drawBlocks(
      body,
      tail ?? [],
      [...finished, ...wordsBlocks(update.pending)],
      tail !== null,
    );
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
    dispatchRendered(this, before);
  }

  // Matches the next blocks with the drawn end in order. A block whose HTML is
  // unchanged stays; the code block of a fence still open takes the fence's
  // further code; a block that only grew keeps its nodes and takes what it
  // added; any other block is drawn anew in its place. Blocks past the drawn
  // end are added after it.
  private drawBlocks(
    body: HTMLElement,
    tail: DrawnBlock[],
    next: ChildNode[],
    fade: boolean,
  ) {
    const blocks = next.map((raw, at): DrawnBlock => {
      const drawn = tail[at];
      if (!drawn) {
        return this.placeBlock(body, this.processBlock(raw), null, null, fade);
      }
      if (drawn.html === blockHtml(raw)) {
        return drawn;
      }
      const continued = this.continueCodeBlock(drawn, raw);
      if (continued) {
        return continued;
      }
      const processed = this.processBlock(raw);
      const following = tail.slice(at + 1).find(({ nodes }) => nodes.length);
      return (
        (fade && this.growBlock(body, drawn, processed)) ||
        this.placeBlock(
          body,
          processed,
          drawn.nodes[0] ?? following?.nodes[0] ?? null,
          drawn,
          false,
        )
      );
    });
    for (const block of tail.slice(next.length)) {
      for (const node of block.nodes) {
        node.remove();
      }
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
  // each fenced block a code block when the controls are on, not yet drawn.
  private processBlock(raw: ChildNode): ProcessedBlock {
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
    return { html, open, nodes: [...fragment.childNodes], mounted };
  }

  // Draws a processed block before `before`, or after everything without it,
  // in place of the block it replaces.
  private placeBlock(
    body: HTMLElement,
    block: ProcessedBlock,
    before: ChildNode | null,
    replacing: DrawnBlock | null,
    fade: boolean,
  ): DrawnBlock {
    for (const node of block.nodes) {
      body.insertBefore(node, before);
    }
    for (const node of replacing?.nodes ?? []) {
      node.remove();
    }
    this.fillCodeBlocks(block.mounted);
    if (fade) {
      for (const node of block.nodes) {
        if (node instanceof Element && fadesIn(node)) {
          this.markArriving(node);
        }
      }
    }
    return {
      html: block.html,
      nodes: block.nodes,
      writing: block.open ? (block.mounted[0]?.block ?? null) : null,
    };
  }

  // Keeps a drawn block whose next version only grew, and moves what it added
  // into it, fading in the added text and elements. Null when the next
  // version changed something already drawn.
  private growBlock(
    body: HTMLElement,
    drawn: DrawnBlock,
    next: ProcessedBlock,
  ): DrawnBlock | null {
    const code = new Map(
      next.mounted.map(({ block, text, label }) => [block, { text, label }]),
    );
    const before = visible(drawn.nodes);
    const after = visible(next.nodes);
    if (!before.length || growthAt(before, after, code) === null) {
      return null;
    }
    const added = this.grow(body, before, after, code, true, null);
    this.fillCodeBlocks(next.mounted.filter(({ block }) => block.isConnected));
    return {
      html: next.html,
      nodes: [...drawn.nodes, ...added],
      writing: null,
    };
  }

  // Moves what `after` adds to `before` into `parent`, returning the nodes it
  // added directly under `parent`. `before` must grow into `after`.
  private grow(
    parent: Node,
    before: Visible[],
    after: Visible[],
    code: NextCode,
    fade: boolean,
    start: ChildNode | null,
  ): ChildNode[] {
    const last = before.at(-1);
    const anchor = last ? lastNode(last).nextSibling : start;
    const at = growthAt(before, after, code);
    if (at !== null && at !== -1) {
      this.growItem(parent, before[at], after[at], code, fade);
    }
    return after.slice(before.length).map((item) => {
      if ("text" in item && isLineBreak(item.text)) {
        return parent.insertBefore(document.createTextNode(item.text), anchor);
      }
      if ("text" in item) {
        return this.addPiece(parent, item.text, anchor, fade);
      }
      parent.insertBefore(item.element, anchor);
      if (fade && fadesIn(item.element)) {
        this.markArriving(item.element);
      }
      return item.element;
    });
  }

  // Grows one drawn item into its next version where it is.
  private growItem(
    parent: Node,
    drawn: Visible,
    next: Visible,
    code: NextCode,
    fade: boolean,
  ) {
    if ("text" in drawn) {
      if ("text" in next) {
        const rest = next.text.slice(drawn.text.length);
        this.addPiece(parent, rest, lastNode(drawn).nextSibling, fade);
      }
      return;
    }
    if ("text" in next) {
      return;
    }
    const element = drawn.element;
    if (element instanceof CaffoldTaskCodeBlock) {
      const nextCode = code.get(next.element);
      if (nextCode) {
        this.fillCodeBlocks([{ block: element, ...nextCode }]);
      }
      return;
    }
    this.grow(
      element,
      visible(element.childNodes),
      visible(next.element.childNodes),
      code,
      fade && element.localName !== "pre",
      element.firstChild,
    );
  }

  // Text added to a drawn block, kept in its own piece so that the text drawn
  // before it, and a selection in it, stay where they are.
  private addPiece(
    parent: Node,
    text: string,
    before: ChildNode | null,
    fade: boolean,
  ) {
    const piece = document.createElement("span");
    piece.dataset.piece = "";
    piece.textContent = text;
    parent.insertBefore(piece, before);
    if (fade) {
      this.markArriving(piece);
    }
    return piece;
  }

  // A code block draws into a shadow root, which it can only make once it is
  // in this document.
  private fillCodeBlocks(
    blocks: { block: CaffoldTaskCodeBlock; text: string; label: string }[],
  ) {
    for (const { block, text, label } of blocks) {
      block.setContent(text, {
        label,
        preserveLayout: (mutation) => this.mutateLayout(mutation),
      });
    }
  }

  private markArriving(node: Element) {
    node.setAttribute("data-arriving", "");
    this.arriving.push({ node, until: performance.now() + ARRIVING_MS });
    this.armArriving();
  }

  private armArriving() {
    if (this.arrivingTimer !== undefined || !this.arriving.length) {
      return;
    }
    this.arrivingTimer = window.setTimeout(
      () => {
        this.arrivingTimer = undefined;
        this.settleArriving(false);
      },
      Math.max(0, this.arriving[0].until - performance.now()),
    );
  }

  // Takes the mark off what has finished fading in, or off everything.
  private settleArriving(all: boolean) {
    const now = performance.now();
    while (this.arriving.length && (all || this.arriving[0].until <= now)) {
      this.arriving.shift()?.node.removeAttribute("data-arriving");
    }
    if (all) {
      window.clearTimeout(this.arrivingTimer);
      this.arrivingTimer = undefined;
    } else {
      this.armArriving();
    }
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

// Code shows at once; prose fades in.
function fadesIn(element: Element) {
  return (
    element.localName !== "pre" && !(element instanceof CaffoldTaskCodeBlock)
  );
}

// The line break Words writes after the last block in a container is not
// something it shows, so it does not count as content that changed.
function visible(nodes: Iterable<ChildNode>): Visible[] {
  const items: Visible[] = [];
  for (const node of nodes) {
    const piece =
      node instanceof HTMLSpanElement && node.hasAttribute("data-piece");
    if (node.nodeType === Node.TEXT_NODE || piece) {
      const last = items.at(-1);
      if (last && "text" in last) {
        last.text += node.textContent ?? "";
        last.nodes.push(node);
      } else {
        items.push({ text: node.textContent ?? "", nodes: [node] });
      }
    } else if (node instanceof Element) {
      items.push({ element: node });
    }
  }
  const last = items.at(-1);
  if (last && "text" in last && isLineBreak(last.text)) {
    items.pop();
  }
  return items;
}

// The line break Words writes between blocks, which shows nothing.
function isLineBreak(text: string) {
  return !text.trim() && text.includes("\n");
}

function lastNode(item: Visible) {
  return "text" in item ? (item.nodes.at(-1) as ChildNode) : item.element;
}

// Where `after` grows from `before`: -1 when items only follow the drawn
// ones, the index of the one item that grows, or null when `after` changes
// what is drawn. Items may follow a growing item only when it is the last.
// Otherwise every item after it stays the same, as the cells after the one a
// table row is filling do.
function growthAt(
  before: Visible[],
  after: Visible[],
  code: NextCode,
): number | null {
  if (after.length < before.length) {
    return null;
  }
  const at = before.findIndex((item, index) => !same(item, after[index], code));
  if (at === -1) {
    return -1;
  }
  if (!grows(before[at], after[at], code)) {
    return null;
  }
  if (at === before.length - 1) {
    return at;
  }
  return after.length === before.length &&
    before
      .slice(at + 1)
      .every((item, index) => same(item, after[at + 1 + index], code))
    ? at
    : null;
}

function grows(before: Visible, after: Visible, code: NextCode): boolean {
  if ("text" in before || "text" in after) {
    return "text" in before && "text" in after
      ? after.text.startsWith(before.text)
      : false;
  }
  if (!sameShell(before.element, after.element)) {
    return false;
  }
  if (before.element instanceof CaffoldTaskCodeBlock) {
    const next = code.get(after.element);
    return (
      next?.label === before.element.label &&
      next.text.startsWith(before.element.text)
    );
  }
  return (
    growthAt(
      visible(before.element.childNodes),
      visible(after.element.childNodes),
      code,
    ) !== null
  );
}

function same(before: Visible, after: Visible, code: NextCode): boolean {
  if ("text" in before || "text" in after) {
    return "text" in before && "text" in after
      ? before.text === after.text
      : false;
  }
  if (!sameShell(before.element, after.element)) {
    return false;
  }
  if (before.element instanceof CaffoldTaskCodeBlock) {
    const next = code.get(after.element);
    return (
      next?.label === before.element.label && next.text === before.element.text
    );
  }
  const drawn = visible(before.element.childNodes);
  const next = visible(after.element.childNodes);
  return (
    drawn.length === next.length &&
    drawn.every((item, index) => same(item, next[index], code))
  );
}

// The same element with the same attributes, apart from the mark of a fade.
// A code block's name and code are compared by its caller.
function sameShell(before: Element, after: Element) {
  if (before.localName !== after.localName) {
    return false;
  }
  if (before instanceof CaffoldTaskCodeBlock) {
    return true;
  }
  const names = (element: Element) =>
    element.getAttributeNames().filter((name) => name !== "data-arriving");
  const drawn = names(before);
  return (
    drawn.length === names(after).length &&
    drawn.every(
      (name) => before.getAttribute(name) === after.getAttribute(name),
    )
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
