import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";
import "./loading-text.js";
import "./segmented-control.js";
import { readWorkbook } from "./xlsx-viewer/workbook.js";
import {
  containsRange,
  coverMerges,
  trackOffsets,
  visibleTracks,
} from "./xlsx-viewer/window.js";

const SHEETJS_VERSION = "0.20.3";
const SHEETJS_IMPORT =
  `https://cdn.sheetjs.com/xlsx-${SHEETJS_VERSION}/package/xlsx.mjs`;

// Tracks drawn beyond each edge of the viewport, so a short scroll reuses the
// cells already in place.
const OVERSCAN_ROWS = 20;
const OVERSCAN_COLUMNS = 8;

let libraryPromise;

class CaffoldXlsxViewer extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Excel preview");
  }

  disconnectedCallback() {
    this.release();
  }

  setSource(source = {}) {
    this.ensureRendered();
    const url = `${source.url ?? ""}`;
    const revision = source.revision ?? null;
    // A rebuilt header or resized pane shows the same file; only another file
    // or a newer modification time is a reason to read it again.
    if (
      this.url === url &&
      this.revision === revision &&
      this.dataset.renderState !== "error"
    ) {
      return;
    }
    // A newer copy of the same file keeps the sheet the person was reading.
    if (this.url !== url) {
      this.selectedSheetName = null;
    }
    this.release();
    this.url = url;
    this.revision = revision;
    this.showMessage("loading", "Loading document...");
    void this.open(this.generation, url);
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Excel preview",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    this.ensureRendered();
    const sheetport = this.sheetport();
    if (!scopeId || !label || this.hidden || !sheetport) {
      return emptyScrollSurfaceScope();
    }
    const eligible = (element) => () =>
      this.isConnected &&
      !this.hidden &&
      isCurrent() &&
      element.isConnected &&
      hasScrollLayoutBox(element);
    const surfaces = [{
      id: `${scopeId}:sheet`,
      label,
      scrollport: sheetport,
      axes: ["vertical", "horizontal"],
      clipRoots: [this, ...clipRoots].filter(Boolean),
      isEligible: eligible(sheetport),
    }];
    const tabs = this.tabStrip();
    if (tabs && !tabs.hidden) {
      surfaces.push({
        id: `${scopeId}:sheets`,
        label: `${label} sheets`,
        scrollport: tabs,
        axes: ["horizontal"],
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isEligible: eligible(tabs),
      });
    }
    return {
      blocked: false,
      surfaces,
      mutationRoots: [this],
      resizeElements: [this, sheetport],
      scrollRoots: [this, sheetport],
    };
  }

  // The sheet tabs and the links of the cells drawn now.
  actionHintScope({
    scopeId = "",
    linkActionId = "",
    buttonActionId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const sheetport = this.sheetport();
    if (
      !scopeId ||
      !sheetport ||
      !this.isConnected ||
      this.hidden ||
      this.dataset.renderState !== "xlsx"
    ) {
      return emptyActionHintScope();
    }
    const roots = [this, ...clipRoots].filter(Boolean);
    const tabs = this.tabStrip();
    const tabScope = buttonActionId && tabs && !tabs.hidden
      ? tabs.querySelector(":scope > caffold-segmented-control")?.actionHintScope({
          scopeId: `${scopeId}:sheets`,
          actionId: buttonActionId,
          clipRoots: [tabs, ...roots],
          labelForChoice: (choice) => `Show sheet ${choice.label}`,
        })
      : null;
    const links = linkActionId
      ? [...sheetport.querySelectorAll("a[href]")].flatMap((control) => {
          const label = linkActionHintLabel(control);
          if (!label || !hasActionHintLayoutBox(control)) {
            return [];
          }
          return [linkActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:cell:${control.dataset.cell}`,
            actionId: linkActionId,
            label,
            control,
            clipRoots: [sheetport, ...roots],
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              isCurrent() &&
              this.dataset.renderState === "xlsx" &&
              sheetport.contains(control) &&
              hasActionHintLayoutBox(control),
          })];
        })
      : [];
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: links,
        mutationRoots: [this],
        scrollRoots: [this, sheetport],
      },
      tabScope ?? emptyActionHintScope(),
    );
  }

  async open(generation, url) {
    const reading = new AbortController();
    this.reading = reading;
    try {
      const [XLSX, bytes] = await Promise.all([
        loadLibrary(),
        readDocument(url, reading.signal),
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }
      const workbook = readWorkbook(XLSX, new Uint8Array(bytes));
      if (!this.isCurrent(generation)) {
        return;
      }
      this.mountWorkbook(generation, XLSX, workbook);
    } catch {
      if (this.isCurrent(generation)) {
        this.showMessage("error", "This document could not be displayed.");
      }
    } finally {
      if (this.reading === reading) {
        this.reading = null;
      }
    }
  }

  mountWorkbook(generation, XLSX, workbook) {
    const visibleSheets = workbook.sheets
      .map((sheet, index) => ({ ...sheet, index }))
      .filter((sheet) => !sheet.hidden);
    if (!visibleSheets.length) {
      throw new Error("the workbook has no visible sheet");
    }
    const view = window.document.createElement("div");
    view.className = "xlsx-viewer-workbook";
    view.innerHTML = `
      <div class="xlsx-viewer-sheet"><div class="xlsx-viewer-space"></div></div>
      <div class="xlsx-viewer-tabs"><caffold-segmented-control></caffold-segmented-control></div>
    `;
    this.body().replaceChildren(view);
    this.workbook = workbook;
    this.columnName = (column) => XLSX.utils.encode_col(column);
    this.visibleSheets = visibleSheets;

    const tabs = this.tabStrip();
    tabs.hidden = visibleSheets.length < 2;
    tabs.addEventListener("caffold:segmented-control-intent", (event) => {
      // The tabs choose this viewer's sheet; no review surface above owns them.
      event.stopPropagation();
      this.showSheet(generation, Number(event.detail?.value));
    });
    const sheetport = this.sheetport();
    sheetport.addEventListener("scroll", () => this.scheduleWindow(generation), {
      passive: true,
    });
    this.sizeObserver = new ResizeObserver(() => this.scheduleWindow(generation));
    this.sizeObserver.observe(sheetport);

    const preferred = visibleSheets.find((sheet) => sheet.name === this.selectedSheetName);
    this.showSheet(generation, (preferred ?? visibleSheets[0]).index);
    this.dataset.renderState = "xlsx";
  }

  showSheet(generation, index) {
    if (!this.isCurrent(generation) || !this.workbook) {
      return;
    }
    const sheet = this.visibleSheets.find((candidate) => candidate.index === index);
    if (!sheet) {
      return;
    }
    this.selectedSheetName = sheet.name;
    this.tabStrip().querySelector(":scope > caffold-segmented-control")?.setSnapshot({
      label: "Sheets",
      selected: `${index}`,
      choices: this.visibleSheets.map((candidate) => ({
        value: `${candidate.index}`,
        label: candidate.name,
      })),
    });
    this.sheet = this.workbook.sheet(index);
    this.layoutSheet();
    const sheetport = this.sheetport();
    sheetport.scrollTop = 0;
    sheetport.scrollLeft = 0;
    this.renderedRange = null;
    this.drawWindow();
  }

  // The space is a 2 x 2 grid: headers and frozen tracks in its first row and
  // column stay in place by `position: sticky`, and the scrolling part fills
  // the rest at the size the workbook gives it.
  layoutSheet() {
    const sheet = this.sheet;
    this.rowOffsets = trackOffsets(sheet.rowHeights, sheet.frozenRows);
    this.columnOffsets = trackOffsets(sheet.columnWidths, sheet.frozenColumns);
    const frozenHeight = sum(sheet.rowHeights, 0, sheet.frozenRows);
    const frozenWidth = sum(sheet.columnWidths, 0, sheet.frozenColumns);
    const space = this.space();
    space.style.setProperty("--xlsx-row-number-digits", `${String(sheet.rowCount).length}`);
    space.style.gridTemplateColumns =
      `calc(var(--xlsx-row-header-width) + ${frozenWidth}px) ` +
      `${this.columnOffsets[this.columnOffsets.length - 1]}px`;
    space.style.gridTemplateRows =
      `calc(var(--xlsx-column-header-height) + ${frozenHeight}px) ` +
      `${this.rowOffsets[this.rowOffsets.length - 1]}px`;

    const frozenRows = range(0, sheet.frozenRows - 1);
    const frozenColumns = range(0, sheet.frozenColumns - 1);
    space.replaceChildren(
      this.block("corner", [-1, ...frozenRows], [-1, ...frozenColumns]),
      this.layer("top"),
      this.layer("left"),
      this.layer("main"),
    );
  }

  scheduleWindow(generation) {
    if (this.windowFrame || !this.isCurrent(generation)) {
      return;
    }
    this.windowFrame = window.requestAnimationFrame(() => {
      this.windowFrame = 0;
      if (this.isCurrent(generation) && this.sheet) {
        this.drawWindow();
      }
    });
  }

  // Draws the scrolling rows and columns near the viewport when they leave the
  // range already drawn.
  drawWindow() {
    const sheet = this.sheet;
    const sheetport = this.sheetport();
    const corner = this.space().querySelector(":scope > .xlsx-viewer-corner");
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
    const covered = coverMerges({
      top: Math.max(visible.top - OVERSCAN_ROWS, sheet.frozenRows),
      bottom: Math.min(visible.bottom + OVERSCAN_ROWS, sheet.rowCount - 1),
      left: Math.max(visible.left - OVERSCAN_COLUMNS, sheet.frozenColumns),
      right: Math.min(visible.right + OVERSCAN_COLUMNS, sheet.columnCount - 1),
    }, sheet.merges);
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
    this.fillLayer("top", this.block("columns", [-1, ...frozenRows], columns), { left });
    this.fillLayer("left", this.block("rows", rows, [-1, ...frozenColumns]), { top });
    this.fillLayer("main", this.block("cells", rows, columns), { top, left });
  }

  layer(name) {
    const layer = window.document.createElement("div");
    layer.className = `xlsx-viewer-layer xlsx-viewer-${name}`;
    return layer;
  }

  fillLayer(name, block, { top = 0, left = 0 }) {
    block.style.top = `${top}px`;
    block.style.left = `${left}px`;
    this.space().querySelector(`:scope > .xlsx-viewer-${name}`)?.replaceChildren(block);
  }

  // One CSS grid of cells, with -1 standing for the header track. Merged cells
  // span their tracks inside the block; the cells they cover are not drawn,
  // and neither are those of hidden rows and columns, which keep only their
  // zero-size track.
  block(name, rows, columns) {
    const sheet = this.sheet;
    const block = window.document.createElement("div");
    block.className = `xlsx-viewer-block xlsx-viewer-${name}`;
    block.style.gridTemplateRows = rows
      .map((row) => (row < 0 ? "var(--xlsx-column-header-height)" : `${sheet.rowHeights[row]}px`))
      .join(" ");
    block.style.gridTemplateColumns = columns
      .map((column) => (column < 0 ? "var(--xlsx-row-header-width)" : `${sheet.columnWidths[column]}px`))
      .join(" ");
    const lastRow = rows[rows.length - 1];
    const lastColumn = columns[columns.length - 1];
    const cells = [];
    rows.forEach((row, rowIndex) => {
      columns.forEach((column, columnIndex) => {
        if (row >= 0 && column >= 0 && sheet.isCovered(row, column)) {
          return;
        }
        const hidden = sheet.rowHeights[row] === 0 || sheet.columnWidths[column] === 0;
        if (hidden && !(row >= 0 && column >= 0 && sheet.mergeAt(row, column))) {
          return;
        }
        const element = row < 0 || column < 0
          ? this.headerCell(row, column)
          : this.dataCell(row, column, lastRow, lastColumn);
        element.style.gridRowStart = `${rowIndex + 1}`;
        element.style.gridColumnStart = `${columnIndex + 1}`;
        cells.push(element);
      });
    });
    block.append(...cells);
    return block;
  }

  headerCell(row, column) {
    const element = window.document.createElement("div");
    element.className = "xlsx-viewer-header";
    if (row < 0 && column >= 0) {
      element.textContent = this.columnName(column);
    } else if (column < 0 && row >= 0) {
      element.textContent = `${row + 1}`;
    }
    return element;
  }

  dataCell(row, column, lastRow, lastColumn) {
    const sheet = this.sheet;
    const element = window.document.createElement("div");
    element.className = "xlsx-viewer-cell";
    const merge = sheet.mergeAt(row, column);
    if (merge) {
      element.style.gridRowEnd = `span ${Math.min(merge.bottom, lastRow) - row + 1}`;
      element.style.gridColumnEnd = `span ${Math.min(merge.right, lastColumn) - column + 1}`;
    }
    const style = this.workbook.styles[sheet.styleAt(row, column)];
    for (const [property, value] of style?.declarations ?? []) {
      element.style.setProperty(property, value);
    }
    const cell = sheet.cellAt(row, column);
    if (!cell?.text) {
      return element;
    }
    // A cell left to General alignment places numbers and dates at the end
    // and true/false and errors in the middle, as Excel does.
    if (!style?.alignsHorizontally) {
      element.dataset.kind = cell.kind;
    }
    const content = window.document.createElement(cell.link ? "a" : "span");
    content.textContent = cell.text;
    if (cell.link) {
      content.href = cell.link;
      content.target = "_blank";
      content.rel = "noreferrer";
      content.dataset.cell = `${row}:${column}`;
    }
    element.append(content);
    return element;
  }

  release() {
    this.generation = (this.generation ?? 0) + 1;
    this.url = null;
    this.revision = null;
    this.reading?.abort();
    this.reading = null;
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
  }

  isCurrent(generation) {
    return this.isConnected && this.generation === generation;
  }

  ensureRendered() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.generation = 0;
    this.dataset.renderState = "empty";
    this.innerHTML = '<div class="xlsx-viewer-body"></div>';
  }

  showMessage(renderState, message) {
    const body = this.body();
    this.dataset.renderState = renderState;
    body.replaceChildren();
    const paragraph = window.document.createElement("p");
    paragraph.className = "xlsx-viewer-message";
    if (renderState === "loading") {
      const loadingText = window.document.createElement("caffold-loading-text");
      loadingText.textContent = message;
      paragraph.append(loadingText);
    } else {
      paragraph.textContent = message;
    }
    body.append(paragraph);
  }

  body() {
    return this.querySelector(":scope > .xlsx-viewer-body");
  }

  sheetport() {
    return this.querySelector(":scope > .xlsx-viewer-body > .xlsx-viewer-workbook > .xlsx-viewer-sheet");
  }

  space() {
    return this.sheetport()?.querySelector(":scope > .xlsx-viewer-space");
  }

  tabStrip() {
    return this.querySelector(":scope > .xlsx-viewer-body > .xlsx-viewer-workbook > .xlsx-viewer-tabs");
  }
}

function range(first, last) {
  const values = [];
  for (let value = first; value <= last; value += 1) {
    values.push(value);
  }
  return values;
}

function sum(values, first, end) {
  let total = 0;
  for (let index = first; index < end; index += 1) {
    total += values[index];
  }
  return total;
}

async function readDocument(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`document request failed with ${response.status}`);
  }
  return response.arrayBuffer();
}

function loadLibrary() {
  libraryPromise ??= import(SHEETJS_IMPORT);
  return libraryPromise;
}

customElements.define("caffold-xlsx-viewer", CaffoldXlsxViewer);
