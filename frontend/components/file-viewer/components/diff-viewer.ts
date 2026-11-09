import { html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SyntaxSpan } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "../../drawn-refs.js";
import { readPageAnchor, scrollToPageAnchor } from "../../page-anchor.js";
import { syntaxLine } from "../syntax-spans.js";
import type { CodePosition, ViewerPosition } from "./code-viewer.js";

import styles from "./diff-viewer.css.js";

export interface FileDiff {
  diff?: string;
  syntaxSpans?: Array<SyntaxSpan[] | null | undefined> | null;
}

type DiffRowType =
  | "hunk"
  | "note"
  | "added"
  | "removed"
  | "context"
  | "metadata";

interface DiffRow {
  index: number;
  type: DiffRowType;
  oldLine: number | null;
  newLine: number | null;
  prefix: string;
  content: string;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const EMPTY_DIFF_MESSAGE = "No diff for this file.";
// Rows of file text, which the server's `syntaxSpans` color by their line in
// the diff.
const SOURCE_ROWS = new Set<DiffRowType>(["added", "removed", "context"]);

@customElement("caffold-diff-viewer")
export class CaffoldDiffViewer extends CaffoldElement {
  @property({ attribute: false })
  accessor diff: FileDiff | null = null;
  @property({ attribute: false })
  accessor position: ViewerPosition | null = null;
  // Long lines wrap at the viewer's width instead of scrolling sideways.
  @property({ type: Boolean, reflect: true })
  accessor wrap = false;

  static override styles = styles;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly table = new DrawnRef<HTMLDivElement>(this);
  private readonly resizes = new ResizeObserver(() => this.keepReadingPlace());
  // Where the diff was last read while it was shown, or the place it was
  // handed off the page. A viewer taken off the page reads 0, so it is kept as
  // the person scrolls.
  private readingScroll: CodePosition | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.resizes.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.resizes.disconnect();
  }

  override render() {
    if (!this.diff) {
      return nothing;
    }
    const spans = this.diff.syntaxSpans;
    const rows = parseUnifiedDiff(this.diff.diff ?? "");
    const oldDigits = diffLineNumberDigits(rows, "oldLine");
    const newDigits = diffLineNumberDigits(rows, "newLine");
    const drawnRows = rows.length
      ? rows.map((row) => {
          const sourceLine = row.newLine ?? row.oldLine;
          return html`
            <div
              class="diff-row diff-row-${row.type}"
              data-source-line=${sourceLine || nothing}
            >
              <span class="diff-gutter">
                <span class="diff-old-line">${row.oldLine ?? ""}</span>
                <span class="diff-new-line">${row.newLine ?? ""}</span>
                <span class="diff-prefix">${row.prefix}</span>
              </span>
              <span class="diff-code">${
                SOURCE_ROWS.has(row.type)
                  ? syntaxLine(row.content, spans?.[row.index])
                  : row.content
              }</span>
            </div>
          `;
        })
      : html`
          <div class="diff-row diff-row-empty">
            <span class="diff-gutter" aria-hidden="true">
              <span class="diff-old-line"></span>
              <span class="diff-new-line"></span>
              <span class="diff-prefix"></span>
            </span>
            <span class="diff-code">${EMPTY_DIFF_MESSAGE}</span>
          </div>
        `;
    return html`
      <section class="diff-viewer" aria-label="Git diff">
        <div
          ${drawn(this.scrollport)}
          ${this.surfaces.surface({
            id: "scroll",
            axes: ["vertical", "horizontal"],
            clipRoots: () => [this, this.scrollport.value],
          })}
          class="diff-lines"
          @scroll=${{ handleEvent: () => this.recordReading(), passive: true }}
          style="
            --diff-old-number-columns: ${oldDigits}ch;
            --diff-new-number-columns: ${newDigits}ch;
          "
        >
          <div class="diff-gutter-backdrop" aria-hidden="true"></div>
          <div
            ${drawn(this.table)}
            class="diff-table"
            style="--diff-code-width: ${diffCodeColumns(rows)}ch;"
          >
            ${drawnRows}
          </div>
          <slot name="end"></slot>
        </div>
      </section>
    `;
  }

  // The rows stay in place from one diff to the next, so a diff that keeps
  // no position starts from the top again. Wrapping or unwrapping the lines
  // keeps the row being read at the top.
  override updated(changed: PropertyValues) {
    if (changed.has("diff") || changed.has("position")) {
      this.restorePosition(this.position);
    } else if (changed.has("wrap")) {
      this.keepReadingPlace();
    }
  }

  getScrollState() {
    return this.captureScroll();
  }

  readingPosition() {
    return this.readingScroll;
  }

