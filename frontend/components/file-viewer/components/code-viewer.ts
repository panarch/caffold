import { html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { LineChanges, SyntaxSpan } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "../../drawn-refs.js";
import { syntaxLine } from "../syntax-spans.js";

import styles from "./code-viewer.css.js";

export interface CodeFile {
  content: string;
  syntaxSpans?: Array<SyntaxSpan[] | null | undefined> | null;
  // Where the file differs from the base Review compares it with, marked
  // beside the line numbers.
  lineChanges?: LineChanges | null;
}

export interface ScrollPosition {
  top: number;
  left: number;
}

// Where a newly shown file or diff opens, as its owner asks: where the viewer
// is now, at a line, or at the top.
export interface ViewerPositionOptions {
  preserveScroll?: boolean;
  line?: number | string | null;
}

// Where a code or diff viewer opens what it is handed.
export interface ViewerPosition {
  scroll: ScrollPosition | null;
  line?: number | string | null;
}

@customElement("caffold-code-viewer")
export class CaffoldCodeViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor file: CodeFile | null = null;
  @property({ attribute: false })
  accessor position: ViewerPosition | null = null;

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly table = new DrawnRef<HTMLDivElement>(this);
  // Where the file was last read while it was shown. A viewer taken off the
  // page reads 0, so it is kept as the person scrolls.
  private readingScroll: ScrollPosition | null = null;

  override render() {
    if (!this.file) {
      return nothing;
    }
    const spans = this.file.syntaxSpans;
    const lines = this.file.content.split(/\r?\n/);
    const marks = lineMarks(this.file.lineChanges, lines.length);
    return html`
      <section class="code-viewer">
        <div
          ${drawn(this.scrollport)}
          ${this.surfaces.surface({
            id: "scroll",
            axes: ["vertical", "horizontal"],
            clipRoots: () => [this, this.scrollport.value],
          })}
          class="code-lines"
          @scroll=${{ handleEvent: () => this.recordReading(), passive: true }}
          role="region"
          aria-label="File content"
          style="--code-line-number-columns: ${lineNumberDigits(lines)}ch;"
        >
          <div class="code-gutter-backdrop" aria-hidden="true"></div>
          <div
            ${drawn(this.table)}
            class="code-table"
            style="--code-content-width: ${codeColumns(lines)}ch;"
          >
            ${lines.map(
              (line, index) => html`
                <div
                  class="code-row"
                  data-line-number=${index + 1}
                  data-line-change=${marks.added.has(index + 1) ? "added" : nothing}
                  data-line-removed=${marks.removed.get(index + 1) || nothing}
                >
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

  // The lines stay in place from one file to the next, so a file that keeps
  // no position starts from the top again.
  override updated(changed: PropertyValues) {
    if (changed.has("file") || changed.has("position")) {
      this.restorePosition(this.position);
    }
  }

  getScrollState() {
    return this.captureScroll();
  }

  readingPosition() {
    return this.readingScroll;
  }

  scrollSurfaceScope({
    label = "File content",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  visibleLine() {
    const scroller = this.scroller;
    if (!scroller) {
      return null;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const row = this.rows().find(
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
    const rows = this.rows();
    const row = rows[targetLine - 1];
    if (!row) {
      return false;
    }
    scroller.scrollTop = row.offsetTop - rows[0].offsetTop + 1;
    return true;
  }

  private get scroller() {
    return this.scrollport.value;
  }

  // One row for each line, in order.
  private rows() {
    return [...(this.table.value?.children ?? [])] as HTMLElement[];
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

  // A place set to where the viewer already was moves nothing and so sends no
  // scroll, so the place is read here as well.
  private restorePosition(position: ViewerPosition | null) {
    if (position?.scroll) {
      this.restoreScroll(position.scroll);
    } else {
      this.restoreScroll({ top: 0, left: 0 });
      this.scrollToLine(position?.line);
    }
    this.recordReading();
  }

  private recordReading() {
    const scroller = this.scroller;
    if (scroller?.getClientRects().length) {
      this.readingScroll = this.captureScroll();
    }
  }
}

// The rows a file's changes mark: each added line, and for each place lines
// were removed, the row below it, or the last row when it is the end.
function lineMarks(changes: LineChanges | null | undefined, rowCount: number) {
  const added = new Set<number>();
  for (const [first, last] of changes?.added ?? []) {
    for (let line = first; line <= Math.min(last, rowCount); line += 1) {
      added.add(line);
    }
  }
  const above = new Set<number>();
  const below = new Set<number>();
  for (const after of changes?.removedAfter ?? []) {
    if (after < rowCount) {
      above.add(after + 1);
    } else {
      below.add(rowCount);
    }
  }
  const removed = new Map<number, string>();
  for (const line of new Set([...above, ...below])) {
    removed.set(
      line,
      [above.has(line) && "above", below.has(line) && "below"]
        .filter(Boolean)
        .join(" "),
    );
  }
  return { added, removed };
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-code-viewer": CaffoldCodeViewer;
  }
}
