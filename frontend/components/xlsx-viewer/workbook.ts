// Turns a workbook read by SheetJS into what the viewer draws: each sheet's
// tracks, frozen panes, merges, cell text, links, and the CSS of every cell
// style. SheetJS reads values, sizes, merges, fills, fonts, and alignment;
// which style each cell uses, the borders, and frozen panes come from the
// workbook's own XML, which SheetJS hands over unparsed.

import type { TrackRange } from "./window.js";

// The parts of SheetJS and of the workbook it reads that the viewer uses.
export interface SheetJs {
  read(bytes: Uint8Array, options: Record<string, unknown>): SheetJsWorkbook;
  utils: { encode_col(column: number): string };
}

interface SheetJsWorkbook {
  SheetNames: string[];
  Sheets: Record<string, SheetJsWorksheet | undefined>;
  Workbook?: { Sheets?: Array<{ Hidden?: number; id?: string } | undefined> };
  Themes?: { themeElements?: { clrScheme?: Array<{ rgb?: string }> } };
  Directory?: { style?: string; sheets?: string[] };
  Styles?: {
    Fonts?: SheetJsFont[];
    Fills?: SheetJsFill[];
    CellXf?: SheetJsCellXf[];
  };
  files?: Record<string, { content?: string | Uint8Array } | undefined>;
}

export interface SheetJsWorksheet {
  "!ref"?: string;
  "!rows"?: Array<{ hidden?: boolean; hpt?: number } | undefined>;
  "!cols"?: Array<{ hidden?: boolean; width?: number } | undefined>;
  "!merges"?: Array<{
    s: { r: number; c: number };
    e: { r: number; c: number };
  }>;
  "!data"?: Array<Array<SheetJsCell | undefined> | undefined>;
}

interface SheetJsCell {
  w?: string;
  v?: unknown;
  t?: string;
  l?: { Target?: string };
}

interface SheetJsFont {
  name?: string;
  sz?: number | string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: SheetColor;
}

interface SheetJsFill {
  patternType?: string;
  fgColor?: SheetColor;
  bgColor?: SheetColor;
}

interface SheetJsCellXf {
  fontId?: number;
  fillId?: number;
  borderId?: number;
  alignment?: CellAlignment;
}

interface CellAlignment {
  horizontal?: string;
  vertical?: string;
  wrapText?: boolean;
}

// A color as SheetJS reads it or as a border's XML attributes give it.
export interface SheetColor {
  rgb?: string;
  theme?: number | string;
  tint?: number | string;
  indexed?: number | string;
}

type BorderSide = "left" | "right" | "top" | "bottom";
type Border = Partial<
  Record<BorderSide, { style: string; color: SheetColor | null }>
>;

export interface CellStyle {
  declarations: Array<[string, string]>;
  alignsHorizontally: boolean;
}

export interface SheetCell {
  text: string;
  kind: string | undefined;
  link: string | null;
}

export interface SheetModel {
  rowCount: number;
  columnCount: number;
  rowHeights: Float64Array;
  columnWidths: Float64Array;
  frozenRows: number;
  frozenColumns: number;
  merges: TrackRange[];
  mergeAt(row: number, column: number): TrackRange | null;
  isCovered(row: number, column: number): boolean;
  styleAt(row: number, column: number): number;
  cellAt(row: number, column: number): SheetCell | null;
}

export interface WorkbookModel {
  sheets: Array<{ name: string; hidden: boolean }>;
  styles: CellStyle[];
  sheet(index: number): SheetModel;
}

interface SheetLayout {
  cellStyles: number[][];
  rowStyles: number[];
  columnStyles: number[];
  frozenRows: number;
  frozenColumns: number;
  defaultRowHeight: number | undefined;
  defaultColumnWidth: number | undefined;
}

const DEFAULT_ROW_HEIGHT_POINTS = 15;
const DEFAULT_COLUMN_PIXELS = 64;
// The widest digit of the default Calibri 11, which Excel's column widths are
// counted in.
const MAX_DIGIT_PIXELS = 7;
const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const BORDER_SIDES: BorderSide[] = ["left", "right", "top", "bottom"];

const BORDER_STYLES: Readonly<Record<string, string>> = {
  hair: "1px solid",
  thin: "1px solid",
  dotted: "1px dotted",
  dashed: "1px dashed",
  dashDot: "1px dashed",
  dashDotDot: "1px dotted",
  slantDashDot: "2px dashed",
  medium: "2px solid",
  mediumDashed: "2px dashed",
  mediumDashDot: "2px dashed",
  mediumDashDotDot: "2px dotted",
  thick: "3px solid",
  double: "3px double",
};