  scrollSurfaceScope({ label = "File diff", ...pull }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  visibleLine() {
    const scroller = this.scroller;
    if (!scroller) {
      return null;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const rows = this.rows();
    const firstVisibleIndex = rows.findIndex(
      (row) => row.getBoundingClientRect().bottom > scrollerTop,
    );
    if (firstVisibleIndex < 0) {
      return null;
    }
    for (let index = firstVisibleIndex; index < rows.length; index += 1) {
      const line = normalizeLine(rows[index].dataset.sourceLine);
      if (line) {
        return line;
      }
    }
    return null;
  }

  scrollToLine(line: number | string | null | undefined) {
    const targetLine = normalizeLine(line);
    const scroller = this.scroller;
    if (!targetLine || !scroller) {
      return false;
    }
    const rows = this.rows();
    const row = rows
      .filter((candidate) => candidate.dataset.sourceLine)
      .reduce<HTMLElement | null>((nearest, candidate) => {
        if (!nearest) {
          return candidate;
        }
        const candidateDistance = Math.abs(
          Number(candidate.dataset.sourceLine) - targetLine,
        );
        const nearestDistance = Math.abs(
          Number(nearest.dataset.sourceLine) - targetLine,
        );
        return candidateDistance < nearestDistance ? candidate : nearest;
      }, null);
    if (!row) {
      return false;
    }
    scroller.scrollTop = row.offsetTop - rows[0].offsetTop + 1;
    return true;
  }

  private get scroller() {
    return this.scrollport.value;
  }

  // The drawn rows in order, the empty diff's one row included.
  private rows() {
    return [...(this.table.value?.children ?? [])] as HTMLElement[];
  }

  private captureScroll(): CodePosition | null {
    const scroller = this.scroller;
    const anchor = scroller && readPageAnchor(scroller, this.rows());
    return scroller && anchor ? { anchor, left: scroller.scrollLeft } : null;
  }

  private restoreScroll(scroll: CodePosition) {
    const scroller = this.scroller;
    if (scroller) {
      scrollToPageAnchor(scroller, this.rows(), scroll.anchor);
      scroller.scrollLeft = scroll.left;
    }
  }

  // Off the page nothing scrolls, so the place waits there for the viewer to
  // come back. A place set to where the viewer already was moves nothing and
  // so sends no scroll, so the place is read here as well.
  private restorePosition(position: ViewerPosition | null) {
    const scroller = this.scroller;
    if (!scroller?.getClientRects().length) {
      this.readingScroll = position?.scroll ?? null;
      return;
    }
    if (position?.scroll) {
      this.restoreScroll(position.scroll);
    } else {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      this.scrollToLine(position?.line);
    }
    this.recordReading();
  }

  // Wrapped rows change height when the width or the wrapping changes, so the
  // row read last is put back at the top, as it is when the viewer returns to
  // the page.
  private keepReadingPlace() {
    if (this.readingScroll && this.scroller?.getClientRects().length) {
      this.restoreScroll(this.readingScroll);
    }
  }

  private recordReading() {
    const scroller = this.scroller;
    if (scroller?.getClientRects().length) {
      this.readingScroll = this.captureScroll();
    }
  }
}

function normalizeLine(line: number | string | null | undefined) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function diffCodeColumns(rows: DiffRow[]) {
  const columns = rows.reduce(
    (max, row) => Math.max(max, monospaceColumns(row.content)),
    0,
  );

  return Math.max(columns, EMPTY_DIFF_MESSAGE.length, 1);
}

function diffLineNumberDigits(rows: DiffRow[], field: "oldLine" | "newLine") {
  const maximum = rows.reduce((max, row) => Math.max(max, row[field] ?? 0), 0);
  return Math.max(String(maximum).length, 2);
}

function monospaceColumns(text: string) {
  let columns = 0;

  for (const char of text) {
    columns += char === "\t" ? 4 : 1;
  }

  return columns;
}

function parseUnifiedDiff(diffText: string): DiffRow[] {
  if (!diffText) {
    return [];
  }

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLinesRemaining = 0;
  let newLinesRemaining = 0;

  for (const [index, line] of diffText.split("\n").entries()) {
    const hunkMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      oldLinesRemaining = hunkLineCount(hunkMatch[2]);
      newLine = Number(hunkMatch[3]);
      newLinesRemaining = hunkLineCount(hunkMatch[4]);
      rows.push({
        index,
        type: "hunk",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: line,
      });
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      rows.push({
        index,
        type: "note",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: line,
      });
      continue;
    }

    if (line.startsWith("+") && newLinesRemaining > 0) {
      rows.push({
        index,
        type: "added",
        oldLine: null,
        newLine,
        prefix: "+",
        content: line.slice(1),
      });
      newLine += 1;
      newLinesRemaining -= 1;
      continue;
    }

    if (line.startsWith("-") && oldLinesRemaining > 0) {
      rows.push({
        index,
        type: "removed",
        oldLine,
        newLine: null,
        prefix: "-",
        content: line.slice(1),
      });
      oldLine += 1;
      oldLinesRemaining -= 1;
      continue;
    }

    if (
      line.startsWith(" ") &&
      oldLinesRemaining > 0 &&
      newLinesRemaining > 0
    ) {
      rows.push({
        index,
        type: "context",
        oldLine,
        newLine,
        prefix: " ",
        content: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      oldLinesRemaining -= 1;
      newLinesRemaining -= 1;
      continue;
    }

    rows.push({
      index,
      type: "metadata",
      oldLine: null,
      newLine: null,
      prefix: "",
      content: line,
    });
  }

  return rows;
}

function hunkLineCount(count: string | undefined) {
  return count === undefined ? 1 : Number(count);
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-diff-viewer": CaffoldDiffViewer;
  }
}
