// The cells a held finger selects: the word under it, and the stretch from
// that word to wherever the finger moves. A word ends where a desktop
// double-click ends it, at the terminal's word separators and at blank cells,
// and carries on across a row the terminal wrapped. Positions count the cells
// of the whole buffer, history included, so a wide character such as a Hangul
// syllable spans two.

// The parts of an xterm.js buffer the ranges read.
export interface CellBuffer {
  getLine(y: number): CellLine | undefined;
}

export interface CellLine {
  readonly isWrapped: boolean;
  getCell(x: number): Cell | undefined;
}

export interface Cell {
  getChars(): string;
  getWidth(): number;
}

export interface CellPoint {
  x: number;
  y: number;
}

// A run of cells in reading order, in the form xterm.js's `select()` takes.
export interface CellRange {
  x: number;
  y: number;
  length: number;
}

/**
 * The word at `point`. A separator or blank cell is a range of its own, so a
 * finger held there still has something to stretch from.
 */
export function wordAt(
  buffer: CellBuffer,
  cols: number,
  point: CellPoint,
  separators: string,
): CellRange {
  const cells = new Cells(buffer, cols, separators);
  let start = cells.base(point.y * cols + point.x);
  if (!cells.inWord(start)) {
    return cells.range(start, start + cells.width(start));
  }
  let end = start;
  while (cells.joined(start, -1) && cells.inWord(start - 1)) {
    start -= 1;
  }
  while (cells.joined(end, 1) && cells.inWord(end + 1)) {
    end += 1;
  }
  return cells.range(start, end + 1);
}

/**
 * The selection from `word` to the cell at `point`, whichever side of the word
 * that cell lies on. The word itself always stays inside.
 */
export function stretchFromWord(
  buffer: CellBuffer,
  cols: number,
  word: CellRange,
  point: CellPoint,
): CellRange {
  const cells = new Cells(buffer, cols, "");
  const wordStart = word.y * cols + word.x;
  const at = cells.base(point.y * cols + point.x);
  return cells.range(
    Math.min(wordStart, at),
    Math.max(wordStart + word.length, at + cells.width(at)),
  );
}

// Cells by their index across the whole buffer, `y * cols + x`.
class Cells {
  constructor(
    private readonly buffer: CellBuffer,
    private readonly cols: number,
    private readonly separators: string,
  ) {}

  // The second cell of a wide character belongs to the first.
  base(index: number) {
    return this.cell(index)?.getWidth() === 0 ? index - 1 : index;
  }

  width(index: number) {
    return Math.max(1, this.cell(index)?.getWidth() ?? 1);
  }

  inWord(index: number): boolean {
    const cell = this.cell(index);
    if (!cell) {
      return false;
    }
    if (cell.getWidth() === 0) {
      return this.inWord(index - 1);
    }
    const chars = cell.getChars();
    return chars !== "" && chars !== " " && !this.separators.includes(chars);
  }

  // Whether the cell one step in `direction` continues the same line: on the
  // same row, or across the start of a row the terminal wrapped.
  joined(index: number, direction: -1 | 1) {
    const x = index % this.cols;
    const y = Math.floor(index / this.cols);
    if (direction < 0) {
      return x > 0 || Boolean(y > 0 && this.buffer.getLine(y)?.isWrapped);
    }
    return x < this.cols - 1 || Boolean(this.buffer.getLine(y + 1)?.isWrapped);
  }

  range(start: number, end: number): CellRange {
    return {
      x: start % this.cols,
      y: Math.floor(start / this.cols),
      length: end - start,
    };
  }

  private cell(index: number) {
    if (index < 0) {
      return undefined;
    }
    return this.buffer
      .getLine(Math.floor(index / this.cols))
      ?.getCell(index % this.cols);
  }
}
