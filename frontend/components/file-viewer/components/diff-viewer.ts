import { html, LitElement, nothing, type PropertyValues } from "lit";
import type { SyntaxSpan } from "#app/api.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "../../drawn-refs.ts";
import { syntaxLine } from "../syntax-spans.ts";
import type { ScrollPosition, ViewerPosition } from "./code-viewer.ts";

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

export class CaffoldDiffViewer extends LitElement {
  static properties = {
    diff: { attribute: false },
    position: { attribute: false },
  };

  declare diff: FileDiff | null;
  declare position: ViewerPosition | null;

  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly table = new DrawnRef<HTMLDivElement>(this);

  constructor() {
    super();
    this.diff = null;
    this.position = null;
  }

  createRenderRoot() {
    return this;
  }

  render() {
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
        </div>
      </section>
    `;
  }

  // The rows stay in place from one diff to the next, so a diff that keeps
  // no position starts from the top again.
  updated(changed: PropertyValues) {
    if (changed.has("diff") || changed.has("position")) {
      this.restorePosition(this.position);
    }
  }

  getScrollState() {
    return this.captureScroll();
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

  private restorePosition(position: ViewerPosition | null) {
    if (position?.scroll) {
      this.restoreScroll(position.scroll);
      return;
    }
    this.restoreScroll({ top: 0, left: 0 });
    this.scrollToLine(position?.line);
  }
}

function normalizeLine(line: number | string | null | undefined) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}

customElements.define("caffold-diff-viewer", CaffoldDiffViewer);

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
