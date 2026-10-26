import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
} from "../action-hint-scope.ts";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "../action-hints.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.ts";
import type { DocumentPreviewFile } from "./dom.ts";
import "./loading-text.ts";
import "./segmented-control.ts";
import { DrawnRef, drawn } from "./drawn-refs.ts";
import type { CaffoldSegmentedControl } from "./segmented-control.ts";
import {
  containsRange,
  coverMerges,
  type TrackRange,
  trackOffsets,
  visibleTracks,
} from "./xlsx-viewer/window.ts";
import {
  readWorkbook,
  type SheetJs,
  type SheetModel,
  type WorkbookModel,
} from "./xlsx-viewer/workbook.ts";

const SHEETJS_VERSION = "0.20.3";
const SHEETJS_IMPORT = `https://cdn.sheetjs.com/xlsx-${SHEETJS_VERSION}/package/xlsx.mjs`;

// Tracks drawn beyond each edge of the viewport, so a short scroll reuses the
// cells already in place.
const OVERSCAN_ROWS = 20;
const OVERSCAN_COLUMNS = 8;

type RenderState = "empty" | "loading" | "error" | "xlsx";
type LayerName = "top" | "left" | "main";

interface VisibleSheet {
  name: string;
  hidden: boolean;
  index: number;
}

let libraryPromise: Promise<SheetJs> | undefined;

class CaffoldXlsxViewer extends LitElement {
  static properties = {
    file: { attribute: false },
    renderState: { state: true },
    visibleSheets: { state: true },
  };

  declare file: DocumentPreviewFile | null;
  declare private renderState: RenderState;
  declare private visibleSheets: VisibleSheet[] | null;
  private generation = 0;
  private selectedSheetName: string | null = null;
  private workbook: WorkbookModel | null = null;
  private columnName: (column: number) => string = (column) => `${column}`;
  private sheet: SheetModel | null = null;
  private rowOffsets = new Float64Array(1);
  private columnOffsets = new Float64Array(1);
  private renderedRange: TrackRange | null = null;
  private sizeObserver: ResizeObserver | null = null;
  private windowFrame = 0;
  // The sheet's corner and scrolling layers, made by `layoutSheet`.
  private corner: HTMLElement | null = null;
  private layers: Record<LayerName, HTMLElement> | null = null;
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly sheetport = new DrawnRef<HTMLDivElement>(this);
  private readonly space = new DrawnRef<HTMLDivElement>(this);
  private readonly tabStrip = new DrawnRef<HTMLDivElement>(this);
  private readonly sheetTabs = new DrawnRef<CaffoldSegmentedControl>(this);

  constructor() {
    super();
    this.file = null;
    this.renderState = "empty";
    this.visibleSheets = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Excel preview");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.release();
  }

  // The sheet's space is drawn by `layoutSheet` and `drawWindow`, which
  // replace only the cells near the viewport as it scrolls.
  render() {
    const message =
      this.renderState === "loading"
        ? html`<caffold-loading-text>Loading document...</caffold-loading-text>`
        : this.renderState === "error"
          ? "This document could not be displayed."
          : "";
    const tabbed = (this.visibleSheets?.length ?? 0) > 1;
    const content =
      this.renderState === "xlsx"
        ? html`
            <div class="xlsx-viewer-workbook">
              <div
                ${drawn(this.sheetport)}
                ${this.surfaces.surface({
                  id: "sheet",
                  axes: ["vertical", "horizontal"],
                  clipRoots: () => [this],
                })}
                class="xlsx-viewer-sheet"
                @scroll=${{
                  handleEvent: () => this.scheduleWindow(this.generation),
                  passive: true,
                }}
              ><div ${drawn(this.space)} class="xlsx-viewer-space"></div></div>
              <div
                ${drawn(this.tabStrip)}
                ${this.surfaces.surface({
                  id: "sheets",
                  label: (name) => `${name} sheets`,
                  axes: ["horizontal"],
                  when: tabbed,
                  clipRoots: () => [this],
                })}
                class="xlsx-viewer-tabs"
                ?hidden=${!tabbed}
                @caffold:segmented-control-intent=${(event: CustomEvent) => {
                  // The tabs choose this viewer's sheet; no review surface
                  // above owns them.
                  event.stopPropagation();
                  this.showSheet(this.generation, Number(event.detail?.value));
                }}
              ><caffold-segmented-control
                ${drawn(this.sheetTabs)}
              ></caffold-segmented-control></div>
            </div>
          `
        : message
          ? html`<p class="xlsx-viewer-message">${message}</p>`
          : nothing;
    return html`<div class="xlsx-viewer-body">${content}</div>`;
  }