const HORIZONTAL_ALIGNMENT: Readonly<Record<string, string>> = {
  left: "start",
  center: "center",
  centerContinuous: "center",
  right: "end",
  fill: "start",
  justify: "start",
  distributed: "center",
};

const VERTICAL_ALIGNMENT: Readonly<Record<string, string>> = {
  top: "start",
  center: "center",
  justify: "start",
  distributed: "center",
  bottom: "end",
};

export function readWorkbook(XLSX: SheetJs, bytes: Uint8Array): WorkbookModel {
  const workbook = XLSX.read(bytes, {
    type: "array",
    dense: true,
    cellStyles: true,
    cellNF: true,
    cellDates: true,
    bookFiles: true,
  });
  const styles = readStyles(workbook);
  const sheetPaths = sheetXmlPaths(workbook);
  const sheets = workbook.SheetNames.map((name, index) => ({
    name,
    hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
  }));
  const models = new Map<number, SheetModel>();
  return {
    sheets,
    styles,
    sheet(index) {
      let model = models.get(index);
      if (!model) {
        model = readSheet(
          workbook.Sheets[workbook.SheetNames[index]],
          fileText(workbook, sheetPaths[index]),
        );
        models.set(index, model);
      }
      return model;
    },
  };
}

export function readSheet(
  worksheet: SheetJsWorksheet | undefined,
  xml: string,
): SheetModel {
  const layout = readSheetXml(xml);
  const range = usedRange(worksheet?.["!ref"]);
  const rowCount = range.rows;
  const columnCount = range.columns;
  const defaultRowPixels = pointsToPixels(
    layout.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_POINTS,
  );
  const defaultColumnPixels =
    layout.defaultColumnWidth === undefined
      ? DEFAULT_COLUMN_PIXELS
      : widthToPixels(layout.defaultColumnWidth);

  const rowHeights = new Float64Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    const info = worksheet?.["!rows"]?.[row];
    rowHeights[row] = info?.hidden
      ? 0
      : info?.hpt === undefined
        ? defaultRowPixels
        : pointsToPixels(info.hpt);
  }
  const columnWidths = new Float64Array(columnCount);
  for (let column = 0; column < columnCount; column += 1) {
    const info = worksheet?.["!cols"]?.[column];
    columnWidths[column] = info?.hidden
      ? 0
      : info?.width === undefined
        ? defaultColumnPixels
        : widthToPixels(info.width);
  }

  // A merge can run past the cells in use, as far as a whole column; only the
  // part inside them is ever drawn.
  const merges = (worksheet?.["!merges"] ?? [])
    .filter(({ s }) => s.r < rowCount && s.c < columnCount)
    .map(({ s, e }) => ({
      top: s.r,
      left: s.c,
      bottom: Math.min(e.r, rowCount - 1),
      right: Math.min(e.c, columnCount - 1),
    }));
  const mergeByOrigin = new Map<string, TrackRange>();
  const covered = new Set<string>();
  for (const merge of merges) {
    mergeByOrigin.set(cellKey(merge.top, merge.left), merge);
    for (let row = merge.top; row <= merge.bottom; row += 1) {
      for (let column = merge.left; column <= merge.right; column += 1) {
        if (row !== merge.top || column !== merge.left) {
          covered.add(cellKey(row, column));
        }
      }
    }
  }

  const data = worksheet?.["!data"] ?? [];
  return {
    rowCount,
    columnCount,
    rowHeights,
    columnWidths,
    frozenRows: Math.min(layout.frozenRows, rowCount),
    frozenColumns: Math.min(layout.frozenColumns, columnCount),
    merges,
    mergeAt: (row, column) => mergeByOrigin.get(cellKey(row, column)) ?? null,
    isCovered: (row, column) => covered.has(cellKey(row, column)),
    styleAt: (row, column) =>
      layout.cellStyles[row]?.[column] ??
      layout.rowStyles[row] ??
      layout.columnStyles[column] ??
      0,
    cellAt: (row, column) => describeCell(data[row]?.[column]),
  };
}

// The style table: every cell style ("xf") becomes the CSS declarations that
// draw it. Borders come from the stylesheet XML because SheetJS leaves them
// empty.
export function readStyles(workbook: SheetJsWorkbook): CellStyle[] {
  const palette = workbook.Themes?.themeElements?.clrScheme ?? [];
  const borders = readBorders(fileText(workbook, workbook.Directory?.style));
  const { Fonts = [], Fills = [], CellXf = [] } = workbook.Styles ?? {};
  return CellXf.map((xf) =>
    styleDeclarations({
      font: Fonts[xf.fontId ?? 0],
      fill: Fills[xf.fillId ?? 0],
      border: borders[xf.borderId ?? 0],
      alignment: xf.alignment,
      palette,
    }),
  );
}

