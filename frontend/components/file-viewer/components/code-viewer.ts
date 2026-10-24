import { html, LitElement, nothing } from "lit";
import type { SyntaxSpan } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { syntaxLine } from "../syntax-spans.ts";

export interface CodeFile {
  content: string;
  syntaxSpans?: Array<SyntaxSpan[] | null | undefined> | null;
}

export interface ScrollPosition {
  top: number;
  left: number;
}

// Where a newly shown file or diff opens: at a kept scroll position, at a
// line, or at the top.
export interface ViewerPositionOptions {
  scroll?: ScrollPosition | null;
  preserveScroll?: boolean;
  line?: number | string | null;
}

export class CaffoldCodeViewer extends LitElement {
  static properties = {
    file: { state: true },
  };

  declare private file: CodeFile | null;

  constructor() {
    super();
    this.file = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
    if (!this.file) {
      return nothing;
    }
    const spans = this.file.syntaxSpans;
    const lines = this.file.content.split(/\r?\n/);
    return html`
      <section class="code-viewer">
        <div
          class="code-lines"
          role="region"
          aria-label="File content"
          style="--code-line-number-columns: ${lineNumberDigits(lines)}ch;"
        >
          <div class="code-gutter-backdrop" aria-hidden="true"></div>
          <div
            class="code-table"
            style="--code-content-width: ${codeColumns(lines)}ch;"
          >
            ${lines.map(
              (line, index) => html`
                <div class="code-row" data-line-number=${index + 1}>
                  <span class="line-number">${index + 1}</span>
                  <code class="line-code">${
                    line.length === 0
                      ? "\u00a0"
                      : syntaxLine(line, spans?.[index])
                  }</code>
                </div>
              `,
            )}
          </div>
        </div>
      </section>
    `;
  }

  setFile(file: CodeFile, options: ViewerPositionOptions = {}) {
    const scroll =
      options.scroll ?? (options.preserveScroll ? this.captureScroll() : null);
    const line = normalizeLine(options.line);
    this.file = file;
    this.performUpdate();
    this.restorePosition(scroll, line);
  }

  getScrollState() {
    return this.captureScroll();
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "File content",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(
      ":scope > .code-viewer > .code-lines",
    );
    if (!scopeId || !label || !scrollport || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport,
          axes: ["vertical", "horizontal"],
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(":scope > .code-viewer > .code-lines") ===
              scrollport &&
            isCurrent() &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  visibleLine() {
    const scroller = this.scroller;
    if (!scroller) {
      return null;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const row = Array.from(
      this.querySelectorAll<HTMLElement>(".code-row[data-line-number]"),
    ).find(
      (candidate) => candidate.getBoundingClientRect().bottom > scrollerTop,
    );
    return normalizeLine(row?.dataset.lineNumber);
  }

  scrollToLine(line: number | string | null | undefined) {
    const targetLine = normalizeLine(line);
    const scroller = this.scroller;
    if (!targetLine || !scroller) {
      return false;
    }
    const row = this.querySelector<HTMLElement>(
      `.code-row[data-line-number="${targetLine}"]`,
    );
    if (!row) {
      return false;
    }
    const firstRow = this.querySelector<HTMLElement>(
      ".code-row[data-line-number]",
    );
    scroller.scrollTop = row.offsetTop - (firstRow?.offsetTop ?? 0) + 1;
    return true;
  }

  private get scroller() {
    return this.querySelector<HTMLElement>(".code-lines");
  }

  private captureScroll() {
    const scroller = this.scroller;
    return scroller
      ? { top: scroller.scrollTop, left: scroller.scrollLeft }
      : null;
  }

  private restoreScroll(scroll: ScrollPosition) {
    const scroller = this.scroller;
    if (scroller) {
      scroller.scrollTop = scroll.top;
      scroller.scrollLeft = scroll.left;
    }
  }

  // The lines stay in place from one file to the next, so a file that keeps
  // no position starts from the top again.
  private restorePosition(scroll: ScrollPosition | null, line: number | null) {
    if (scroll) {
      this.restoreScroll(scroll);
      return;
    }
    this.restoreScroll({ top: 0, left: 0 });
    this.scrollToLine(line);
  }
}

function normalizeLine(line: number | string | null | undefined) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function codeColumns(lines: string[]) {
  const columns = lines.reduce(
    (max, line) => Math.max(max, monospaceColumns(line)),
    0,
  );

  return Math.max(columns, 1);
}

function lineNumberDigits(lines: string[]) {
  return Math.max(String(lines.length).length, 2);
}

function monospaceColumns(text: string) {
  let columns = 0;

  for (const char of text) {
    columns += char === "\t" ? 4 : 1;
  }

  return columns;
}

customElements.define("caffold-code-viewer", CaffoldCodeViewer);