  // A file handed over again before it is drawn replaces the one before it.
  // A newer copy of the file already shown keeps the sheet the person was
  // reading.
  willUpdate(changed: PropertyValues) {
    if (!changed.has("file") || !this.file) {
      return;
    }
    if (!this.file.newerCopy) {
      this.selectedSheetName = null;
    }
    this.release();
    this.renderState = "loading";
    void this.open(this.generation, this.file.file);
  }

  updated(changed: PropertyValues) {
    if (changed.has("renderState")) {
      this.dataset.renderState = this.renderState;
    }
  }

  scrollSurfaceScope({
    label = "Excel preview",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  // The sheet tabs, which do what the owner's `button` action names, and the
  // links of the cells drawn now, its `link` action.
  actionHintScope(pull: ActionHintPull = {}) {
    const own = this.hints.scope(pull);
    const sheetport = this.sheetport.value;
    const tabs = this.tabStrip.value;
    if (!sheetport || this.renderState !== "xlsx") {
      return own;
    }
    const clipRoots = [this, ...(pull.clipRoots ?? [])];
    const linkActionId = pull.actions?.link;
    const links = linkActionId
      ? [...sheetport.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap(
          (control) => {
            const label = linkActionHintLabel(control);
            if (!label || !hasActionHintLayoutBox(control)) {
              return [];
            }
            return [
              linkActionHintTarget({
                invalidationOwner: this,
                id: `${pull.scopeId}:cell:${control.dataset.cell}`,
                actionId: linkActionId,
                label,
                control,
                clipRoots: [sheetport, ...clipRoots],
              }),
            ];
          },
        )
      : [];
    return mergeActionHintScopes(
      own,
      { targets: links, scrollRoots: [sheetport] },
      tabs
        ? this.sheetTabs.value?.actionHintScope({
            scopeId: `${pull.scopeId}:sheets`,
            actionId: pull.actions?.button,
            clipRoots: [tabs, ...clipRoots],
          })
        : null,
    );
  }

  private async open(generation: number, file: Blob | Promise<Blob>) {
    try {
      const [XLSX, bytes] = await Promise.all([loadLibrary(), readBytes(file)]);
      if (!this.isCurrent(generation)) {
        return;
      }
      const workbook = readWorkbook(XLSX, new Uint8Array(bytes));
      if (!this.isCurrent(generation)) {
        return;
      }
      await this.mountWorkbook(generation, XLSX, workbook);
    } catch (error) {
      // A fetch let go of is followed by another file or by nothing at all.
      if (
        this.isCurrent(generation) &&
        (error as Error | null)?.name !== "AbortError"
      ) {
        this.renderState = "error";
      }
    }
  }

  private async mountWorkbook(
    generation: number,
    XLSX: SheetJs,
    workbook: WorkbookModel,
  ) {
    const visibleSheets = workbook.sheets
      .map((sheet, index) => ({ ...sheet, index }))
      .filter((sheet) => !sheet.hidden);
    if (!visibleSheets.length) {
      throw new Error("the workbook has no visible sheet");
    }
    this.workbook = workbook;
    this.columnName = (column) => XLSX.utils.encode_col(column);
    this.visibleSheets = visibleSheets;
    this.renderState = "xlsx";
    await this.updateComplete;
    if (!this.isCurrent(generation)) {
      return;
    }

    const sheetport = this.sheetport.value;
    if (sheetport) {
      this.sizeObserver = new ResizeObserver(() =>
        this.scheduleWindow(generation),
      );
      this.sizeObserver.observe(sheetport);
    }

    const preferred = visibleSheets.find(
      (sheet) => sheet.name === this.selectedSheetName,
    );
    this.showSheet(generation, (preferred ?? visibleSheets[0]).index);
  }

  private showSheet(generation: number, index: number) {
    if (!this.isCurrent(generation) || !this.workbook) {
      return;
    }
    const sheet = this.visibleSheets?.find(
      (candidate) => candidate.index === index,
    );
    if (!sheet) {
      return;
    }
    this.selectedSheetName = sheet.name;
    this.sheetTabs.value?.setSnapshot({
      label: "Sheets",
      actionVerb: "Show sheet",
      selected: `${index}`,
      choices: (this.visibleSheets ?? []).map((candidate) => ({
        value: `${candidate.index}`,
        label: candidate.name,
      })),
    });
    this.sheet = this.workbook.sheet(index);
    this.layoutSheet(this.sheet);
    const sheetport = this.sheetport.value;
    if (sheetport) {
      sheetport.scrollTop = 0;
      sheetport.scrollLeft = 0;
    }
    this.renderedRange = null;
    this.drawWindow(this.sheet);
  }

  // The space is a 2 x 2 grid: headers and frozen tracks in its first row and
  // column stay in place by `position: sticky`, and the scrolling part fills
  // the rest at the size the workbook gives it.
  private layoutSheet(sheet: SheetModel) {
    this.rowOffsets = trackOffsets(sheet.rowHeights, sheet.frozenRows);
    this.columnOffsets = trackOffsets(sheet.columnWidths, sheet.frozenColumns);
    const frozenHeight = sum(sheet.rowHeights, 0, sheet.frozenRows);
    const frozenWidth = sum(sheet.columnWidths, 0, sheet.frozenColumns);
    const space = this.space.value;
    if (!space) {
      return;
    }
    space.style.setProperty(
      "--xlsx-row-number-digits",
      `${String(sheet.rowCount).length}`,
    );
    space.style.gridTemplateColumns =
      `calc(var(--xlsx-row-header-width) + ${frozenWidth}px) ` +
      `${this.columnOffsets[this.columnOffsets.length - 1]}px`;
    space.style.gridTemplateRows =
      `calc(var(--xlsx-column-header-height) + ${frozenHeight}px) ` +
      `${this.rowOffsets[this.rowOffsets.length - 1]}px`;

    const frozenRows = range(0, sheet.frozenRows - 1);
    const frozenColumns = range(0, sheet.frozenColumns - 1);
    this.corner = this.block(
      "corner",
      [-1, ...frozenRows],
      [-1, ...frozenColumns],
    );
    this.layers = {
      top: this.layer("top"),
      left: this.layer("left"),
      main: this.layer("main"),
    };
    space.replaceChildren(
      this.corner,
      this.layers.top,
      this.layers.left,
      this.layers.main,
    );
  }

  private scheduleWindow(generation: number) {
    if (this.windowFrame || !this.isCurrent(generation)) {
      return;
    }
    this.windowFrame = window.requestAnimationFrame(() => {
      this.windowFrame = 0;
      if (this.isCurrent(generation) && this.sheet) {
        this.drawWindow(this.sheet);
      }
    });
  }

  // Draws the scrolling rows and columns near the viewport when they leave the
  // range already drawn.
  private drawWindow(sheet: SheetModel) {
    const sheetport = this.sheetport.value;
    const space = this.space.value;
    if (!sheetport || !space) {
      return;
    }
    const corner = this.corner;
    const visibleRows = visibleTracks(
      this.rowOffsets,
      sheet.frozenRows,
      sheetport.scrollTop,
      sheetport.clientHeight - (corner?.offsetHeight ?? 0),
    );
    const visibleColumns = visibleTracks(
      this.columnOffsets,
      sheet.frozenColumns,
      sheetport.scrollLeft,
      sheetport.clientWidth - (corner?.offsetWidth ?? 0),
    );
    const visible = {
      top: visibleRows.first,
      bottom: visibleRows.last,
      left: visibleColumns.first,
      right: visibleColumns.last,
    };
    if (containsRange(this.renderedRange, visible)) {
      return;
    }
    const covered = coverMerges(
      {
        top: Math.max(visible.top - OVERSCAN_ROWS, sheet.frozenRows),
        bottom: Math.min(visible.bottom + OVERSCAN_ROWS, sheet.rowCount - 1),
        left: Math.max(visible.left - OVERSCAN_COLUMNS, sheet.frozenColumns),
        right: Math.min(
          visible.right + OVERSCAN_COLUMNS,
          sheet.columnCount - 1,
        ),
      },
      sheet.merges,
    );
    // A merge reaching into the frozen tracks stays clipped at their edge.
    const drawn = {
      ...covered,
      top: Math.max(covered.top, sheet.frozenRows),
      left: Math.max(covered.left, sheet.frozenColumns),
    };
    this.renderedRange = drawn;

    const rows = range(drawn.top, drawn.bottom);
    const columns = range(drawn.left, drawn.right);
    const frozenRows = range(0, sheet.frozenRows - 1);
    const frozenColumns = range(0, sheet.frozenColumns - 1);
    const top = this.rowOffsets[drawn.top - sheet.frozenRows] ?? 0;
    const left = this.columnOffsets[drawn.left - sheet.frozenColumns] ?? 0;
    this.fillLayer("top", this.block("columns", [-1, ...frozenRows], columns), {
      left,
    });
    this.fillLayer("left", this.block("rows", rows, [-1, ...frozenColumns]), {
      top,
    });
    this.fillLayer("main", this.block("cells", rows, columns), { top, left });
  }

  private layer(name: LayerName) {
    const layer = window.document.createElement("div");
    layer.className = `xlsx-viewer-layer xlsx-viewer-${name}`;
    return layer;
  }

  private fillLayer(
    name: LayerName,
    block: HTMLElement,
    { top = 0, left = 0 }: { top?: number; left?: number },
  ) {
    block.style.top = `${top}px`;
    block.style.left = `${left}px`;
    this.layers?.[name].replaceChildren(block);
  }

  // One CSS grid of cells, with -1 standing for the header track. Merged cells
  // span their tracks inside the block; the cells they cover are not drawn,
  // and neither are those of hidden rows and columns, which keep only their
  // zero-size track.
  private block(name: string, rows: number[], columns: number[]) {
    const block = window.document.createElement("div");
    block.className = `xlsx-viewer-block xlsx-viewer-${name}`;
    const sheet = this.sheet;
    if (!sheet) {
      return block;
    }
    block.style.gridTemplateRows = rows
      .map((row) =>
        row < 0
          ? "var(--xlsx-column-header-height)"
          : `${sheet.rowHeights[row]}px`,
      )
      .join(" ");
    block.style.gridTemplateColumns = columns
      .map((column) =>
        column < 0
          ? "var(--xlsx-row-header-width)"
          : `${sheet.columnWidths[column]}px`,
      )
      .join(" ");
    const lastRow = rows[rows.length - 1];
    const lastColumn = columns[columns.length - 1];
    const cells: HTMLElement[] = [];
    rows.forEach((row, rowIndex) => {
      columns.forEach((column, columnIndex) => {
        if (row >= 0 && column >= 0 && sheet.isCovered(row, column)) {
          return;
        }
        const hidden =
          sheet.rowHeights[row] === 0 || sheet.columnWidths[column] === 0;
        if (
          hidden &&
          !(row >= 0 && column >= 0 && sheet.mergeAt(row, column))
        ) {
          return;
        }
        const element =
          row < 0 || column < 0
            ? this.headerCell(row, column)
            : this.dataCell(sheet, row, column, lastRow, lastColumn);
        element.style.gridRowStart = `${rowIndex + 1}`;
        element.style.gridColumnStart = `${columnIndex + 1}`;
        cells.push(element);
      });
    });
    block.append(...cells);
    return block;
  }

  private headerCell(row: number, column: number) {
    const element = window.document.createElement("div");
    element.className = "xlsx-viewer-header";
    if (row < 0 && column >= 0) {
      element.textContent = this.columnName(column);
    } else if (column < 0 && row >= 0) {
      element.textContent = `${row + 1}`;
    }
    return element;
  }

  private dataCell(
    sheet: SheetModel,
    row: number,
    column: number,
    lastRow: number,
    lastColumn: number,
  ) {
    const element = window.document.createElement("div");
    element.className = "xlsx-viewer-cell";
    const merge = sheet.mergeAt(row, column);
    if (merge) {
      element.style.gridRowEnd = `span ${Math.min(merge.bottom, lastRow) - row + 1}`;
      element.style.gridColumnEnd = `span ${Math.min(merge.right, lastColumn) - column + 1}`;
    }
    const style = this.workbook?.styles[sheet.styleAt(row, column)];
    for (const [property, value] of style?.declarations ?? []) {
      element.style.setProperty(property, value);
    }
    const cell = sheet.cellAt(row, column);
    if (!cell?.text) {
      return element;
    }
    // A cell left to General alignment places numbers and dates at the end
    // and true/false and errors in the middle, as Excel does.
    if (!style?.alignsHorizontally && cell.kind) {
      element.dataset.kind = cell.kind;
    }
    const content = window.document.createElement(cell.link ? "a" : "span");
    content.textContent = cell.text;
    if (content instanceof HTMLAnchorElement && cell.link) {
      content.href = cell.link;
      content.target = "_blank";
      content.rel = "noreferrer";
      content.dataset.cell = `${row}:${column}`;
    }
    element.append(content);
    return element;
  }

  private release() {
    this.generation += 1;
    this.sizeObserver?.disconnect();
    this.sizeObserver = null;
    if (this.windowFrame) {
      window.cancelAnimationFrame(this.windowFrame);
      this.windowFrame = 0;
    }
    this.workbook = null;
    this.visibleSheets = null;
    this.sheet = null;
    this.renderedRange = null;
    this.corner = null;
    this.layers = null;
  }

  private isCurrent(generation: number) {
    return this.isConnected && this.generation === generation;
  }
}

function range(first: number, last: number) {
  const values: number[] = [];
  for (let value = first; value <= last; value += 1) {
    values.push(value);
  }
  return values;
}

function sum(values: Float64Array, first: number, end: number) {
  let total = 0;
  for (let index = first; index < end; index += 1) {
    total += values[index];
  }
  return total;
}

async function readBytes(file: Blob | Promise<Blob>) {
  return (await file).arrayBuffer();
}

function loadLibrary() {
  libraryPromise ??= import(SHEETJS_IMPORT);
  return libraryPromise;
}

customElements.define("caffold-xlsx-viewer", CaffoldXlsxViewer);