export function readSheetXml(xml = ""): SheetLayout {
  const layout: SheetLayout = {
    cellStyles: [],
    rowStyles: [],
    columnStyles: [],
    frozenRows: 0,
    frozenColumns: 0,
    defaultRowHeight: undefined,
    defaultColumnWidth: undefined,
  };
  const tag = /<(c|row|col|pane|sheetFormatPr)\b([^>]*)>/g;
  for (const [, name, attributeText] of xml.matchAll(tag)) {
    const attributes = readAttributes(attributeText);
    if (name === "c") {
      if (attributes.s !== undefined && attributes.r) {
        const { row, column } = decodeAddress(attributes.r);
        layout.cellStyles[row] ??= [];
        layout.cellStyles[row][column] = Number(attributes.s);
      }
    } else if (name === "row") {
      if (attributes.customFormat === "1" && attributes.s !== undefined) {
        layout.rowStyles[Number(attributes.r) - 1] = Number(attributes.s);
      }
    } else if (name === "col") {
      if (attributes.style !== undefined) {
        for (
          let column = Number(attributes.min) - 1;
          column < Number(attributes.max);
          column += 1
        ) {
          layout.columnStyles[column] = Number(attributes.style);
        }
      }
    } else if (name === "pane") {
      if (attributes.state === "frozen" || attributes.state === "frozenSplit") {
        layout.frozenRows = Number(attributes.ySplit ?? 0);
        layout.frozenColumns = Number(attributes.xSplit ?? 0);
      }
    } else if (
      attributes.defaultRowHeight !== undefined ||
      attributes.defaultColWidth !== undefined
    ) {
      layout.defaultRowHeight = optionalNumber(attributes.defaultRowHeight);
      layout.defaultColumnWidth = optionalNumber(attributes.defaultColWidth);
    }
  }
  return layout;
}

export function readBorders(xml = ""): Border[] {
  const section = xml.match(/<borders\b[^>]*>([\s\S]*?)<\/borders>/)?.[1] ?? "";
  const borders: Border[] = [];
  for (const [, body = ""] of section.matchAll(
    /<border\b[^>]*?(?:\/>|>([\s\S]*?)<\/border>)/g,
  )) {
    const border: Border = {};
    for (const side of BORDER_SIDES) {
      const match = body.match(
        new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`),
      );
      const style = match && readAttributes(match[1]).style;
      if (match && style) {
        const color = match[2]?.match(/<color\b([^>]*?)\/?>/)?.[1];
        border[side] = { style, color: color ? readAttributes(color) : null };
      }
    }
    borders.push(border);
  }
  return borders;
}

function styleDeclarations({
  font,
  fill,
  border,
  alignment,
  palette,
}: {
  font: SheetJsFont | undefined;
  fill: SheetJsFill | undefined;
  border: Border | undefined;
  alignment: CellAlignment | undefined;
  palette: Array<{ rgb?: string }>;
}): CellStyle {
  const declarations: Array<[string, string]> = [];
  if (font) {
    if (font.name) {
      declarations.push([
        "font-family",
        `"${font.name.replace(/["\\]/g, "")}", sans-serif`,
      ]);
    }
    if (font.sz) {
      declarations.push(["font-size", `${Number(font.sz)}pt`]);
    }
    if (font.bold) {
      declarations.push(["font-weight", "700"]);
    }
    if (font.italic) {
      declarations.push(["font-style", "italic"]);
    }
    const decorations = [
      font.underline ? "underline" : "",
      font.strike ? "line-through" : "",
    ].filter(Boolean);
    if (decorations.length) {
      declarations.push(["text-decoration", decorations.join(" ")]);
    }
    const color = colorValue(font.color, palette);
    if (color) {
      declarations.push(["color", color]);
    }
  }
  if (fill?.patternType && fill.patternType !== "none") {
    const color =
      colorValue(fill.fgColor, palette) ?? colorValue(fill.bgColor, palette);
    if (color) {
      declarations.push(["background-color", color]);
    }
  }
  for (const side of BORDER_SIDES) {
    const edge = border?.[side];
    const pattern = edge && BORDER_STYLES[edge.style];
    if (edge && pattern) {
      const color = colorValue(edge.color, palette) ?? "#000000";
      declarations.push([`border-${side}`, `${pattern} ${color}`]);
    }
  }
  const horizontal = alignment?.horizontal
    ? HORIZONTAL_ALIGNMENT[alignment.horizontal]
    : undefined;
  if (horizontal) {
    declarations.push(
      ["justify-content", horizontal],
      ["text-align", horizontal],
    );
  }
  const vertical = alignment?.vertical
    ? VERTICAL_ALIGNMENT[alignment.vertical]
    : undefined;
  if (vertical) {
    declarations.push(["align-items", vertical]);
  }
  if (alignment?.wrapText) {
    declarations.push(["white-space", "pre-wrap"]);
  }
  return {
    declarations,
    alignsHorizontally: Boolean(horizontal),
  };
}

// A theme color is an index into the workbook's palette, lightened or
// darkened by its tint; an indexed color is the legacy palette, of which only
// black and white still appear in practice.
export function colorValue(
  color: SheetColor | null | undefined,
  palette: Array<{ rgb?: string }> = [],
) {
  if (!color) {
    return null;
  }
  const rgb =
    color.rgb ??
    (color.theme !== undefined
      ? palette[Number(color.theme)]?.rgb
      : undefined) ??
    (color.indexed !== undefined ? INDEXED_COLORS[color.indexed] : undefined);
  if (!rgb || !/^[0-9a-f]{6,8}$/i.test(rgb)) {
    return null;
  }
  const hex = rgb.slice(-6).toUpperCase();
  const tint = Number(color.tint ?? 0);
  return `#${tint && color.rgb === undefined ? tintHex(hex, tint) : hex}`;
}

const INDEXED_COLORS: Readonly<Record<string, string>> = {
  8: "000000",
  9: "FFFFFF",
  64: "000000",
};

function tintHex(hex: string, tint: number) {
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  const scale = (value: number) =>
    Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint);
  return [red, green, blue]
    .map((value) => scale(value).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function describeCell(cell: SheetJsCell | undefined): SheetCell | null {
  if (!cell) {
    return null;
  }
  const text = `${cell.w ?? cell.v ?? ""}`;
  const target = `${cell.l?.Target ?? ""}`.trim();
  return {
    text,
    kind: cell.t,
    link: isExternalLink(target) ? target : null,
  };
}

function isExternalLink(value: string) {
  try {
    return EXTERNAL_LINK_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function sheetXmlPaths(workbook: SheetJsWorkbook) {
  const relationships = new Map<string, string>();
  const xml = fileText(workbook, "xl/_rels/workbook.xml.rels");
  for (const [, attributeText] of xml.matchAll(
    /<Relationship\b([^>]*?)\/?>/g,
  )) {
    const { Id, Target } = readAttributes(attributeText);
    if (Id && Target) {
      relationships.set(
        Id,
        Target.startsWith("/") ? Target.slice(1) : `xl/${Target}`,
      );
    }
  }
  return workbook.SheetNames.map((_, index) => {
    const id = workbook.Workbook?.Sheets?.[index]?.id;
    return (
      (id ? relationships.get(id) : undefined) ??
      workbook.Directory?.sheets?.[index]?.replace(/^\//, "")
    );
  });
}

function fileText(workbook: SheetJsWorkbook, path: string | undefined) {
  const entry = path ? workbook.files?.[path.replace(/^\//, "")] : null;
  const content = entry?.content;
  if (typeof content === "string") {
    return content;
  }
  return content ? new TextDecoder().decode(content) : "";
}

function usedRange(reference: string | undefined) {
  const end = `${reference ?? "A1"}`.split(":").pop() ?? "A1";
  const { row, column } = decodeAddress(end);
  return { rows: row + 1, columns: column + 1 };
}

export function decodeAddress(address: string) {
  let column = 0;
  let index = 0;
  while (index < address.length) {
    const code = address.charCodeAt(index);
    if (code < 65 || code > 90) {
      break;
    }
    column = column * 26 + (code - 64);
    index += 1;
  }
  return {
    row: Math.max(Number.parseInt(address.slice(index), 10) - 1, 0) || 0,
    column: Math.max(column - 1, 0),
  };
}

function readAttributes(text = ""): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of text.matchAll(/([\w:]+)="([^"]*)"/g)) {
    attributes[name] = value;
  }
  return attributes;
}

function optionalNumber(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
}

function pointsToPixels(points: number) {
  return (Number(points) * 96) / 72;
}

// Excel stores a column width in characters of its widest digit, padding
// included.
function widthToPixels(width: number) {
  return Math.trunc(
    ((256 * Number(width) + Math.trunc(128 / MAX_DIGIT_PIXELS)) / 256) *
      MAX_DIGIT_PIXELS,
  );
}

function cellKey(row: number, column: number) {
  return `${row}:${column}`;
}
